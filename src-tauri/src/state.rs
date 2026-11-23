//! Process-wide state: one session per context, the registry of running streams, and one slot
//! per feature module (`ext`).
use std::{
    any::{Any, TypeId},
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use crate::{
    exec::ExecHandle,
    forward::ForwardEntry,
    ipc::{BackendError, Result},
    session::Session,
};

/// Upper bound for building a session. Generous: an exec credential plugin may wait for a browser login.
const BUILD_TIMEOUT: Duration = Duration::from_secs(300);

/// Build result of one context, shared by every caller that asked while it was being built.
type SessionCell = Arc<OnceCell<Result<Arc<Session>>>>;

#[derive(Clone, Default)]
pub struct AppState(Arc<Inner>);

#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<String, SessionCell>>,
    streams: Mutex<HashMap<String, CancellationToken>>,
    /// Input side of running exec sessions, keyed by their stream id.
    execs: Mutex<HashMap<String, ExecHandle>>,
    forwards: Mutex<HashMap<String, ForwardEntry>>,
    next_id: AtomicU64,
    /// Set once in `setup`; absent in tests and examples (events then go nowhere).
    app: OnceLock<tauri::AppHandle>,
    /// One value per feature state type (proposals, ctxflags, ui state, dev sets, traps, MCP ...).
    ext: Mutex<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>,
}

/// Locks a std mutex, recovering the data if a holder panicked.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    /// Session for a context, built from the kubeconfig on first use. Concurrent first calls share
    /// one build (credential plugins run once); a failed build is reported to all of them and
    /// then forgotten, so the next call tries again.
    pub async fn session(&self, context: &str) -> Result<Arc<Session>> {
        // Unit tests never read the developer's kubeconfig or reach a real cluster.
        if cfg!(test) {
            return Err(BackendError::config(format!("context \"{context}\": tests never build a cluster session")));
        }
        let cell = lock(&self.0.sessions).entry(context.to_string()).or_default().clone();
        // Built outside the map lock: a slow credential plugin must not stall the other contexts.
        let built = cell
            .get_or_init(|| async {
                match tokio::time::timeout(BUILD_TIMEOUT, Session::build(context)).await {
                    Ok(session) => session.map(Arc::new),
                    Err(_) => Err(BackendError::config(format!("context \"{context}\": building the client timed out"))),
                }
            })
            .await
            .clone();
        if built.is_err() {
            self.forget(context, |c| Arc::ptr_eq(c, &cell));
        }
        built
    }

    /// True when a session for `context` is already built and healthy. Never builds one (no
    /// kubeconfig read, no credential plugin): agent calls use this to stay on connected contexts.
    pub fn has_session(&self, context: &str) -> bool {
        lock(&self.0.sessions).get(context).is_some_and(|c| matches!(c.get(), Some(Ok(_))))
    }

    /// Forgets `session` so the next use re-reads the kubeconfig (running streams keep their client).
    /// A newer session of the same context is left alone.
    pub fn drop_session(&self, session: &Arc<Session>) {
        self.forget(&session.context, |c| matches!(c.get(), Some(Ok(s)) if Arc::ptr_eq(s, session)));
    }

    fn forget(&self, context: &str, is_it: impl Fn(&SessionCell) -> bool) {
        let mut sessions = lock(&self.0.sessions);
        if sessions.get(context).is_some_and(is_it) {
            sessions.remove(context);
        }
    }

    /// Unique id for streams, forwards and other handles: `<prefix><n>`.
    pub fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}{}", self.0.next_id.fetch_add(1, Ordering::Relaxed) + 1)
    }

    /// Registers a cancellable stream. The task that runs it must own the returned handle:
    /// dropping it removes the id from the registry.
    pub fn register_stream(&self) -> StreamHandle {
        let id = self.next_id("s");
        let cancel = CancellationToken::new();
        lock(&self.0.streams).insert(id.clone(), cancel.clone());
        StreamHandle { id, cancel, state: self.clone() }
    }

    /// Cancels a table/log/exec stream. Returns false for an unknown (or already finished) id.
    pub fn stop_stream(&self, id: &str) -> bool {
        match lock(&self.0.streams).remove(id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Cancels every table/log/exec stream and returns how many there were. Called when the page
    /// (re)loads: the old page's channels are gone, but sending to them still "succeeds", so the
    /// streams would never notice. Port-forwards stay; the new page finds them with `list_forwards`.
    pub fn stop_all_streams(&self) -> usize {
        let streams = std::mem::take(&mut *lock(&self.0.streams));
        streams.values().for_each(CancellationToken::cancel);
        streams.len()
    }

    pub fn stream_count(&self) -> usize {
        lock(&self.0.streams).len()
    }

    pub(crate) fn execs(&self) -> MutexGuard<'_, HashMap<String, ExecHandle>> {
        lock(&self.0.execs)
    }

    pub(crate) fn forwards(&self) -> MutexGuard<'_, HashMap<String, ForwardEntry>> {
        lock(&self.0.forwards)
    }

    /// Remembers the app handle (first call wins). Called from the Tauri `setup` hook.
    pub fn set_app(&self, app: tauri::AppHandle) {
        let _ = self.0.app.set(app);
    }

    pub fn app(&self) -> Option<&tauri::AppHandle> {
        self.0.app.get()
    }

    /// The process-wide value of a feature state type, created with `Default` on first use.
    /// Each feature module keeps its state in its own type, so `AppState` needs no field per
    /// feature (docs/plan-features.md §2.2):
    ///
    /// ```ignore
    /// #[derive(Default)] struct DevSets { sets: Mutex<Vec<DevSet>> }
    /// let sets = state.ext::<DevSets>();
    /// ```
    pub fn ext<T: Any + Send + Sync + Default>(&self) -> Arc<T> {
        let mut map = lock(&self.0.ext);
        let slot = map.entry(TypeId::of::<T>()).or_insert_with(|| Arc::new(T::default()));
        // the key is the TypeId of the stored value, so the downcast cannot fail
        slot.clone().downcast::<T>().expect("ext slot holds its own type")
    }
}

/// A registered stream: its id and the token `stop_stream` cancels.
pub struct StreamHandle {
    pub id: String,
    pub cancel: CancellationToken,
    state: AppState,
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
        lock(&self.state.0.streams).remove(&self.id);
    }
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::Result;

    #[tauri::command]
    pub fn stop_stream(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
        state.stop_stream(&id);
        Ok(())
    }
}
