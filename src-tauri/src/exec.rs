//! `exec_start` / `exec_write` / `exec_resize`: a process in a container (exec or attach).
//!
//! The session id is a stream id, so `stop_stream(id)` closes it. The input side (stdin, terminal
//! size) lives in `AppState::execs` under the same id for as long as the session runs.
use std::{
    future::pending,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use base64::Engine;
use futures::SinkExt;
use k8s_openapi::{api::core::v1::Pod, apimachinery::pkg::apis::meta::v1::Status};
use kube::api::{Api, AttachParams, AttachedProcess, TerminalSize};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, watch},
    time::{Instant, sleep, sleep_until, timeout},
};
use tokio_util::sync::CancellationToken;

use crate::{
    ipc::{BackendError, ExecEvent, ExecQuery, Result, Sink, chain},
    session::timed,
    state::AppState,
};

/// Output is batched for at most this long (one frame) before it is sent on.
const FLUSH_EVERY: Duration = Duration::from_millis(16);
const FLUSH_BYTES: usize = 64 * 1024;
/// kube-rs pipes default to 1 KiB, which throttles output to one small read per wakeup.
const PIPE: usize = 64 * 1024;
/// How long a stopped session may take to end by itself before its connection is dropped.
const STOP_GRACE: Duration = Duration::from_secs(2);
/// Input waiting for a process that does not read it; `exec_write` refuses more beyond this.
const MAX_STDIN_QUEUE: usize = 1024 * 1024;
/// Ctrl-C, Ctrl-D: ends the foreground job, then the shell.
const HANG_UP: &[u8] = b"\x03\x04";
const HANG_UP_PAUSE: Duration = Duration::from_millis(200);
const SHELL: &str = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";

/// Input side of a running session.
pub struct ExecHandle {
    stdin: mpsc::UnboundedSender<Vec<u8>>,
    /// Bytes sent to `stdin` that the process has not taken yet.
    queued: Arc<AtomicUsize>,
    /// Latest terminal size (cols, rows); `None` without a TTY.
    size: Option<watch::Sender<(u16, u16)>>,
}

/// What the session's task needs to feed stdin.
struct Input {
    rx: mpsc::UnboundedReceiver<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    /// Send `HANG_UP` when the session is stopped.
    hang_up: bool,
}

/// Removes the session's input handle when its task ends, whichever way.
struct Unregister(AppState, String);

impl Drop for Unregister {
    fn drop(&mut self) {
        self.0.execs().remove(&self.1);
    }
}

/// Opens the session and returns its id; a failure to start is returned, later ones are events.
pub async fn exec_start(state: &AppState, query: ExecQuery, sink: impl Sink<ExecEvent>) -> Result<String> {
    let session = state.session(&query.context).await?;
    let pods: Api<Pod> = Api::namespaced(session.client.clone(), &query.namespace);
    let params = AttachParams {
        container: query.container.clone().filter(|c| !c.is_empty()),
        stdin: true,
        stdout: true,
        // A TTY has a single output stream.
        stderr: !query.tty,
        tty: query.tty,
        max_stdin_buf_size: Some(PIPE),
        max_stdout_buf_size: Some(PIPE),
        max_stderr_buf_size: Some(PIPE),
    };
    let process = if query.attach.unwrap_or(false) {
        timed(pods.attach(&query.pod, &params)).await?
    } else {
        let command = if query.command.is_empty() {
            vec!["sh".to_string(), "-c".to_string(), SHELL.to_string()]
        } else {
            query.command.clone()
        };
        timed(pods.exec(&query.pod, command, &params)).await?
    };

    let handle = state.register_stream();
    let id = handle.id.clone();
    let (stdin_tx, stdin_rx) = mpsc::unbounded_channel();
    let (size_tx, size_rx) = watch::channel((query.cols, query.rows));
    let queued = Arc::new(AtomicUsize::new(0));
    let handle_in = ExecHandle { stdin: stdin_tx, queued: queued.clone(), size: query.tty.then_some(size_tx) };
    state.execs().insert(id.clone(), handle_in);
    // A stopped exec on a TTY is told to quit (see `run`). Never an attach: that is the container's own process.
    let hang_up = query.tty && !query.attach.unwrap_or(false);
    let input = Input { rx: stdin_rx, queued, hang_up };
    let unregister = Unregister(state.clone(), id.clone());
    tokio::spawn(async move {
        let _unregister = unregister;
        run(process, sink, input, size_rx, handle.cancel.clone()).await;
        drop(handle);
    });
    Ok(id)
}

/// Queues UTF-8 input for the session's stdin. Like `exec_resize` this never waits: the commands
/// are synchronous so Tauri runs them in the order the webview sent them (async commands are
/// spawned and could overtake each other).
pub fn exec_write(state: &AppState, id: &str, data: &str) -> Result<()> {
    let (stdin, queued) = state.execs().get(id).map(|h| (h.stdin.clone(), h.queued.clone())).ok_or_else(|| gone(id))?;
    // The process stopped reading: refuse instead of buffering without bound.
    if queued.load(Ordering::Relaxed) >= MAX_STDIN_QUEUE {
        return Err(BackendError::new(0, "Busy", format!("exec session {id} is not reading its input")));
    }
    queued.fetch_add(data.len(), Ordering::Relaxed);
    stdin.send(data.as_bytes().to_vec()).map_err(|_| gone(id))
}

/// Sets the terminal size; a no-op for sessions without a TTY.
pub fn exec_resize(state: &AppState, id: &str, cols: u16, rows: u16) -> Result<()> {
    match state.execs().get(id) {
        Some(handle) => {
            if let Some(size) = &handle.size {
                size.send_replace((cols, rows));
            }
            Ok(())
        }
        None => Err(gone(id)),
    }
}

fn gone(id: &str) -> BackendError {
    BackendError::new(0, "NotFound", format!("exec session {id} is not running"))
}

async fn run(
    mut process: AttachedProcess,
    sink: impl Sink<ExecEvent>,
    input: Input,
    mut size_rx: watch::Receiver<(u16, u16)>,
    cancel: CancellationToken,
) {
    let Input { rx: mut stdin_rx, queued, hang_up } = input;
    let (stdin, mut stdout, mut stderr) = (process.stdin(), process.stdout(), process.stderr());
    let status = process.take_status();
    let resizer = process.terminal_size();
    // Once stopped (or the receiver is gone) nothing more is delivered, but the output is still
    // drained so the remote end can finish.
    let deliver = |event: ExecEvent| {
        if !cancel.is_cancelled() && !sink.send(event) {
            cancel.cancel();
        }
    };

    // Stdin and resize run beside the output loop: the kube-rs message loop stalls while an output
    // pipe is full, so a write to stdin must never keep the output from being read.
    // Neither future finishes. The stdin writer stays open until the session is stopped, because
    // dropping it signals EOF.
    let input = async {
        let mut stdin = stdin;
        loop {
            let bytes = tokio::select! {
                _ = cancel.cancelled() => break,
                b = stdin_rx.recv() => match b {
                    Some(bytes) => bytes,
                    None => break,
                },
            };
            if let Some(w) = stdin.as_mut()
                && (w.write_all(&bytes).await.is_err() || w.flush().await.is_err())
            {
                // The process no longer reads: discard input instead of blocking the writers.
                stdin = None;
            }
            queued.fetch_sub(bytes.len(), Ordering::Relaxed);
        }
        // Stopped: later writes fail, and stdin EOF lets a process that reads it finish. A pty has no
        // EOF (observed on k3s/containerd: a shell on a pipe exits, a shell on a TTY is left running in
        // the container), so a TTY gets the keys that end it instead. Best effort: a full-screen
        // program that ignores them stays behind.
        stdin_rx.close();
        if let Some(mut w) = stdin {
            if hang_up {
                // One key at a time: the interrupt makes the terminal discard input that is already queued.
                for key in HANG_UP {
                    let _ = w.write_all(&[*key]).await;
                    let _ = w.flush().await;
                    sleep(HANG_UP_PAUSE).await;
                }
            }
            // Dropping the pipe is not enough: only a shutdown reaches the remote side as EOF.
            let _ = w.shutdown().await;
        }
        pending::<()>().await
    };
    let resize = async {
        if let Some(mut resizer) = resizer {
            loop {
                let (width, height) = *size_rx.borrow_and_update();
                if width > 0 && height > 0 && resizer.send(TerminalSize { width, height }).await.is_err() {
                    break;
                }
                if size_rx.changed().await.is_err() {
                    break;
                }
            }
        }
        pending::<()>().await
    };

    let output = async {
        let mut batch: Vec<u8> = Vec::new();
        let mut flush_at: Option<Instant> = None;
        let mut flushed: Option<Instant> = None;
        let flush = |batch: &mut Vec<u8>, flush_at: &mut Option<Instant>, flushed: &mut Option<Instant>| {
            *flush_at = None;
            if !batch.is_empty() {
                *flushed = Some(Instant::now());
                deliver(ExecEvent::Data { b64: base64::engine::general_purpose::STANDARD.encode(&*batch) });
                batch.clear();
            }
        };
        let (mut out_buf, mut err_buf) = (vec![0u8; 16 * 1024], vec![0u8; 16 * 1024]);
        // Stdout and stderr are read together and merged in arrival order.
        while stdout.is_some() || stderr.is_some() {
            tokio::select! {
                _ = async { sleep_until(flush_at.unwrap_or_else(Instant::now)).await }, if flush_at.is_some() => {
                    flush(&mut batch, &mut flush_at, &mut flushed);
                }
                n = read(&mut stdout, &mut out_buf) => batch.extend_from_slice(&out_buf[..n]),
                n = read(&mut stderr, &mut err_buf) => batch.extend_from_slice(&err_buf[..n]),
            }
            // Leading edge: output after a quiet spell (a keystroke's echo) goes out at once; a
            // stream of output goes out at most every `FLUSH_EVERY` (or at `FLUSH_BYTES`).
            let due = flushed.map(|at| at + FLUSH_EVERY);
            if batch.len() >= FLUSH_BYTES || (!batch.is_empty() && due.is_none_or(|due| due <= Instant::now())) {
                flush(&mut batch, &mut flush_at, &mut flushed);
            } else if !batch.is_empty() && flush_at.is_none() {
                flush_at = due;
            }
        }
        flush(&mut batch, &mut flush_at, &mut flushed);
        // Both streams are closed: the status is either already there or will never come.
        let status = match status {
            Some(s) => timeout(Duration::from_secs(5), s).await.ok().flatten(),
            None => None,
        };
        deliver(match status {
            Some(status) => exit_event(status),
            None => match timeout(Duration::from_secs(5), process.join()).await {
                Ok(Err(e)) => ExecEvent::Error { message: chain(&e) },
                _ => ExecEvent::Exit { code: None, message: Some("connection closed".into()) },
            },
        });
    };
    // After a stop the process gets a moment to end on the stdin EOF; then the connection is dropped.
    let stopped = async {
        cancel.cancelled().await;
        sleep(STOP_GRACE).await;
    };

    tokio::select! {
        _ = output => {}
        _ = input => {}
        _ = resize => {}
        _ = stopped => {}
    }
}

/// Reads from an open stream, closing it (`None`) at EOF or on error. Pends while closed.
async fn read<R: AsyncRead + Unpin>(stream: &mut Option<R>, buf: &mut [u8]) -> usize {
    let Some(reader) = stream else { return pending().await };
    match reader.read(buf).await {
        Ok(n) if n > 0 => n,
        _ => {
            *stream = None;
            0
        }
    }
}

/// The remote status: `Success`, or a failure whose exit code is in `details.causes`.
fn exit_event(status: Status) -> ExecEvent {
    if status.status.as_deref() == Some("Success") {
        return ExecEvent::Exit { code: Some(0), message: None };
    }
    let code = status
        .details
        .and_then(|d| d.causes)
        .and_then(|causes| causes.into_iter().find(|c| c.reason.as_deref() == Some("ExitCode")))
        .and_then(|c| c.message?.trim().parse().ok());
    // Without an exit code the message is all there is (e.g. the command could not be started).
    let message = if code.is_none() { status.message.filter(|m| !m.is_empty()) } else { None };
    ExecEvent::Exit { code, message }
}

pub mod cmd {
    use super::AppState;
    use crate::ipc::{ExecEvent, ExecQuery, Result};

    #[tauri::command]
    pub async fn exec_start(
        state: tauri::State<'_, AppState>,
        query: ExecQuery,
        channel: tauri::ipc::Channel<ExecEvent>,
    ) -> Result<String> {
        super::exec_start(&state, query, channel).await
    }

    #[tauri::command]
    pub fn exec_write(state: tauri::State<'_, AppState>, id: String, data: String) -> Result<()> {
        super::exec_write(&state, &id, &data)
    }

    #[tauri::command]
    pub fn exec_resize(state: tauri::State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<()> {
        super::exec_resize(&state, &id, cols, rows)
    }
}
