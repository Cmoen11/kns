//! Pod metric history for sparklines, kept in Rust (§3 C2): one ring per pod (15 s × 240 = 1 h),
//! fed by the existing `podMetrics` path (`metrics::pod_metrics` calls `record`). Nothing samples
//! on its own: while no pods table polls, no sample is taken, and the gap shows as a gap.
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

use crate::{
    ipc::{PodMetric, PodSample, PodSeries},
    state::{AppState, lock},
};

/// Samples kept per pod (15 s × 240 = 1 h).
pub const RING: usize = 240;
/// Two polls closer than this (several panes, all-namespaces plus one namespace) keep one sample.
pub const MIN_GAP_MS: i64 = 10_000;
/// A pod with no sample for this long is forgotten (deleted pods do not pile up).
pub const FORGET_MS: i64 = 60 * 60 * 1000;

type Key = (String, String, String);

#[derive(Default)]
pub struct History {
    rings: Mutex<HashMap<Key, VecDeque<PodSample>>>,
}

impl History {
    /// Adds one sample per pod at `now_ms`; pure apart from the lock (tests call it directly).
    pub fn record(&self, context: &str, metrics: &[PodMetric], now_ms: i64) {
        let mut rings = lock(&self.rings);
        for m in metrics {
            let ring = rings.entry((context.to_string(), m.namespace.clone(), m.name.clone())).or_default();
            if ring.back().is_some_and(|last| now_ms - last.at < MIN_GAP_MS) {
                continue;
            }
            ring.push_back(PodSample { at: now_ms, cpu_milli: m.cpu_milli, mem_bytes: m.mem_bytes });
            while ring.len() > RING {
                ring.pop_front();
            }
        }
        rings.retain(|_, ring| ring.back().is_some_and(|last| now_ms - last.at < FORGET_MS));
    }

    /// Series of one context (and namespace), oldest sample first, sorted by namespace and name.
    pub fn series(&self, context: &str, namespace: Option<&str>) -> Vec<PodSeries> {
        let rings = lock(&self.rings);
        let mut out: Vec<PodSeries> = rings
            .iter()
            .filter(|((c, ns, _), _)| c == context && namespace.is_none_or(|want| want.is_empty() || want == ns))
            .map(|((_, ns, name), ring)| PodSeries { namespace: ns.clone(), name: name.clone(), samples: ring.iter().cloned().collect() })
            .collect();
        out.sort_by(|a, b| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name)));
        out
    }

    /// The samples of one pod (bundles).
    pub fn pod(&self, context: &str, namespace: &str, name: &str) -> Vec<PodSample> {
        lock(&self.rings).get(&(context.to_string(), namespace.to_string(), name.to_string())).map(|r| r.iter().cloned().collect()).unwrap_or_default()
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The sampling hook: called by `metrics::pod_metrics` with what it just read.
pub fn record(state: &AppState, context: &str, metrics: &[PodMetric]) {
    state.ext::<History>().record(context, metrics, now_ms());
}

pub fn pod_samples(state: &AppState, context: &str, namespace: &str, name: &str) -> Vec<PodSample> {
    state.ext::<History>().pod(context, namespace, name)
}

pub mod cmd {
    use crate::{
        ipc::{PodSeries, Result},
        state::AppState,
    };

    #[tauri::command]
    pub async fn pod_metrics_history(state: tauri::State<'_, AppState>, context: String, namespace: Option<String>) -> Result<Vec<PodSeries>> {
        Ok(state.ext::<super::History>().series(&context, namespace.as_deref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(ns: &str, name: &str, cpu: i64) -> PodMetric {
        PodMetric { namespace: ns.into(), name: name.into(), cpu_milli: cpu, mem_bytes: cpu * 1024 }
    }

    #[test]
    fn ring_keeps_the_last_240_samples() {
        let h = History::default();
        for i in 0..300 {
            h.record("c", &[m("ns", "a", i)], i * 15_000);
        }
        let s = h.series("c", None);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].samples.len(), RING);
        assert_eq!(s[0].samples[0].cpu_milli, 60);
        assert_eq!(s[0].samples.last().map(|x| x.cpu_milli), Some(299));
    }

    #[test]
    fn close_polls_keep_one_sample_and_contexts_stay_apart() {
        let h = History::default();
        h.record("c", &[m("ns", "a", 1)], 0);
        h.record("c", &[m("ns", "a", 2)], 3_000);
        h.record("d", &[m("ns", "a", 3)], 3_000);
        assert_eq!(h.pod("c", "ns", "a").len(), 1);
        assert_eq!(h.pod("d", "ns", "a").len(), 1);
        assert!(h.series("c", Some("other")).is_empty());
        assert_eq!(h.series("c", Some("")).len(), 1);
    }

    #[test]
    fn gone_pods_are_forgotten_after_an_hour() {
        let h = History::default();
        h.record("c", &[m("ns", "old", 1)], 0);
        h.record("c", &[m("ns", "new", 1)], FORGET_MS + 1);
        let names: Vec<String> = h.series("c", None).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["new".to_string()]);
    }
}
