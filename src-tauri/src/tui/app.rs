//! The TUI: a stack of views over one socket connection.
//!
//! Views: a live resource table, text (YAML, why, events, secret), logs, port-forwards.
//! Overlays: picker (contexts, namespaces, resources), prompt, confirm, help.
//! Every request carries a `Tag` with the view generation, so a reply for a view the user
//! already left is dropped; leaving a view stops its stream.
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    time::{Duration, Instant},
};

use ratatui::{
    DefaultTerminal, Frame,
    crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Cell, Clear, Paragraph, Row as TRow, Table as TTable, Wrap},
};
use serde_json::{Value, json};

use super::{
    client::{Client, Msg, RpcError, Tag},
    diff::{self, Kind},
    edit::{self, Conflict},
    exec::{self, ExecTarget},
    herdr::{self, Herdr},
    model::{self, Health, Res, Table},
    project::Project,
};

// ───────────────────────── palette ─────────────────────────

const ACCENT: Color = Color::Rgb(217, 119, 87); // kns orange
const DIM: Color = Color::DarkGray;
const OK: Color = Color::Green;
const WARN: Color = Color::Yellow;
const BAD: Color = Color::Red;

fn health_color(h: Health) -> Color {
    match h {
        Health::Ok => Color::Reset,
        Health::Done => DIM,
        Health::Warn => WARN,
        Health::Bad => BAD,
    }
}

// ───────────────────────── start options ─────────────────────────

#[derive(Debug, Clone, Default)]
pub struct Start {
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub resource: Option<String>,
    pub selector: Option<String>,
    /// open straight on the logs of this target (herdr logs pane, `kns-tui logs`)
    pub logs: Option<herdr::Target>,
    /// with `logs`: the previous container's logs (a crash's last words)
    pub previous: bool,
    pub project: Project,
}

// ───────────────────────── views ─────────────────────────

struct TableView {
    res: Res,
    namespace: Option<String>,
    selector: Option<String>,
    field: Option<String>,
    /// shown in the title, e.g. "pods of deploy/web"
    scope: Option<String>,
    table: Table,
    filter: String,
    cursor: usize,
    offset: usize,
    stream: Option<String>,
    epoch: u64,
    /// `ns/name` → (cpu milli, memory bytes, allocatable cpu milli, allocatable bytes); pods and nodes
    metrics: HashMap<String, (i64, i64, i64, i64)>,
    metrics_at: Option<Instant>,
    sort: Sort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sort {
    Name,
    Age,
    Health,
    Cpu,
    Mem,
}

impl Sort {
    fn next(self, metrics: bool) -> Sort {
        match self {
            Sort::Name => Sort::Age,
            Sort::Age => Sort::Health,
            Sort::Health if metrics => Sort::Cpu,
            Sort::Cpu => Sort::Mem,
            _ => Sort::Name,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Sort::Name => "name",
            Sort::Age => "↓newest",
            Sort::Health => "↓problems",
            Sort::Cpu => "↓cpu",
            Sort::Mem => "↓mem",
        }
    }
}

fn metrics_key(namespace: Option<&str>, name: &str) -> String {
    format!("{}/{name}", namespace.unwrap_or_default())
}

impl TableView {
    fn visible(&self) -> Vec<usize> {
        let mut idx: Vec<usize> = (0..self.table.rows.len()).filter(|&i| model::matches(&self.table.rows[i], &self.filter)).collect();
        let rows = &self.table.rows;
        let by_name = |a: usize, b: usize| (rows[a].namespace.as_deref(), rows[a].name.as_str()).cmp(&(rows[b].namespace.as_deref(), rows[b].name.as_str()));
        let metric = |i: usize, cpu: bool| {
            self.metrics.get(&metrics_key(rows[i].namespace.as_deref(), &rows[i].name)).map(|m| if cpu { m.0 } else { m.1 }).unwrap_or(-1)
        };
        match self.sort {
            Sort::Name => idx.sort_by(|&a, &b| by_name(a, b)),
            Sort::Age => idx.sort_by(|&a, &b| rows[b].created.cmp(&rows[a].created).then(by_name(a, b))),
            Sort::Health => idx.sort_by(|&a, &b| model::row_health(&self.table, &rows[b]).cmp(&model::row_health(&self.table, &rows[a])).then(by_name(a, b))),
            Sort::Cpu => idx.sort_by(|&a, &b| metric(b, true).cmp(&metric(a, true)).then(by_name(a, b))),
            Sort::Mem => idx.sort_by(|&a, &b| metric(b, false).cmp(&metric(a, false)).then(by_name(a, b))),
        }
        idx
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    /// `e` on a row: one object, diffed against the server version it started from
    Edit,
    /// `:apply <file>`, `:apply`, `:new`: any documents, diffed against the cluster after the dry run
    Apply,
}

enum Dry {
    Running,
    Ok,
    Failed(String),
}

/// What will change: the diff, the server's dry run, then apply.
struct ReviewView {
    title: String,
    label: String,
    source: Source,
    /// the edited object
    target: Option<Value>,
    context: String,
    /// the server version the edit started from (empty for `:apply`)
    original: String,
    /// what will be applied
    buffer: String,
    diff: Vec<(Kind, String)>,
    /// show the whole manifest instead of the diff
    full: bool,
    dry: Dry,
    warnings: Vec<String>,
    conflict: Option<Conflict>,
    /// Flux or Argo CD will put its own version back
    owner: Option<String>,
    scroll: usize,
    epoch: u64,
}

struct RevisionsView {
    label: String,
    target: Value,
    deployment: bool,
    list: Vec<Value>,
    cursor: usize,
    loading: bool,
    epoch: u64,
}

struct TextView {
    title: String,
    lines: Vec<Line<'static>>,
    scroll: usize,
    epoch: u64,
}

struct LogLine {
    pod: String,
    container: String,
    text: String,
    level: Option<String>,
}

struct LogsView {
    title: String,
    context: String,
    lines: VecDeque<LogLine>,
    follow: bool,
    scroll: usize,
    wrap: bool,
    filter: String,
    stream: Option<String>,
    multi: bool,
    ended: usize,
    targets: usize,
    epoch: u64,
}

struct ForwardsView {
    list: Vec<Value>,
    cursor: usize,
    epoch: u64,
}

#[allow(clippy::large_enum_variant)] // a handful of views on a stack
enum View {
    Table(TableView),
    Text(TextView),
    Logs(LogsView),
    Forwards(ForwardsView),
    Review(ReviewView),
    Revisions(RevisionsView),
}

impl View {
    fn epoch(&self) -> u64 {
        match self {
            View::Table(v) => v.epoch,
            View::Text(v) => v.epoch,
            View::Logs(v) => v.epoch,
            View::Forwards(v) => v.epoch,
            View::Review(v) => v.epoch,
            View::Revisions(v) => v.epoch,
        }
    }
    fn stream(&self) -> Option<&String> {
        match self {
            View::Table(v) => v.stream.as_ref(),
            View::Logs(v) => v.stream.as_ref(),
            _ => None,
        }
    }
}

#[derive(Clone)]
enum PickKind {
    Context,
    Namespace,
    Resource,
}

enum Pending {
    Delete { obj: Value, label: String },
    Restart { obj: Value, label: String },
    Scale { obj: Value, label: String },
    Forward { target: Value, label: String },
    Trigger { obj: Value, label: String },
    /// `(container, image)` by index under `base` (`/spec/template/spec`, …)
    SetImage { obj: Value, label: String, base: String, containers: Vec<(String, String)> },
    ForceApply,
    DiscardReview,
    SaveManifest { text: String },
    Rollback { obj: Value, label: String, revision: i64, template: Value },
}

enum Overlay {
    None,
    Picker { kind: PickKind, items: Vec<String>, filter: String, cursor: usize },
    Prompt { label: String, input: String, then: Pending },
    Confirm { text: String, then: Pending },
    /// the server wants the protected context's name typed
    Protected { context: String, input: String, method: String, params: Value },
    Help,
}

enum Input {
    None,
    Command(String),
    Filter(String),
}

// ───────────────────────── app ─────────────────────────

pub struct App {
    client: Client,
    rx: Receiver<Msg>,
    herdr: Option<Herdr>,
    context: String,
    contexts: Vec<String>,
    server: String,
    resources: Vec<Res>,
    stack: Vec<View>,
    overlay: Overlay,
    input: Input,
    status: Option<(String, Color, Instant)>,
    epoch: u64,
    quit: bool,
    paused: Arc<AtomicBool>,
    /// epoch of the current context switch: connect/discover replies of an older one are dropped
    ctx_epoch: u64,
    last_report: Option<(String, Instant)>,
    start: Start,
    /// a drill waiting for the object's JSON: (namespace, label)
    pending_drill: Option<(Option<String>, String)>,
    /// the next logs view shows the previous container
    previous: bool,
    /// the next logs view shows only this container
    log_container: Option<String>,
    /// the cluster serves metrics.k8s.io (from `connect`)
    has_metrics: bool,
    /// what the next successful mutation says ("deleted pod/x"); kept across the protected prompt
    done_text: Option<String>,
}

pub fn run(start: Start) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let client = Client::connect(tx.clone(), true).map_err(|e| e.message)?;
    let mut terminal = ratatui::init();
    let paused = Arc::new(AtomicBool::new(false));
    spawn_input(tx.clone(), paused.clone());
    let mut app = App {
        client,
        rx,
        herdr: Herdr::detect(),
        context: String::new(),
        contexts: vec![],
        server: String::new(),
        resources: vec![],
        stack: vec![],
        overlay: Overlay::None,
        input: Input::None,
        status: None,
        epoch: 0,
        quit: false,
        paused,
        ctx_epoch: 0,
        last_report: None,
        start,
        pending_drill: None,
        previous: false,
        log_container: None,
        has_metrics: false,
        done_text: None,
    };
    app.boot();
    let result = app.event_loop(&mut terminal);
    ratatui::restore();
    if let Some(h) = &app.herdr {
        h.report(None);
    }
    result
}

fn spawn_input(tx: Sender<Msg>, paused: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        loop {
            if paused.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(30));
                continue;
            }
            match event::poll(Duration::from_millis(50)) {
                Ok(true) => match event::read() {
                    Ok(ev) => {
                        if tx.send(Msg::Input(ev)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Ok(false) => {}
                Err(_) => break,
            }
        }
    });
}

impl App {
    fn tag(&self, kind: &'static str) -> Tag {
        Tag { kind, epoch: self.epoch }
    }

    fn info(&mut self, text: impl Into<String>) {
        self.status = Some((text.into(), DIM, Instant::now()));
    }
    fn ok(&mut self, text: impl Into<String>) {
        self.status = Some((text.into(), OK, Instant::now()));
    }
    fn err(&mut self, text: impl Into<String>) {
        self.status = Some((text.into(), BAD, Instant::now()));
    }

    fn boot(&mut self) {
        self.info("connecting…");
        self.client.send(self.tag("contexts"), "list_contexts", json!({}));
    }

    fn event_loop(&mut self, terminal: &mut DefaultTerminal) -> Result<(), String> {
        while !self.quit {
            terminal.draw(|f| self.draw(f)).map_err(|e| e.to_string())?;
            let first = match self.rx.recv_timeout(Duration::from_secs(1)) {
                Ok(m) => Some(m),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let mut batch: Vec<Msg> = first.into_iter().collect();
            // drain what is already queued: one redraw for a burst of deltas or log lines
            while batch.len() < 512 {
                match self.rx.try_recv() {
                    Ok(m) => batch.push(m),
                    Err(_) => break,
                }
            }
            for m in batch {
                self.handle(m, terminal);
            }
            self.report_health();
            self.poll_metrics();
        }
        Ok(())
    }

    fn handle(&mut self, m: Msg, terminal: &mut DefaultTerminal) {
        match m {
            Msg::Input(Event::Key(k)) if k.kind != KeyEventKind::Release => self.key(k, terminal),
            Msg::Input(_) => {}
            Msg::Reply { tag, result } => self.reply(tag, result),
            Msg::Stream { tag, event } => self.stream(tag, event),
            Msg::Backend(ev) => {
                if ev["type"] == "forwards" && matches!(self.stack.last(), Some(View::Forwards(_))) {
                    self.client.send(self.tag("forwards"), "list_forwards", json!({}));
                }
            }
            Msg::Closed => {
                self.quit = true;
                eprintln!("kns-tui: kns went away");
            }
        }
    }

    // ───────────── navigation ─────────────

    fn push(&mut self, v: View) {
        self.stack.push(v);
    }

    fn pop(&mut self) {
        if self.stack.len() <= 1 {
            self.quit = true;
            return;
        }
        if let Some(v) = self.stack.pop()
            && let Some(id) = v.stream()
        {
            self.client.stop(id);
        }
        // the view below may have been left without a stream (back from a drill): keep it live
        if let Some(View::Table(t)) = self.stack.last()
            && t.stream.is_none()
        {
            self.resubscribe();
        }
    }

    /// Replaces the whole stack with one table (context or namespace change, `:` resource).
    fn reset_to(&mut self, res: Res, namespace: Option<String>, selector: Option<String>) {
        for v in self.stack.drain(..) {
            if let Some(id) = v.stream() {
                self.client.stop(id);
            }
        }
        self.open_table(res, namespace, selector, None, None);
    }

    fn open_table(&mut self, res: Res, namespace: Option<String>, selector: Option<String>, field: Option<String>, scope: Option<String>) {
        self.epoch += 1;
        let namespace = if res.namespaced { namespace } else { None };
        self.push(View::Table(TableView {
            res,
            namespace,
            selector,
            field,
            scope,
            table: Table::syncing(),
            filter: String::new(),
            cursor: 0,
            offset: 0,
            stream: None,
            epoch: self.epoch,
            metrics: HashMap::new(),
            metrics_at: None,
            sort: Sort::Name,
        }));
        self.resubscribe();
    }

    fn resubscribe(&mut self) {
        let context = self.context.clone();
        let Some(View::Table(t)) = self.stack.last_mut() else { return };
        if let Some(id) = t.stream.take() {
            self.client.stop(&id);
        }
        let query = json!({
            "context": context, "gvr": t.res.gvr(), "namespace": t.namespace,
            "labelSelector": t.selector, "fieldSelector": t.field,
        });
        t.table.state = "syncing".into();
        let tag = Tag { kind: "table", epoch: t.epoch };
        self.client.send(tag, "subscribe_table", json!({ "query": query }));
    }

    fn namespace(&self) -> Option<String> {
        self.stack.iter().rev().find_map(|v| match v {
            View::Table(t) if t.res.namespaced => Some(t.namespace.clone()),
            _ => None,
        })?
    }

    fn res_or_builtin(&self, name: &str) -> Option<Res> {
        model::lookup(&self.resources, name).cloned().or_else(|| {
            let plural = match name {
                "po" | "pod" => "pods",
                "deploy" | "deployment" => "deployments",
                "svc" | "service" => "services",
                "ns" | "namespace" => "namespaces",
                "no" | "node" => "nodes",
                n => n,
            };
            model::builtin(plural)
        })
    }

    // ───────────── replies ─────────────

    fn reply(&mut self, tag: Tag, result: Result<Value, RpcError>) {
        match tag.kind {
            "contexts" => match result {
                Ok(v) => {
                    self.contexts = v["contexts"].as_array().into_iter().flatten().filter_map(|c| c["name"].as_str().map(str::to_string)).collect();
                    let current = v["current"].as_str().map(str::to_string);
                    let want = self.start.context.clone().or(self.start.project.context.clone()).or(current).or_else(|| self.contexts.first().cloned());
                    match want {
                        Some(c) => self.switch_context(c),
                        None => self.err("no contexts in the kubeconfig"),
                    }
                }
                Err(e) => self.err(format!("kubeconfig: {e}")),
            },
            "connect" if tag.epoch == self.ctx_epoch => match result {
                Ok(v) => {
                    self.server = v["serverVersion"].as_str().unwrap_or_default().to_string();
                    self.has_metrics = v["hasMetrics"].as_bool().unwrap_or(false);
                    self.ok(format!("connected to {} ({})", self.context, self.server));
                    self.client.send(Tag { kind: "discover", epoch: self.ctx_epoch }, "discover", json!({ "context": self.context }));
                }
                Err(e) => self.err(format!("{}: {e}", self.context)),
            },
            "discover" if tag.epoch == self.ctx_epoch => {
                if let Ok(v) = result {
                    self.resources = v.as_array().into_iter().flatten().filter_map(Res::from_value).filter(|r| r.can("list")).collect();
                    // the first table may have opened on a builtin guess: fix its resource now
                    if let Some(View::Table(t)) = self.stack.last_mut()
                        && let Some(r) = model::lookup(&self.resources, &t.res.resource)
                    {
                        t.res.verbs = r.verbs.clone();
                        t.res.short = r.short.clone();
                    }
                }
            }
            "table" => {
                let view = self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch);
                match (result, view) {
                    (Err(e), Some(View::Table(t))) => {
                        t.table.state = "error".into();
                        t.table.message = Some(e.message);
                    }
                    (Ok(Value::String(id)), Some(View::Table(t))) => t.stream = Some(id),
                    // the view is gone already
                    (Ok(Value::String(id)), _) => self.client.stop(&id),
                    _ => {}
                }
            }
            "logs" => {
                if let Ok(Value::String(id)) = &result {
                    match self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch) {
                        Some(View::Logs(l)) => l.stream = Some(id.clone()),
                        _ => self.client.stop(id),
                    }
                } else if let Err(e) = result {
                    self.err(format!("logs: {e}"));
                }
            }
            "logs-targets" => self.logs_targets(tag, result),
            "yaml" | "why" | "events" | "secret" | "json-drill" | "env" => self.text_reply(tag, result),
            "dryrun" => self.dryrun_reply(tag, result),
            "metrics" => {
                if let Some(View::Table(t)) = self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch) {
                    match result {
                        Ok(Value::Array(list)) => {
                            t.metrics = list
                                .iter()
                                .map(|m| {
                                    let n = |k: &str| m[k].as_i64().unwrap_or(0);
                                    (metrics_key(m["namespace"].as_str(), m["name"].as_str().unwrap_or_default()), (n("cpuMilli"), n("memBytes"), n("cpuAllocMilli"), n("memAllocBytes")))
                                })
                                .collect();
                        }
                        // no metrics API after all: stop asking
                        _ => self.has_metrics = false,
                    }
                }
            }
            "revisions" => {
                if let Some(View::Revisions(r)) = self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch) {
                    r.loading = false;
                    match result {
                        Ok(Value::Array(mut list)) => {
                            list.sort_by_key(|x| std::cmp::Reverse(x["revision"].as_i64().unwrap_or(0)));
                            r.cursor = r.cursor.min(list.len().saturating_sub(1));
                            r.list = list;
                        }
                        Ok(_) => {}
                        Err(e) => self.status = Some((format!("history: {}", e.message), BAD, Instant::now())),
                    }
                }
            }
            "forwards" => match result {
                Ok(v) => {
                    let list = v.as_array().cloned().unwrap_or_default();
                    if let Some(View::Forwards(f)) = self.stack.last_mut() {
                        f.cursor = f.cursor.min(list.len().saturating_sub(1));
                        f.list = list;
                    }
                }
                Err(e) => self.err(format!("forwards: {e}")),
            },
            "action" => match result {
                Ok(v) => {
                    let msg = match &v {
                        Value::String(s) if !s.is_empty() => format!("done: {s}"),
                        v if v.get("localPort").is_some() => format!(
                            "forwarding {}:{} → {}",
                            v["address"].as_str().unwrap_or("127.0.0.1"),
                            v["localPort"],
                            v["pod"].as_str().unwrap_or_default()
                        ),
                        _ => "done".into(),
                    };
                    self.ok(msg);
                }
                Err(e) => self.err(e.message),
            },
            _ => {}
        }
    }

    fn switch_context(&mut self, context: String) {
        self.epoch += 1;
        self.ctx_epoch = self.epoch;
        self.context = context.clone();
        self.resources.clear();
        self.server.clear();
        self.info(format!("connecting to {context}…"));
        self.client.send(self.tag("connect"), "connect", json!({ "context": context }));
        // open the first table right away; it fills once the session is up
        let p = self.start.project.clone();
        let first = self.start.resource.clone().or(p.resource.clone()).unwrap_or_else(|| "pods".into());
        let res = self.res_or_builtin(&first).unwrap_or_else(|| model::builtin("pods").expect("pods is builtin"));
        let namespace = self.start.namespace.clone().or(p.namespace.clone()).or_else(|| self.namespace());
        let selector = self.start.selector.clone().or(p.selector.clone());
        if let Some(target) = self.start.logs.take() {
            self.open_table(res, namespace, selector, None, None);
            self.previous = std::mem::take(&mut self.start.previous);
            self.logs_for_target(target);
            return;
        }
        self.reset_to(res, namespace, selector);
    }

    fn text_reply(&mut self, tag: Tag, result: Result<Value, RpcError>) {
        let lines: Vec<Line<'static>> = match (tag.kind, result) {
            (_, Err(e)) => vec![Line::from(Span::styled(format!("{}: {}", e.reason, e.message), Style::new().fg(BAD)))],
            ("yaml", Ok(v)) => yaml_lines(v.as_str().unwrap_or_default()),
            ("why", Ok(v)) => why_lines(&v),
            ("events", Ok(v)) => event_lines(&v),
            ("secret", Ok(v)) => secret_lines(&v),
            ("env", Ok(v)) => env_lines(&v),
            ("json-drill", Ok(v)) => {
                self.drill_with(tag, v);
                return;
            }
            (_, Ok(v)) => v.to_string().lines().map(|l| Line::from(l.to_string())).collect(),
        };
        if let Some(View::Text(t)) = self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch) {
            t.lines = lines;
        }
    }

    // ───────────── streams ─────────────

    fn stream(&mut self, tag: Tag, event: Value) {
        match tag.kind {
            "table" => {
                if let Some(View::Table(t)) = self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch) {
                    t.table.apply(&event);
                    let n = t.visible().len();
                    t.cursor = t.cursor.min(n.saturating_sub(1));
                }
            }
            "nslist" => {
                if event["type"] == "snapshot" {
                    let mut names: Vec<String> = event["rows"].as_array().into_iter().flatten().filter_map(|r| r["name"].as_str().map(str::to_string)).collect();
                    names.sort();
                    names.insert(0, "(all namespaces)".into());
                    if let Overlay::Picker { kind: PickKind::Namespace, items, .. } = &mut self.overlay {
                        *items = names;
                    }
                }
            }
            "logs" => {
                if let Some(View::Logs(l)) = self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch) {
                    match event["type"].as_str() {
                        Some("lines") => {
                            for line in event["lines"].as_array().into_iter().flatten() {
                                l.lines.push_back(LogLine {
                                    pod: line["pod"].as_str().unwrap_or_default().to_string(),
                                    container: line["container"].as_str().unwrap_or_default().to_string(),
                                    text: model::clean_log(line["text"].as_str().unwrap_or_default()),
                                    level: line["level"].as_str().map(str::to_string),
                                });
                            }
                            while l.lines.len() > 20_000 {
                                l.lines.pop_front();
                                l.scroll = l.scroll.saturating_sub(1);
                            }
                        }
                        Some("end") => {
                            l.ended += 1;
                        }
                        Some("error") => l.lines.push_back(LogLine {
                            pod: event["pod"].as_str().unwrap_or_default().to_string(),
                            container: String::new(),
                            text: format!("! {}", event["message"].as_str().unwrap_or_default()),
                            level: Some("error".into()),
                        }),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    // ───────────── selection helpers ─────────────

    fn selected(&self) -> Option<(Res, Value, String)> {
        let View::Table(t) = self.stack.last()? else { return None };
        let vis = t.visible();
        let row = &t.table.rows[*vis.get(t.cursor)?];
        let obj = json!({ "context": self.context, "gvr": t.res.gvr(), "namespace": row.namespace, "name": row.name });
        let label = format!("{}/{}", t.res.singular_or_kind(), row.name);
        Some((t.res.clone(), obj, label))
    }

    // ───────────── keys ─────────────

    fn key(&mut self, k: KeyEvent, terminal: &mut DefaultTerminal) {
        if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        if !matches!(self.overlay, Overlay::None) {
            self.overlay_key(k);
            return;
        }
        if !matches!(self.input, Input::None) {
            self.input_key(k, terminal);
            return;
        }
        // global keys
        match k.code {
            KeyCode::Char(':') => {
                self.input = Input::Command(String::new());
                return;
            }
            KeyCode::Char('?') => {
                self.overlay = Overlay::Help;
                return;
            }
            KeyCode::Char('c') if !k.modifiers.contains(KeyModifiers::CONTROL) => {
                self.pick_context();
                return;
            }
            KeyCode::Char('n') => {
                self.pick_namespace();
                return;
            }
            KeyCode::Char('W') => {
                match self.client.call("show_window", json!({})) {
                    Ok(_) => self.info("opened the kns window"),
                    Err(e) => self.err(e.message),
                }
                return;
            }
            KeyCode::Char('q') | KeyCode::Esc => {
                if matches!(self.stack.last(), Some(View::Review(_))) {
                    self.overlay = Overlay::Confirm { text: "Discard this change? Nothing was applied.".into(), then: Pending::DiscardReview };
                    return;
                }
                if let Some(View::Table(t)) = self.stack.last_mut()
                    && !t.filter.is_empty()
                    && k.code == KeyCode::Esc
                {
                    t.filter.clear();
                    return;
                }
                if let Some(View::Logs(l)) = self.stack.last_mut()
                    && !l.filter.is_empty()
                    && k.code == KeyCode::Esc
                {
                    l.filter.clear();
                    return;
                }
                self.pop();
                return;
            }
            _ => {}
        }
        match self.stack.last() {
            Some(View::Table(_)) => self.table_key(k, terminal),
            Some(View::Text(_)) => self.text_key(k),
            Some(View::Logs(_)) => self.logs_key(k),
            Some(View::Forwards(_)) => self.forwards_key(k),
            Some(View::Review(_)) => self.review_key(k, terminal),
            Some(View::Revisions(_)) => self.revisions_key(k),
            None => {}
        }
    }

    fn table_key(&mut self, k: KeyEvent, terminal: &mut DefaultTerminal) {
        let page = terminal.size().map(|s| s.height.saturating_sub(5) as usize).unwrap_or(20).max(1);
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        {
            let Some(View::Table(t)) = self.stack.last_mut() else { return };
            let n = t.visible().len();
            let last = n.saturating_sub(1);
            match k.code {
                KeyCode::Down | KeyCode::Char('j') => t.cursor = (t.cursor + 1).min(last),
                KeyCode::Up | KeyCode::Char('k') => t.cursor = t.cursor.saturating_sub(1),
                KeyCode::PageDown => t.cursor = (t.cursor + page).min(last),
                KeyCode::PageUp => t.cursor = t.cursor.saturating_sub(page),
                KeyCode::Char('f') if ctrl => t.cursor = (t.cursor + page).min(last),
                KeyCode::Char('b') if ctrl => t.cursor = t.cursor.saturating_sub(page),
                KeyCode::Home | KeyCode::Char('g') => t.cursor = 0,
                KeyCode::End | KeyCode::Char('G') => t.cursor = last,
                KeyCode::Char('/') => {
                    let f = t.filter.clone();
                    self.input = Input::Filter(f);
                }
                KeyCode::Char('R') => self.resubscribe(),
                KeyCode::Char('o') => {
                    t.sort = t.sort.next(!t.metrics.is_empty());
                    t.cursor = 0;
                }
                _ => self.row_action(k, terminal),
            }
        }
    }

    fn row_action(&mut self, k: KeyEvent, terminal: &mut DefaultTerminal) {
        let Some((res, obj, label)) = self.selected() else { return };
        let is_pod = res.is("", "pods");
        let workload = ["deployments", "statefulsets", "daemonsets", "replicasets", "jobs"].contains(&res.resource.as_str());
        match k.code {
            KeyCode::Enter => self.drill(res, obj, label),
            KeyCode::Char('y') => self.open_text(format!("YAML · {label}"), "yaml", "get_yaml", json!({ "objRef": obj, "managedFields": false })),
            KeyCode::Char('d') | KeyCode::Char('w') => self.open_text(format!("Why · {label}"), "why", "diagnose", json!({ "objRef": obj })),
            KeyCode::Char('e') => self.edit_object(obj, label, terminal),
            KeyCode::Char('E') => {
                let ns = obj["namespace"].clone();
                self.open_text(format!("Events · {label}"), "events", "list_events", json!({ "context": self.context, "namespace": ns, "objRef": obj }))
            }
            KeyCode::Char('v') if is_pod || workload || res.is("batch", "cronjobs") => {
                self.open_text(format!("Env · {label}"), "env", "env_resolve", json!({ "objRef": obj, "container": null }))
            }
            KeyCode::Char('i') if is_pod || ["deployments", "statefulsets", "daemonsets", "replicasets", "cronjobs"].contains(&res.resource.as_str()) => {
                self.set_image(&res, obj, label)
            }
            KeyCode::Char('h') if ["deployments", "statefulsets", "daemonsets"].contains(&res.resource.as_str()) => self.history(&res, obj, label),
            KeyCode::Char('x') if res.is("", "secrets") => {
                self.open_text(format!("Secret · {label}"), "secret", "decode_secret", json!({ "objRef": obj }))
            }
            KeyCode::Char('l') if is_pod || workload => self.logs_for(&res, &obj, &label),
            KeyCode::Char('p') if is_pod => self.logs_previous(&obj, &label),
            KeyCode::Char('s') if is_pod || workload => self.shell(&res, &obj, terminal),
            KeyCode::Delete | KeyCode::Char('D') => self.overlay = Overlay::Confirm { text: format!("Delete {label}?"), then: Pending::Delete { obj, label } },
            KeyCode::Char('r') if workload || res.is("apps", "deployments") => {
                self.overlay = Overlay::Confirm { text: format!("Restart {label}?"), then: Pending::Restart { obj, label } }
            }
            KeyCode::Char('S') if ["deployments", "statefulsets", "replicasets"].contains(&res.resource.as_str()) => {
                self.overlay = Overlay::Prompt { label: format!("Scale {label} to"), input: String::new(), then: Pending::Scale { obj, label } }
            }
            KeyCode::Char('t') if res.is("batch", "cronjobs") => {
                self.overlay = Overlay::Confirm { text: format!("Run {label} now?"), then: Pending::Trigger { obj, label } }
            }
            KeyCode::Char('F') => {
                let target = match res.resource.as_str() {
                    "pods" => json!({ "kind": "pod", "namespace": obj["namespace"], "name": obj["name"] }),
                    "services" => json!({ "kind": "service", "namespace": obj["namespace"], "name": obj["name"] }),
                    _ if workload => json!({ "kind": "workload", "gvr": res.gvr(), "namespace": obj["namespace"], "name": obj["name"] }),
                    _ => return self.err("port-forward works on pods, services and workloads"),
                };
                self.overlay = Overlay::Prompt { label: format!("Forward {label}: [local:]remote port"), input: String::new(), then: Pending::Forward { target, label } };
            }
            _ => {}
        }
    }

    fn text_key(&mut self, k: KeyEvent) {
        let Some(View::Text(t)) = self.stack.last_mut() else { return };
        let last = t.lines.len().saturating_sub(1);
        match k.code {
            KeyCode::Down | KeyCode::Char('j') => t.scroll = (t.scroll + 1).min(last),
            KeyCode::Up | KeyCode::Char('k') => t.scroll = t.scroll.saturating_sub(1),
            KeyCode::PageDown | KeyCode::Char(' ') => t.scroll = (t.scroll + 20).min(last),
            KeyCode::PageUp => t.scroll = t.scroll.saturating_sub(20),
            KeyCode::Char('g') | KeyCode::Home => t.scroll = 0,
            KeyCode::Char('G') | KeyCode::End => t.scroll = last,
            _ => {}
        }
    }

    fn logs_key(&mut self, k: KeyEvent) {
        let Some(View::Logs(l)) = self.stack.last_mut() else { return };
        match k.code {
            KeyCode::Up | KeyCode::Char('k') => {
                l.follow = false;
                l.scroll = l.scroll.saturating_add(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                l.scroll = l.scroll.saturating_sub(1);
                if l.scroll == 0 {
                    l.follow = true;
                }
            }
            KeyCode::PageUp => {
                l.follow = false;
                l.scroll = l.scroll.saturating_add(20);
            }
            KeyCode::PageDown => {
                l.scroll = l.scroll.saturating_sub(20);
                if l.scroll == 0 {
                    l.follow = true;
                }
            }
            KeyCode::Char('g') | KeyCode::Home => {
                l.follow = false;
                l.scroll = l.lines.len();
            }
            KeyCode::Char('G') | KeyCode::End | KeyCode::Char('f') => {
                l.follow = true;
                l.scroll = 0;
            }
            KeyCode::Char('w') => l.wrap = !l.wrap,
            KeyCode::Char('/') => self.input = Input::Filter(l.filter.clone()),
            KeyCode::Char('C') => l.lines.clear(),
            _ => {}
        }
    }

    fn forwards_key(&mut self, k: KeyEvent) {
        let Some(View::Forwards(f)) = self.stack.last_mut() else { return };
        let last = f.list.len().saturating_sub(1);
        match k.code {
            KeyCode::Down | KeyCode::Char('j') => f.cursor = (f.cursor + 1).min(last),
            KeyCode::Up | KeyCode::Char('k') => f.cursor = f.cursor.saturating_sub(1),
            KeyCode::Char('x') | KeyCode::Delete | KeyCode::Char('D') => {
                if let Some(id) = f.list.get(f.cursor).and_then(|v| v["id"].as_str()).map(str::to_string) {
                    self.client.send(self.tag("action"), "stop_forward", json!({ "id": id }));
                    self.client.send(self.tag("forwards"), "list_forwards", json!({}));
                }
            }
            KeyCode::Char('o') | KeyCode::Enter => {
                if let Some(id) = f.list.get(f.cursor).and_then(|v| v["id"].as_str()).map(str::to_string) {
                    self.client.send(self.tag("action"), "open_forward", json!({ "id": id }));
                }
            }
            _ => {}
        }
    }

    fn input_key(&mut self, k: KeyEvent, terminal: &mut DefaultTerminal) {
        let (text, is_cmd) = match &mut self.input {
            Input::Command(s) => (s, true),
            Input::Filter(s) => (s, false),
            Input::None => return,
        };
        match k.code {
            KeyCode::Esc => {
                if !is_cmd {
                    self.set_filter(String::new());
                }
                self.input = Input::None;
            }
            KeyCode::Enter => {
                let t = std::mem::take(text);
                self.input = Input::None;
                if is_cmd {
                    self.command(&t, terminal);
                } else {
                    self.set_filter(t);
                }
            }
            KeyCode::Backspace => {
                text.pop();
                if !is_cmd {
                    let t = text.clone();
                    self.set_filter(t);
                }
            }
            KeyCode::Tab if is_cmd => {
                let word = text.trim().to_lowercase();
                let mut names: Vec<String> = self.resources.iter().flat_map(|r| std::iter::once(r.resource.clone()).chain(r.short.clone())).collect();
                names.extend(["ctx", "ns", "pf", "forwards", "quit", "apply", "new", "edit"].iter().map(|s| s.to_string()));
                names.sort();
                names.dedup();
                if let Some(m) = names.iter().find(|n| n.starts_with(&word)) {
                    *text = m.clone();
                }
            }
            KeyCode::Char(c) => {
                text.push(c);
                if !is_cmd {
                    let t = text.clone();
                    self.set_filter(t);
                }
            }
            _ => {}
        }
    }

    fn set_filter(&mut self, f: String) {
        match self.stack.last_mut() {
            Some(View::Table(t)) => {
                t.filter = f;
                t.cursor = 0;
            }
            Some(View::Logs(l)) => l.filter = f,
            _ => {}
        }
    }

    fn command(&mut self, line: &str, terminal: &mut DefaultTerminal) {
        let mut words = line.split_whitespace();
        let Some(cmd) = words.next() else { return };
        let arg = words.next().map(str::to_string);
        match cmd {
            "q" | "quit" | "q!" => self.quit = true,
            "ctx" | "context" => match arg {
                Some(c) if self.contexts.contains(&c) => self.switch_context(c),
                Some(c) => self.err(format!("no context \"{c}\"")),
                None => self.pick_context(),
            },
            "ns" | "namespace" => match arg {
                Some(n) => self.set_namespace(if n == "all" || n == "-A" { None } else { Some(n) }),
                None => self.pick_namespace(),
            },
            "pf" | "forwards" | "portforwards" => {
                self.epoch += 1;
                let epoch = self.epoch;
                self.push(View::Forwards(ForwardsView { list: vec![], cursor: 0, epoch }));
                self.client.send(self.tag("forwards"), "list_forwards", json!({}));
            }
            "res" | "resources" => self.pick_resource(),
            "edit" => match self.selected() {
                Some((_, obj, label)) => self.edit_object(obj, label, terminal),
                None => self.err("no row selected"),
            },
            "apply" => self.apply_manifest(arg, terminal),
            "new" => {
                let ns = self.namespace().unwrap_or_default();
                let text = edit::skeleton(arg.as_deref().unwrap_or(""), &ns);
                self.new_manifest(text, terminal);
            }
            "open" | "window" => {
                let _ = self.client.call("show_window", json!({}));
            }
            name => match self.res_or_builtin(name) {
                Some(res) => {
                    // `:pods kube-system` / `:pods all`
                    let ns = match arg.as_deref() {
                        Some("all") | Some("-A") => None,
                        Some(n) => Some(n.to_string()),
                        None => self.namespace(),
                    };
                    self.reset_to(res, ns, None);
                }
                None => self.err(format!("unknown resource or command \"{name}\"")),
            },
        }
    }

    fn set_namespace(&mut self, ns: Option<String>) {
        let res = match self.stack.first() {
            Some(View::Table(t)) => t.res.clone(),
            _ => model::builtin("pods").expect("builtin"),
        };
        let res = if res.namespaced { res } else { model::builtin("pods").expect("builtin") };
        self.reset_to(res, ns, None);
    }

    // ───────────── overlays ─────────────

    fn pick_context(&mut self) {
        let mut items = self.contexts.clone();
        items.sort();
        let cursor = items.iter().position(|c| *c == self.context).unwrap_or(0);
        self.overlay = Overlay::Picker { kind: PickKind::Context, items, filter: String::new(), cursor };
    }

    fn pick_namespace(&mut self) {
        self.overlay = Overlay::Picker { kind: PickKind::Namespace, items: vec!["(loading…)".into()], filter: String::new(), cursor: 0 };
        let query = json!({ "context": self.context, "gvr": { "group": "", "version": "v1", "resource": "namespaces" } });
        // a short-lived subscription: the picker takes the snapshot, closing the picker stops it
        match self.client.call_stream(self.tag("nslist"), "subscribe_table", json!({ "query": query })) {
            Ok(Value::String(id)) => {
                // the snapshot is usually already queued; stop shortly after
                let c = self.client.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    c.stop(&id);
                });
            }
            Ok(_) => {}
            Err(e) => {
                // no list permission on namespaces: type one instead
                self.overlay = Overlay::None;
                self.err(format!("cannot list namespaces ({}); use :ns <name>", e.message));
            }
        }
    }

    fn pick_resource(&mut self) {
        let mut items: Vec<String> = self.resources.iter().map(Res::label).collect();
        items.sort();
        self.overlay = Overlay::Picker { kind: PickKind::Resource, items, filter: String::new(), cursor: 0 };
    }

    fn overlay_key(&mut self, k: KeyEvent) {
        let overlay = std::mem::replace(&mut self.overlay, Overlay::None);
        match overlay {
            Overlay::None => {}
            Overlay::Help => {}
            Overlay::Picker { kind, items, mut filter, mut cursor } => {
                let shown: Vec<&String> = items.iter().filter(|i| fuzzy(i, &filter)).collect();
                match k.code {
                    KeyCode::Esc => return,
                    KeyCode::Enter => {
                        let Some(choice) = shown.get(cursor).map(|s| s.to_string()) else { return };
                        match kind {
                            PickKind::Context => self.switch_context(choice),
                            PickKind::Namespace => self.set_namespace(if choice.starts_with('(') { None } else { Some(choice) }),
                            PickKind::Resource => {
                                if let Some(r) = self.res_or_builtin(&choice) {
                                    let ns = self.namespace();
                                    self.reset_to(r, ns, None);
                                }
                            }
                        }
                        return;
                    }
                    KeyCode::Down => cursor = (cursor + 1).min(shown.len().saturating_sub(1)),
                    KeyCode::Up => cursor = cursor.saturating_sub(1),
                    KeyCode::Char('j') if k.modifiers.contains(KeyModifiers::CONTROL) => cursor = (cursor + 1).min(shown.len().saturating_sub(1)),
                    KeyCode::Char('k') if k.modifiers.contains(KeyModifiers::CONTROL) => cursor = cursor.saturating_sub(1),
                    KeyCode::Backspace => {
                        filter.pop();
                        cursor = 0;
                    }
                    KeyCode::Char(c) => {
                        filter.push(c);
                        cursor = 0;
                    }
                    _ => {}
                }
                self.overlay = Overlay::Picker { kind, items, filter, cursor };
            }
            Overlay::Confirm { text, then } => match k.code {
                KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => self.run_pending(then, None),
                KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Char('q') => {}
                _ => self.overlay = Overlay::Confirm { text, then },
            },
            Overlay::Prompt { label, mut input, then } => match k.code {
                KeyCode::Esc => {}
                KeyCode::Enter => self.run_pending(then, Some(input)),
                KeyCode::Backspace => {
                    input.pop();
                    self.overlay = Overlay::Prompt { label, input, then };
                }
                KeyCode::Char(c) => {
                    input.push(c);
                    self.overlay = Overlay::Prompt { label, input, then };
                }
                _ => self.overlay = Overlay::Prompt { label, input, then },
            },
            Overlay::Protected { context, mut input, method, mut params } => match k.code {
                KeyCode::Esc => {
                    self.done_text = None;
                    self.info("cancelled");
                }
                KeyCode::Enter => {
                    if input == context {
                        params["confirm"] = json!(context);
                        if method == "apply_yaml" {
                            self.apply_call(params);
                        } else {
                            self.mutate(&method, params);
                        }
                    } else {
                        self.err("the name did not match; nothing was changed");
                    }
                }
                KeyCode::Backspace => {
                    input.pop();
                    self.overlay = Overlay::Protected { context, input, method, params };
                }
                KeyCode::Char(c) => {
                    input.push(c);
                    self.overlay = Overlay::Protected { context, input, method, params };
                }
                _ => self.overlay = Overlay::Protected { context, input, method, params },
            },
        }
    }

    fn run_pending(&mut self, p: Pending, input: Option<String>) {
        match p {
            Pending::Delete { obj, label } => {
                self.info(format!("deleting {label}…"));
                self.done_text = Some(format!("deleted {label}"));
                self.mutate("delete_object", json!({ "objRef": obj, "opts": {} }));
            }
            Pending::Restart { obj, label } => {
                self.info(format!("restarting {label}…"));
                self.done_text = Some(format!("restarted {label}"));
                self.mutate("restart", json!({ "objRef": obj }));
            }
            Pending::Trigger { obj, label } => {
                self.info(format!("starting {label}…"));
                self.mutate("trigger_cron_job", json!({ "objRef": obj }));
            }
            Pending::Scale { obj, label } => match input.as_deref().map(str::trim).and_then(|s| s.parse::<u32>().ok()) {
                Some(n) => {
                    self.info(format!("scaling {label} to {n}…"));
                    self.done_text = Some(format!("scaled {label} to {n}"));
                    self.mutate("scale", json!({ "objRef": obj, "replicas": n }));
                }
                None => self.err("not a number"),
            },
            Pending::SetImage { obj, label, base, containers } => {
                let text = input.unwrap_or_default();
                let wanted: Vec<(String, String)> = if containers.len() == 1 {
                    vec![(containers[0].0.clone(), text.trim().to_string())]
                } else {
                    text.split_whitespace().filter_map(|p| p.split_once('=')).map(|(c, i)| (c.to_string(), i.to_string())).collect()
                };
                let mut ops = vec![];
                for (c, image) in wanted {
                    let Some(i) = containers.iter().position(|(n, _)| *n == c) else { return self.err(format!("no container \"{c}\"")) };
                    if image.is_empty() {
                        return self.err("empty image");
                    }
                    if containers[i].1 != image {
                        // the test op makes the patch fail if the containers moved since we read them
                        ops.push(json!({ "op": "test", "path": format!("{base}/containers/{i}/name"), "value": c }));
                        ops.push(json!({ "op": "replace", "path": format!("{base}/containers/{i}/image"), "value": image }));
                    }
                }
                if ops.is_empty() {
                    return self.info("no image changed");
                }
                self.info(format!("setting the image of {label}…"));
                self.done_text = Some(format!("new image on {label}: the rollout starts"));
                self.mutate("patch_object", json!({ "objRef": obj, "patch": ops, "patchType": "json" }));
            }
            Pending::ForceApply => self.review_apply(true),
            Pending::DiscardReview => {
                self.pop();
                self.info("change discarded");
            }
            Pending::SaveManifest { text } => {
                let path = expand_home(input.unwrap_or_default().trim());
                if path.as_os_str().is_empty() {
                    return self.err("no file name");
                }
                let written = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()));
                match written {
                    Ok(()) => self.ok(format!("saved {}", path.display())),
                    Err(e) => self.err(format!("{}: {e}", path.display())),
                }
            }
            Pending::Rollback { obj, label, revision, template } => {
                self.info(format!("rolling {label} back to revision {revision}…"));
                self.done_text = Some(format!("rolled {label} back to revision {revision}"));
                self.mutate("patch_object", json!({ "objRef": obj, "patch": [{ "op": "replace", "path": "/spec/template", "value": template }], "patchType": "json" }));
                if let Some(View::Revisions(r)) = self.stack.last_mut() {
                    r.loading = true;
                    let tag = Tag { kind: "revisions", epoch: r.epoch };
                    self.client.send(tag, "revisions", json!({ "objRef": obj }));
                }
            }
            Pending::Forward { target, label } => {
                let spec = input.unwrap_or_default();
                let (local, remote) = match spec.trim().split_once(':') {
                    Some((l, r)) => (l.trim().parse::<u16>().ok(), r.trim().to_string()),
                    None => (None, spec.trim().to_string()),
                };
                if remote.is_empty() {
                    return self.err("give a remote port (number or name)");
                }
                let remote_port = remote.parse::<u16>().map(|n| json!(n)).unwrap_or(json!(remote));
                let query = json!({ "context": self.context, "target": target, "remotePort": remote_port, "localPort": local, "pin": local.is_some() });
                self.info(format!("forwarding {label}…"));
                self.client.send(self.tag("action"), "start_forward", json!({ "query": query }));
            }
        }
    }

    /// A mutation; a protected context answers `ConfirmRequired` and we ask for its name.
    fn mutate(&mut self, method: &str, params: Value) {
        match self.client.call(method, params.clone()) {
            Ok(v) => match self.done_text.take() {
                Some(text) => self.ok(text),
                None => self.reply(self.tag("action"), Ok(v)),
            },
            Err(e) if e.reason == "ConfirmRequired" => {
                let context = params.pointer("/objRef/context").or(params.get("context")).and_then(Value::as_str).unwrap_or(&self.context).to_string();
                self.overlay = Overlay::Protected { context, input: String::new(), method: method.into(), params };
            }
            Err(e) => {
                self.done_text = None;
                self.err(format!("{}: {}", e.reason, e.message));
            }
        }
    }

    // ───────────── views opened from a row ─────────────

    fn open_text(&mut self, title: String, kind: &'static str, method: &str, params: Value) {
        self.epoch += 1;
        let epoch = self.epoch;
        self.push(View::Text(TextView { title, lines: vec![Line::from(Span::styled("loading…", Style::new().fg(DIM)))], scroll: 0, epoch }));
        self.client.send(Tag { kind, epoch }, method, params);
    }

    fn drill(&mut self, res: Res, obj: Value, label: String) {
        let ns = obj["namespace"].as_str().map(str::to_string);
        let name = obj["name"].as_str().unwrap_or_default().to_string();
        let pods = model::builtin("pods").expect("builtin");
        match res.resource.as_str() {
            "namespaces" => self.set_namespace(Some(name)),
            "nodes" => self.open_table(pods, None, None, Some(format!("spec.nodeName={name}")), Some(format!("on node {name}"))),
            "pods" => self.logs_for(&res, &obj, &label),
            "deployments" | "statefulsets" | "daemonsets" | "replicasets" | "jobs" | "services" => {
                // the selector lives in the object: fetch it, then open the pods table
                self.epoch += 1;
                let tag = Tag { kind: "json-drill", epoch: self.epoch };
                self.pending_drill = Some((ns, label));
                self.client.send(tag, "get_json", json!({ "objRef": obj }));
            }
            "cronjobs" => {
                let jobs = self.res_or_builtin("jobs");
                if let Some(jobs) = jobs {
                    self.open_table(jobs, ns, None, None, Some(format!("of {label} (all jobs in the namespace)")));
                }
            }
            _ => self.open_text(format!("YAML · {label}"), "yaml", "get_yaml", json!({ "objRef": obj, "managedFields": false })),
        }
    }

    fn drill_with(&mut self, _tag: Tag, obj: Value) {
        let Some((ns, label)) = self.pending_drill.take() else { return };
        match model::selector_of(&obj) {
            Some(sel) => self.open_table(model::builtin("pods").expect("builtin"), ns, Some(sel), None, Some(format!("of {label}"))),
            None => self.err(format!("{label} has no pod selector")),
        }
    }

    fn logs_for(&mut self, res: &Res, obj: &Value, label: &str) {
        let target = herdr::Target {
            context: Some(self.context.clone()),
            namespace: obj["namespace"].as_str().map(str::to_string),
            pod: res.is("", "pods").then(|| obj["name"].as_str().unwrap_or_default().to_string()),
            container: None,
            workload: (!res.is("", "pods")).then(|| format!("{}/{}", res.label(), obj["name"].as_str().unwrap_or_default())),
        };
        if let Some(h) = self.herdr.clone() {
            let env = target_env(&target);
            let mut args = vec!["logs".to_string(), format!("{}/{}/{}", self.context, target.namespace.clone().unwrap_or_default(), target.pod.clone().or(target.workload.clone()).unwrap_or_default())];
            if target.workload.is_some() {
                args.push("--workload".into());
            }
            match h.open("logs", "down", &env, &args) {
                Ok(()) => return self.info(format!("logs of {label} opened in a herdr pane")),
                Err(e) => self.err(format!("{e}; showing logs here")),
            }
        }
        self.logs_for_target(target);
    }

    fn logs_previous(&mut self, obj: &Value, label: &str) {
        let target = herdr::Target {
            context: Some(self.context.clone()),
            namespace: obj["namespace"].as_str().map(str::to_string),
            pod: obj["name"].as_str().map(str::to_string),
            container: None,
            workload: None,
        };
        self.previous = true;
        self.logs_for_target(target);
        if let Some(View::Logs(l)) = self.stack.last_mut() {
            l.title = format!("previous logs · {label}");
        }
    }

    /// Resolves the pods/containers of a target (`pods_for`), then streams their logs.
    pub fn logs_for_target(&mut self, target: herdr::Target) {
        self.epoch += 1;
        let epoch = self.epoch;
        let context = target.context.clone().unwrap_or_else(|| self.context.clone());
        let ns = target.namespace.clone().unwrap_or_default();
        let (gvr, name) = match (&target.pod, &target.workload) {
            (Some(pod), _) => (json!({ "group": "", "version": "v1", "resource": "pods" }), pod.clone()),
            (None, Some(w)) => {
                let (res, name) = w.split_once('/').unwrap_or(("deployments.apps", w));
                let r = self.res_or_builtin(res).or_else(|| {
                    let (plural, group) = res.split_once('.').unwrap_or((res, ""));
                    Some(Res { group: group.into(), version: "v1".into(), resource: plural.into(), kind: String::new(), singular: String::new(), namespaced: true, short: vec![], verbs: vec![] })
                });
                (r.map(|r| r.gvr()).unwrap_or_default(), name.to_string())
            }
            _ => return self.err("logs: no pod or workload"),
        };
        let title = format!("logs · {ns}/{name}");
        self.push(View::Logs(LogsView {
            title,
            context: context.clone(),
            lines: VecDeque::new(),
            follow: true,
            scroll: 0,
            wrap: false,
            filter: String::new(),
            stream: None,
            multi: false,
            ended: 0,
            targets: 0,
            epoch,
        }));
        self.log_container = target.container.clone();
        let obj = json!({ "context": context, "gvr": gvr, "namespace": ns, "name": name });
        self.client.send(Tag { kind: "logs-targets", epoch }, "pods_for", json!({ "objRef": obj }));
    }

    fn logs_targets(&mut self, tag: Tag, result: Result<Value, RpcError>) {
        let previous = std::mem::take(&mut self.previous);
        let only = self.log_container.take();
        let pods = match result {
            Ok(v) => v.as_array().cloned().unwrap_or_default(),
            Err(e) => return self.err(format!("logs: {e}")),
        };
        let mut targets = vec![];
        for p in pods.iter().take(20) {
            for c in p["containers"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if only.as_deref().is_none_or(|o| o == c) {
                    targets.push(json!({ "namespace": p["namespace"], "pod": p["name"], "container": c }));
                }
            }
        }
        if targets.is_empty() {
            return self.err("logs: no running pods");
        }
        let Some(View::Logs(l)) = self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch) else { return };
        l.multi = targets.len() > 1;
        l.targets = targets.len();
        let query = json!({ "context": l.context, "targets": targets, "follow": !previous, "tailLines": 500, "previous": previous, "parse": true });
        self.client.send(Tag { kind: "logs", epoch: tag.epoch }, "stream_logs", json!({ "query": query }));
    }

    fn shell(&mut self, res: &Res, obj: &Value, terminal: &mut DefaultTerminal) {
        // a workload: its first running pod
        let (ns, pod) = if res.is("", "pods") {
            (obj["namespace"].as_str().unwrap_or_default().to_string(), obj["name"].as_str().unwrap_or_default().to_string())
        } else {
            match self.client.call("pods_for", json!({ "objRef": obj })) {
                Ok(v) => {
                    let first = v.as_array().and_then(|a| a.iter().find(|p| p["phase"] == "Running").or(a.first()).cloned());
                    match first {
                        Some(p) => (p["namespace"].as_str().unwrap_or_default().to_string(), p["name"].as_str().unwrap_or_default().to_string()),
                        None => return self.err("no pod to open a shell in"),
                    }
                }
                Err(e) => return self.err(e.message),
            }
        };
        if let Some(h) = self.herdr.clone() {
            let target = herdr::Target { context: Some(self.context.clone()), namespace: Some(ns.clone()), pod: Some(pod.clone()), container: None, workload: None };
            let args = vec!["exec".to_string(), format!("{}/{ns}/{pod}", self.context)];
            match h.open("exec", "right", &target_env(&target), &args) {
                Ok(()) => return self.info(format!("shell in {pod} opened in a herdr pane")),
                Err(e) => self.err(format!("{e}; opening the shell here")),
            }
        }
        // in place: hand the terminal to the shell, then come back
        let target = ExecTarget { context: self.context.clone(), namespace: ns, pod: pod.clone(), container: None, command: vec![] };
        let result = self.suspend(terminal, || exec::run(&target));
        match result {
            Ok(code) => self.info(format!("shell in {pod} exited ({code})")),
            Err(e) => self.err(e),
        }
    }

    // ───────────── editing and apply ─────────────

    /// Hands the terminal to `f` (an editor, a shell) and takes it back afterwards.
    fn suspend<T>(&mut self, terminal: &mut DefaultTerminal, f: impl FnOnce() -> T) -> T {
        self.paused.store(true, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(80));
        ratatui::restore();
        let result = f();
        // a fresh terminal paints everything on its first draw (no clear(): that queries the cursor)
        *terminal = ratatui::init();
        self.paused.store(false, Ordering::Relaxed);
        result
    }

    fn run_editor(&mut self, terminal: &mut DefaultTerminal, text: &str, hint: &str, header: &[String]) -> Option<String> {
        match self.suspend(terminal, || edit::edit(text, hint, header)) {
            Ok(t) => t,
            Err(e) => {
                self.err(e);
                None
            }
        }
    }

    /// `e`: the object's YAML in `$EDITOR`, then the review.
    fn edit_object(&mut self, obj: Value, label: String, terminal: &mut DefaultTerminal) {
        let yaml = match self.client.call("get_yaml", json!({ "objRef": obj, "managedFields": false })) {
            Ok(Value::String(s)) => s,
            Ok(_) => return self.err("no YAML for this object"),
            Err(e) => return self.err(format!("{}: {}", e.reason, e.message)),
        };
        let header = edit::header(&format!("Editing {label}"), &self.context, None);
        let Some(text) = self.run_editor(terminal, &yaml, &label, &header) else { return self.info("edit cancelled") };
        if text == yaml {
            return self.info("no changes");
        }
        self.start_review(Source::Edit, Some(obj), format!("edit · {label}"), label, yaml, text);
    }

    /// `:apply <file>` reviews a file; `:apply` alone opens an empty buffer.
    fn apply_manifest(&mut self, file: Option<String>, terminal: &mut DefaultTerminal) {
        match file {
            Some(f) => {
                let path = expand_home(&f);
                match std::fs::read_to_string(&path) {
                    Ok(text) if text.trim().is_empty() => self.err(format!("{} is empty", path.display())),
                    Ok(text) => {
                        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(f);
                        self.start_review(Source::Apply, None, format!("apply · {name}"), name, String::new(), text);
                    }
                    Err(e) => self.err(format!("{}: {e}", path.display())),
                }
            }
            None => self.new_manifest("# Write or paste manifests here (several documents with ---).\n".into(), terminal),
        }
    }

    /// `:new [kind]`: a starting manifest in the editor, then the review.
    fn new_manifest(&mut self, text: String, terminal: &mut DefaultTerminal) {
        let header = edit::header("New object", &self.context, None);
        let Some(edited) = self.run_editor(terminal, &text, "new", &header) else { return self.info("cancelled") };
        if edited.trim().is_empty() || edited == text && text.starts_with('#') {
            return self.info("nothing to apply");
        }
        let docs = edit::parse_docs(&edited).unwrap_or_default();
        let label = docs.first().map(edit::doc_label).unwrap_or_else(|| "manifest".into());
        self.start_review(Source::Apply, None, format!("apply · {label}"), label, String::new(), edited);
    }

    fn start_review(&mut self, source: Source, target: Option<Value>, title: String, label: String, original: String, buffer: String) {
        self.epoch += 1;
        self.push(View::Review(ReviewView {
            title,
            label,
            source,
            target,
            context: self.context.clone(),
            original,
            buffer,
            diff: vec![],
            full: false,
            dry: Dry::Running,
            warnings: vec![],
            conflict: None,
            owner: None,
            scroll: 0,
            epoch: self.epoch,
        }));
        self.review_changed();
    }

    /// The buffer changed: new diff, local checks, then the server's dry run.
    fn review_changed(&mut self) {
        let Some(View::Review(r)) = self.stack.last_mut() else { return };
        r.diff = match r.source {
            Source::Edit => diff::unified(&r.original, &r.buffer, 3),
            Source::Apply => vec![(Kind::Gap, "the diff against the cluster follows the dry run…".into())],
        };
        r.scroll = 0;
        r.warnings.clear();
        r.conflict = None;
        let markers = diff::conflict_markers(&r.buffer);
        if !markers.is_empty() {
            let lines: Vec<String> = markers.iter().map(usize::to_string).collect();
            r.dry = Dry::Failed(format!("resolve the conflict markers first (lines {}): e to edit", lines.join(", ")));
            return;
        }
        let docs = match edit::parse_docs(&r.buffer) {
            Ok(d) if d.is_empty() => {
                r.dry = Dry::Failed("no documents to apply".into());
                return;
            }
            Ok(d) => d,
            Err(e) => {
                r.dry = Dry::Failed(format!("not valid YAML: {e}"));
                return;
            }
        };
        r.owner = docs.iter().find_map(edit::gitops_owner);
        if let (Source::Edit, Some(t)) = (r.source, &r.target) {
            let same = docs.len() == 1 && docs[0]["metadata"]["name"].as_str() == t["name"].as_str();
            if !same {
                r.dry = Dry::Failed("an edit keeps one object and its name: use :apply for other objects".into());
                return;
            }
        }
        r.dry = Dry::Running;
        let tag = Tag { kind: "dryrun", epoch: r.epoch };
        let params = json!({ "context": r.context, "yaml": r.buffer, "opts": { "dryRun": true } });
        self.client.send(tag, "apply_yaml", params);
    }

    fn dryrun_reply(&mut self, tag: Tag, result: Result<Value, RpcError>) {
        let Some(View::Review(r)) = self.stack.iter().rev().find(|v| v.epoch() == tag.epoch) else { return };
        let (source, context, buffer) = (r.source, r.context.clone(), r.buffer.clone());
        // A manifest that creates a namespace and objects in it cannot be dry-run as a whole (the
        // namespace does not exist yet, kubectl has the same limit): accept it with a warning and
        // diff the manifest itself.
        let mut result = result;
        let mut extra_warning = None;
        if let Err(e) = &result
            && let Some(ns) = missing_namespace(&e.message)
            && edit::parse_docs(&buffer).unwrap_or_default().iter().any(|d| d["kind"] == "Namespace" && d["metadata"]["name"] == ns)
        {
            extra_warning = Some(format!("namespace {ns} is created by this manifest: the objects in it were checked by the server only on apply"));
            result = Ok(json!({ "yaml": buffer, "warnings": [] }));
        }
        // `:apply`: what the server would make of each document, against what is there now
        let server_diff = match (&result, source) {
            (Ok(v), Source::Apply) => Some(self.server_diff(&context, v["yaml"].as_str().unwrap_or_default())),
            _ => None,
        };
        let Some(View::Review(r)) = self.stack.iter_mut().rev().find(|v| v.epoch() == tag.epoch) else { return };
        match result {
            Ok(v) => {
                r.dry = Dry::Ok;
                r.warnings = v["warnings"].as_array().into_iter().flatten().filter_map(|w| w.as_str().map(str::to_string)).collect();
                r.warnings.extend(extra_warning);
                if let Some(d) = server_diff {
                    r.diff = d;
                }
            }
            Err(e) => {
                r.conflict = edit::classify(e.code as u16, &e.reason, &e.message);
                r.dry = Dry::Failed(format!("{}: {}", e.reason, e.message));
            }
        }
    }

    fn server_diff(&self, context: &str, results: &str) -> Vec<(Kind, String)> {
        let docs = match edit::parse_docs(results) {
            Ok(d) => d,
            Err(e) => return vec![(Kind::Gap, format!("could not read the dry run: {e}"))],
        };
        let mut out = vec![];
        for d in docs.iter().take(30) {
            let api = d["apiVersion"].as_str().unwrap_or("v1");
            let (group, version) = api.split_once('/').unwrap_or(("", api));
            let kind = d["kind"].as_str().unwrap_or_default();
            let current = self.resources.iter().find(|r| r.group == group && r.kind == kind).and_then(|r| {
                let obj = json!({
                    "context": context, "gvr": { "group": group, "version": version, "resource": r.resource },
                    "namespace": d["metadata"]["namespace"], "name": d["metadata"]["name"],
                });
                self.client.call("get_json", json!({ "objRef": obj })).ok()
            });
            let before = current.map(|c| edit::to_yaml(&edit::normalize(c))).unwrap_or_default();
            let after = edit::to_yaml(&edit::normalize(d.clone()));
            let body = diff::unified(&before, &after, 3);
            let state = if before.is_empty() {
                "new"
            } else if body.is_empty() {
                "unchanged"
            } else {
                "changed"
            };
            out.push((Kind::Gap, format!("── {} ({state})", edit::doc_label(d))));
            out.extend(body);
        }
        if docs.len() > 30 {
            out.push((Kind::Gap, format!("… and {} more documents", docs.len() - 30)));
        }
        out
    }

    fn review_key(&mut self, k: KeyEvent, terminal: &mut DefaultTerminal) {
        let page = terminal.size().map(|s| s.height.saturating_sub(8) as usize).unwrap_or(20).max(1);
        let Some(View::Review(r)) = self.stack.last_mut() else { return };
        let len = if r.full { r.buffer.lines().count() } else { r.diff.len() };
        let last = len.saturating_sub(1);
        match k.code {
            KeyCode::Down | KeyCode::Char('j') => r.scroll = (r.scroll + 1).min(last),
            KeyCode::Up | KeyCode::Char('k') => r.scroll = r.scroll.saturating_sub(1),
            KeyCode::PageDown | KeyCode::Char(' ') => r.scroll = (r.scroll + page).min(last),
            KeyCode::PageUp => r.scroll = r.scroll.saturating_sub(page),
            KeyCode::Char('g') | KeyCode::Home => r.scroll = 0,
            KeyCode::Char('G') | KeyCode::End => r.scroll = last,
            KeyCode::Tab => {
                r.full = !r.full;
                r.scroll = 0;
            }
            KeyCode::Enter | KeyCode::Char('a') => self.review_apply(false),
            KeyCode::Char('e') => self.review_edit(terminal),
            // a field-manager conflict on an edit is usually the server having moved on too (an
            // autoscaler, a `scale`): rebasing keeps their value where you did not change it
            KeyCode::Char('r') if r.conflict.is_some() && r.target.is_some() => self.review_rebase(terminal),
            KeyCode::Char('f') if r.conflict == Some(Conflict::FieldManager) => {
                self.overlay = Overlay::Confirm { text: "Force: take over the fields another manager owns?".into(), then: Pending::ForceApply };
            }
            KeyCode::Char('w') => {
                let name = r.label.replace(['/', ' '], "-").to_lowercase();
                let name = if name.ends_with(".yaml") || name.ends_with(".yml") { name } else { format!("{name}.yaml") };
                let text = r.buffer.clone();
                self.overlay = Overlay::Prompt { label: "Save the manifest to (a new file)".into(), input: format!("./{name}"), then: Pending::SaveManifest { text } };
            }
            _ => {}
        }
    }

    fn review_apply(&mut self, force: bool) {
        let Some(View::Review(r)) = self.stack.last() else { return };
        match &r.dry {
            Dry::Ok => {}
            Dry::Running => return self.info("the dry run is still running"),
            Dry::Failed(_) if force => {}
            Dry::Failed(_) => {
                let how = match (r.conflict, r.target.is_some()) {
                    (Some(Conflict::Version), _) => "r rebases your change on the server's version",
                    (Some(Conflict::FieldManager), true) => "r rebases on the server's version, f forces yours",
                    (Some(Conflict::FieldManager), false) => "f forces it",
                    (None, _) => "e to fix it",
                };
                return self.err(format!("the dry run failed: {how}"));
            }
        }
        let opts = if force { json!({ "force": true }) } else { json!({}) };
        let params = json!({ "context": r.context, "yaml": r.buffer, "opts": opts });
        self.apply_call(params);
    }

    /// The real apply. A protected context asks for its name and comes back here.
    fn apply_call(&mut self, params: Value) {
        match self.client.call("apply_yaml", params.clone()) {
            Ok(v) => {
                let label = match self.stack.last() {
                    Some(View::Review(r)) => r.label.clone(),
                    _ => "manifest".into(),
                };
                if matches!(self.stack.last(), Some(View::Review(_))) {
                    self.pop();
                }
                let warnings: Vec<String> = v["warnings"].as_array().into_iter().flatten().filter_map(|w| w.as_str().map(str::to_string)).collect();
                if warnings.is_empty() {
                    self.ok(format!("applied {label}"));
                } else {
                    self.status = Some((format!("applied {label} · warning: {}", warnings.join("; ")), WARN, Instant::now()));
                }
            }
            Err(e) if e.reason == "ConfirmRequired" => {
                let context = params["context"].as_str().unwrap_or(&self.context).to_string();
                self.overlay = Overlay::Protected { context, input: String::new(), method: "apply_yaml".into(), params };
            }
            Err(e) => {
                if let Some(View::Review(r)) = self.stack.last_mut() {
                    r.conflict = edit::classify(e.code as u16, &e.reason, &e.message);
                    r.dry = Dry::Failed(format!("{}: {}", e.reason, e.message));
                }
                self.err(format!("not applied: {}", e.reason));
            }
        }
    }

    /// `e` in the review: the buffer back in the editor, with the last error on top.
    fn review_edit(&mut self, terminal: &mut DefaultTerminal) {
        let Some(View::Review(r)) = self.stack.last() else { return };
        let error = match &r.dry {
            Dry::Failed(m) => Some(m.clone()),
            _ => None,
        };
        let (buffer, label, context) = (r.buffer.clone(), r.label.clone(), r.context.clone());
        let header = edit::header(&format!("Editing {label}"), &context, error.as_deref());
        let Some(text) = self.run_editor(terminal, &buffer, &label, &header) else { return self.info("kept the last version") };
        let Some(View::Review(r)) = self.stack.last_mut() else { return };
        if r.source == Source::Edit && text == r.original {
            self.pop();
            return self.info("no changes left");
        }
        r.buffer = text;
        self.review_changed();
    }

    /// The object changed on the server: replay the edit onto the new version (three-way).
    fn review_rebase(&mut self, terminal: &mut DefaultTerminal) {
        let Some(View::Review(r)) = self.stack.last() else { return };
        let Some(target) = r.target.clone() else { return };
        let (original, buffer, label, context) = (r.original.clone(), r.buffer.clone(), r.label.clone(), r.context.clone());
        let fresh = match self.client.call("get_yaml", json!({ "objRef": target, "managedFields": false })) {
            Ok(Value::String(s)) => s,
            Ok(_) => return,
            Err(e) => return self.err(format!("{}: {}", e.reason, e.message)),
        };
        let (mut merged, conflicts) = diff::merge3(&original, &buffer, &fresh);
        if conflicts > 0 {
            let note = format!("{conflicts} of your changes overlap with changes on the server: keep one side of each marked block");
            let header = edit::header(&format!("Rebasing {label}"), &context, Some(&note));
            if let Some(t) = self.run_editor(terminal, &merged, &label, &header) {
                merged = t;
            }
        } else if merged == fresh {
            self.pop();
            return self.info("nothing left to apply: the server already has these changes");
        }
        let Some(View::Review(r)) = self.stack.last_mut() else { return };
        r.original = fresh;
        r.buffer = merged;
        self.review_changed();
        if conflicts == 0 {
            self.info("rebased on the server's version");
        }
    }

    // ───────────── set image, history ─────────────

    fn set_image(&mut self, res: &Res, obj: Value, label: String) {
        let base = match res.resource.as_str() {
            "pods" => "/spec",
            "cronjobs" => "/spec/jobTemplate/spec/template/spec",
            _ => "/spec/template/spec",
        };
        let o = match self.client.call("get_json", json!({ "objRef": obj })) {
            Ok(o) => o,
            Err(e) => return self.err(e.message),
        };
        let containers: Vec<(String, String)> = o
            .pointer(&format!("{base}/containers"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|c| (c["name"].as_str().unwrap_or_default().to_string(), c["image"].as_str().unwrap_or_default().to_string()))
            .collect();
        if containers.is_empty() {
            return self.err(format!("{label} has no containers"));
        }
        let (prompt, input) = if containers.len() == 1 {
            (format!("Image of {label} (container {})", containers[0].0), containers[0].1.clone())
        } else {
            (format!("Images of {label}: container=image …"), containers.iter().map(|(c, i)| format!("{c}={i}")).collect::<Vec<_>>().join(" "))
        };
        self.overlay = Overlay::Prompt { label: prompt, input, then: Pending::SetImage { obj, label, base: base.into(), containers } };
    }

    fn history(&mut self, res: &Res, obj: Value, label: String) {
        self.epoch += 1;
        let epoch = self.epoch;
        self.push(View::Revisions(RevisionsView { label, target: obj.clone(), deployment: res.is("apps", "deployments"), list: vec![], cursor: 0, loading: true, epoch }));
        self.client.send(Tag { kind: "revisions", epoch }, "revisions", json!({ "objRef": obj }));
    }

    fn revisions_key(&mut self, k: KeyEvent) {
        let Some(View::Revisions(r)) = self.stack.last_mut() else { return };
        let last = r.list.len().saturating_sub(1);
        match k.code {
            KeyCode::Down | KeyCode::Char('j') => r.cursor = (r.cursor + 1).min(last),
            KeyCode::Up | KeyCode::Char('k') => r.cursor = r.cursor.saturating_sub(1),
            KeyCode::Char('g') | KeyCode::Home => r.cursor = 0,
            KeyCode::Char('G') | KeyCode::End => r.cursor = last,
            KeyCode::Enter => {
                let Some(rev) = r.list.get(r.cursor).cloned() else { return };
                let (target, label, deployment) = (r.target.clone(), r.label.clone(), r.deployment);
                let n = rev["revision"].as_i64().unwrap_or(0);
                let template = rev.get("template").cloned().unwrap_or(Value::Null);
                let lines = if deployment && !template.is_null() {
                    match self.client.call("get_json", json!({ "objRef": target })) {
                        Ok(cur) => {
                            let mut running = cur["spec"]["template"].clone();
                            if let Some(l) = running.pointer_mut("/metadata/labels").and_then(Value::as_object_mut) {
                                l.remove("pod-template-hash");
                            }
                            let d = diff::unified(&edit::to_yaml(&running), &edit::to_yaml(&template), 3);
                            if d.is_empty() {
                                vec![Line::from(Span::styled(format!("revision {n} is what runs now"), Style::new().fg(OK)))]
                            } else {
                                let mut out = vec![Line::from(Span::styled(format!("running → revision {n}  (what a roll back to it changes)"), Style::new().fg(DIM))), Line::from("")];
                                out.extend(d.iter().map(diff_line));
                                out
                            }
                        }
                        Err(e) => vec![Line::from(Span::styled(e.message, Style::new().fg(BAD)))],
                    }
                } else if template.is_null() {
                    vec![Line::from(Span::styled("this revision keeps no template (Helm release data is not read)", Style::new().fg(DIM)))]
                } else {
                    yaml_lines(&edit::to_yaml(&template))
                };
                self.epoch += 1;
                let epoch = self.epoch;
                self.push(View::Text(TextView { title: format!("revision {n} · {label}"), lines, scroll: 0, epoch }));
            }
            KeyCode::Char('u') if r.deployment => {
                let Some(rev) = r.list.get(r.cursor) else { return };
                if r.cursor == 0 {
                    return self.info("that revision is the one running");
                }
                let Some(template) = rev.get("template").cloned() else { return self.err("this revision keeps no template") };
                let revision = rev["revision"].as_i64().unwrap_or(0);
                let (obj, label) = (r.target.clone(), r.label.clone());
                self.overlay = Overlay::Confirm { text: format!("Roll {label} back to revision {revision}?"), then: Pending::Rollback { obj, label, revision, template } };
            }
            _ => {}
        }
    }

    /// Pod and node metrics for the table on top, every 15 s while it is shown.
    fn poll_metrics(&mut self) {
        if !self.has_metrics {
            return;
        }
        let context = self.context.clone();
        let Some(View::Table(t)) = self.stack.last_mut() else { return };
        let (pods, nodes) = (t.res.is("", "pods"), t.res.is("", "nodes"));
        if !(pods || nodes) || t.metrics_at.is_some_and(|at| at.elapsed() < Duration::from_secs(15)) {
            return;
        }
        t.metrics_at = Some(Instant::now());
        let tag = Tag { kind: "metrics", epoch: t.epoch };
        if pods {
            self.client.send(tag, "pod_metrics", json!({ "context": context, "namespace": t.namespace }));
        } else {
            self.client.send(tag, "node_metrics", json!({ "context": context }));
        }
    }

    // ───────────── herdr sidebar ─────────────

    fn report_health(&mut self) {
        let Some(h) = self.herdr.clone() else { return };
        if !h.is_plugin() {
            return;
        }
        let Some(View::Table(t)) = self.stack.first() else { return };
        if t.table.state != "live" || !t.res.is("", "pods") {
            return;
        }
        let bad = t.table.rows.iter().filter(|r| model::row_health(&t.table, r) == Health::Bad).count();
        let warn = t.table.rows.iter().filter(|r| model::row_health(&t.table, r) == Health::Warn).count();
        let ns = t.namespace.clone().unwrap_or_else(|| "*".into());
        let mut token = format!("{}/{ns} {}", self.context, t.table.rows.len());
        if bad > 0 {
            token.push_str(&format!(" ✗{bad}"));
        }
        if warn > 0 {
            token.push_str(&format!(" ~{warn}"));
        }
        let due = match &self.last_report {
            Some((last, at)) => *last != token || at.elapsed() > Duration::from_secs(60),
            None => true,
        };
        if due {
            self.last_report = Some((token.clone(), Instant::now()));
            std::thread::spawn(move || h.report(Some(&token)));
        }
    }

    // ───────────── drawing ─────────────

    fn draw(&mut self, f: &mut Frame) {
        let [head, body, foot] = Layout::vertical([Constraint::Length(1), Constraint::Min(1), Constraint::Length(1)]).areas(f.area());
        self.draw_head(f, head);
        let now = jiff::Timestamp::now();
        match self.stack.last_mut() {
            Some(View::Table(t)) => draw_table(f, body, t, now),
            Some(View::Text(t)) => draw_text(f, body, t),
            Some(View::Logs(l)) => draw_logs(f, body, l),
            Some(View::Forwards(v)) => draw_forwards(f, body, v),
            Some(View::Review(r)) => draw_review(f, body, r),
            Some(View::Revisions(r)) => draw_revisions(f, body, r),
            None => {}
        }
        self.draw_foot(f, foot);
        self.draw_overlay(f);
    }

    fn draw_head(&self, f: &mut Frame, area: Rect) {
        let mut spans = vec![Span::styled(" kns ", Style::new().fg(Color::Black).bg(ACCENT).bold()), Span::raw(" ")];
        spans.push(Span::styled(if self.context.is_empty() { "…".to_string() } else { self.context.clone() }, Style::new().fg(ACCENT).bold()));
        if let Some(View::Table(t)) = self.stack.iter().rev().find(|v| matches!(v, View::Table(_))) {
            spans.push(Span::styled(" › ", Style::new().fg(DIM)));
            spans.push(Span::raw(if t.res.namespaced { t.namespace.clone().unwrap_or_else(|| "all namespaces".into()) } else { "cluster".into() }));
        }
        if !self.server.is_empty() {
            spans.push(Span::styled(format!("  {}", self.server), Style::new().fg(DIM)));
        }
        let left = Line::from(spans);
        let mut right = vec![];
        if let Some(h) = &self.herdr {
            right.push(Span::styled(if h.is_plugin() { "herdr ✓ " } else if h.is_app() { "Herdr " } else { "herdr " }, Style::new().fg(DIM)));
        }
        right.push(Span::styled("? help ", Style::new().fg(DIM)));
        f.render_widget(Paragraph::new(left), area);
        f.render_widget(Paragraph::new(Line::from(right)).right_aligned(), area);
    }

    fn draw_foot(&self, f: &mut Frame, area: Rect) {
        let line = match &self.input {
            Input::Command(s) => Line::from(vec![Span::styled(":", Style::new().fg(ACCENT).bold()), Span::raw(s.clone()), Span::styled("█", Style::new().fg(ACCENT))]),
            Input::Filter(s) => Line::from(vec![Span::styled("/", Style::new().fg(ACCENT).bold()), Span::raw(s.clone()), Span::styled("█", Style::new().fg(ACCENT))]),
            Input::None => match &self.status {
                Some((text, color, at)) if at.elapsed() < Duration::from_secs(8) => Line::from(Span::styled(format!(" {text}"), Style::new().fg(*color))),
                _ => Line::from(Span::styled(format!(" {}", self.hints()), Style::new().fg(DIM))),
            },
        };
        f.render_widget(Paragraph::new(line), area);
    }

    fn hints(&self) -> String {
        match self.stack.last() {
            Some(View::Table(t)) => {
                let mut h = vec!["⏎ open", "y yaml", "e edit", "d why", "E events"];
                if t.res.is("", "pods") {
                    h.extend(["l logs", "s shell", "F forward", "o sort"]);
                } else if ["deployments", "statefulsets", "daemonsets"].contains(&t.res.resource.as_str()) {
                    h.extend(["l logs", "s shell", "r restart", "S scale", "i image", "h history"]);
                } else if ["replicasets", "jobs"].contains(&t.res.resource.as_str()) {
                    h.extend(["l logs", "s shell", "r restart"]);
                } else if t.res.is("", "services") {
                    h.push("F forward");
                } else if t.res.is("", "secrets") {
                    h.push("x decode");
                } else if t.res.is("batch", "cronjobs") {
                    h.push("t run now");
                }
                h.extend(["D delete", "/ filter", ": resource", "c ctx", "n ns"]);
                h.join("  ")
            }
            Some(View::Logs(_)) => "j/k scroll  G follow  w wrap  / filter  C clear  q back".into(),
            Some(View::Text(_)) => "j/k scroll  g/G top/bottom  q back".into(),
            Some(View::Forwards(_)) => "⏎/o open  x stop  q back".into(),
            Some(View::Review(r)) => {
                let mut h = vec!["⏎ apply", "e edit again"];
                if r.conflict.is_some() && r.target.is_some() {
                    h.push("r rebase on the server's version");
                }
                if r.conflict == Some(Conflict::FieldManager) {
                    h.push("f force");
                }
                h.extend(["tab diff/manifest", "j/k scroll", "w save to file", "q discard"]);
                h.join("  ")
            }
            Some(View::Revisions(r)) => {
                if r.deployment { "⏎ diff with the running version  u roll back  q back".into() } else { "⏎ show  q back".into() }
            }
            None => String::new(),
        }
    }

    fn draw_overlay(&self, f: &mut Frame) {
        let area = f.area();
        match &self.overlay {
            Overlay::None => {}
            Overlay::Help => {
                let r = centered(area, 80, 40);
                f.render_widget(Clear, r);
                f.render_widget(Paragraph::new(help_lines()).block(panel("keys")).wrap(Wrap { trim: false }), r);
            }
            Overlay::Picker { kind, items, filter, cursor } => {
                let title = match kind {
                    PickKind::Context => "context",
                    PickKind::Namespace => "namespace",
                    PickKind::Resource => "resource",
                };
                let r = centered(area, 60, 20);
                f.render_widget(Clear, r);
                let block = panel(title);
                let inner = block.inner(r);
                f.render_widget(block, r);
                let [input, list] = Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).areas(inner);
                f.render_widget(Paragraph::new(Line::from(vec![Span::styled("› ", Style::new().fg(ACCENT)), Span::raw(filter.clone()), Span::styled("█", Style::new().fg(ACCENT))])), input);
                let shown: Vec<&String> = items.iter().filter(|i| fuzzy(i, filter)).collect();
                let h = list.height as usize;
                let off = cursor.saturating_sub(h.saturating_sub(1));
                let lines: Vec<Line> = shown
                    .iter()
                    .enumerate()
                    .skip(off)
                    .take(h)
                    .map(|(i, s)| {
                        let current = matches!(kind, PickKind::Context) && **s == self.context;
                        let st = if i == *cursor { Style::new().bg(ACCENT).fg(Color::Black) } else if current { Style::new().fg(ACCENT) } else { Style::new() };
                        Line::from(Span::styled(format!(" {s} "), st))
                    })
                    .collect();
                f.render_widget(Paragraph::new(lines), list);
            }
            Overlay::Confirm { text, .. } => {
                let r = centered(area, (text.chars().count() as u16 + 8).max(36), 5);
                f.render_widget(Clear, r);
                let lines = vec![Line::from(text.clone()).bold(), Line::from(""), Line::from(Span::styled("y / ⏎ yes    n / esc no", Style::new().fg(DIM)))];
                f.render_widget(Paragraph::new(lines).block(panel("confirm")), r);
            }
            Overlay::Prompt { label, input, .. } => {
                let r = centered(area, (label.chars().count() as u16 + 8).max(40), 5);
                f.render_widget(Clear, r);
                let lines = vec![Line::from(label.clone()), Line::from(vec![Span::styled("› ", Style::new().fg(ACCENT)), Span::raw(input.clone()), Span::styled("█", Style::new().fg(ACCENT))])];
                f.render_widget(Paragraph::new(lines).block(panel("input")), r);
            }
            Overlay::Protected { context, input, .. } => {
                let r = centered(area, 60, 6);
                f.render_widget(Clear, r);
                let lines = vec![
                    Line::from(Span::styled(format!("\"{context}\" is a protected context."), Style::new().fg(WARN).bold())),
                    Line::from("Type its name to go ahead:"),
                    Line::from(vec![Span::styled("› ", Style::new().fg(ACCENT)), Span::raw(input.clone()), Span::styled("█", Style::new().fg(ACCENT))]),
                ];
                f.render_widget(Paragraph::new(lines).block(panel("protected")), r);
            }
        }
    }
}

trait ResExt {
    fn singular_or_kind(&self) -> String;
}

impl ResExt for Res {
    fn singular_or_kind(&self) -> String {
        if !self.singular.is_empty() {
            self.singular.clone()
        } else if !self.kind.is_empty() {
            self.kind.to_lowercase()
        } else {
            self.resource.clone()
        }
    }
}

fn target_env(t: &herdr::Target) -> Vec<(&'static str, String)> {
    let mut env = vec![];
    for (k, v) in [("KNS_CONTEXT", &t.context), ("KNS_NAMESPACE", &t.namespace), ("KNS_POD", &t.pod), ("KNS_CONTAINER", &t.container), ("KNS_WORKLOAD", &t.workload)] {
        if let Some(v) = v {
            env.push((k, v.clone()));
        }
    }
    env
}

fn fuzzy(item: &str, filter: &str) -> bool {
    let item = item.to_lowercase();
    let mut chars = item.chars();
    filter.to_lowercase().chars().all(|c| chars.any(|i| i == c))
}

fn panel(title: &str) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(ACCENT))
        .title(Span::styled(format!(" {title} "), Style::new().fg(ACCENT).bold()))
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width.saturating_sub(2));
    let h = h.min(area.height.saturating_sub(2));
    Rect { x: area.x + (area.width - w) / 2, y: area.y + (area.height - h) / 3, width: w, height: h }
}

// ───────────────────────── view drawing ─────────────────────────

fn state_span(state: &str, message: Option<&str>) -> Span<'static> {
    let (glyph, color) = match state {
        "live" => ("● live", OK),
        "syncing" => ("◌ syncing", DIM),
        "reconnecting" => ("◌ reconnecting", WARN),
        "forbidden" => ("✗ forbidden", BAD),
        "error" => ("✗ error", BAD),
        _ => ("◌", DIM),
    };
    let text = match message {
        Some(m) if state != "live" => {
            // the whole message is shown in the body; the title keeps one short line
            let m = m.lines().next().unwrap_or_default();
            let short: String = m.chars().take(60).collect();
            format!("{glyph}: {short}{}", if m.chars().count() > 60 { "…" } else { "" })
        }
        _ => glyph.to_string(),
    };
    Span::styled(text, Style::new().fg(color))
}

fn draw_table(f: &mut Frame, area: Rect, t: &mut TableView, now: jiff::Timestamp) {
    let vis = t.visible();
    let mut title = vec![Span::styled(format!(" {} ", t.res.label()), Style::new().bold())];
    if let Some(s) = &t.scope {
        title.push(Span::styled(format!("{s} "), Style::new().fg(ACCENT)));
    } else if let Some(sel) = &t.selector {
        title.push(Span::styled(format!("{sel} "), Style::new().fg(ACCENT)));
    }
    title.push(Span::styled(format!("[{}{}] ", vis.len(), if t.filter.is_empty() { String::new() } else { format!("/{}", t.table.rows.len()) }), Style::new().fg(DIM)));
    if !t.filter.is_empty() {
        title.push(Span::styled(format!("/{} ", t.filter), Style::new().fg(WARN)));
    }
    if t.sort != Sort::Name {
        title.push(Span::styled(format!("{} ", t.sort.label()), Style::new().fg(Color::Cyan)));
    }
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::new().fg(DIM))
        .title(Line::from(title))
        .title(Line::from(vec![state_span(&t.table.state, t.table.message.as_deref()), Span::raw(" ")]).right_aligned());
    let inner = block.inner(area);
    f.render_widget(block, area);

    if t.table.rows.is_empty() {
        let msg = match t.table.state.as_str() {
            "syncing" => "loading…".to_string(),
            "live" => "nothing here".to_string(),
            s => t.table.message.clone().unwrap_or_else(|| s.to_string()),
        };
        f.render_widget(Paragraph::new(Span::styled(format!("  {msg}"), Style::new().fg(DIM))).wrap(Wrap { trim: false }), inner);
        return;
    }

    let all_ns = t.res.namespaced && t.namespace.is_none();
    // columns: [Namespace] Name + server columns (Name first, Age computed locally)
    let mut headers: Vec<String> = vec![];
    if all_ns {
        headers.push("NAMESPACE".into());
    }
    let cols: Vec<&model::Column> = t.table.columns.iter().collect();
    for c in &cols {
        headers.push(c.name.to_uppercase());
    }
    let nodes = t.res.is("", "nodes");
    let with_metrics = !t.metrics.is_empty();
    if with_metrics {
        headers.extend(if nodes { vec!["CPU".to_string(), "%CPU".into(), "MEM".into(), "%MEM".into()] } else { vec!["CPU".to_string(), "MEM".into()] });
    }
    let height = inner.height.saturating_sub(1) as usize;
    if t.cursor < t.offset {
        t.offset = t.cursor;
    } else if height > 0 && t.cursor >= t.offset + height {
        t.offset = t.cursor + 1 - height;
    }
    let rows: Vec<(Vec<String>, Health, bool)> = vis
        .iter()
        .skip(t.offset)
        .take(height)
        .map(|&i| {
            let r = &t.table.rows[i];
            let mut cells = vec![];
            if all_ns {
                cells.push(r.namespace.clone().unwrap_or_default());
            }
            for c in &cols {
                let v = if c.name.eq_ignore_ascii_case("age") { r.created.as_deref().map(|cr| model::age(cr, now)).unwrap_or_default() } else { r.cells.get(c.index).cloned().unwrap_or_default() };
                cells.push(v);
            }
            if with_metrics {
                match t.metrics.get(&metrics_key(r.namespace.as_deref(), &r.name)) {
                    Some(&(cpu, mem, cpu_alloc, mem_alloc)) => {
                        cells.push(model::fmt_cpu(cpu));
                        if nodes {
                            cells.push(model::percent(cpu, cpu_alloc));
                        }
                        cells.push(model::fmt_mem(mem));
                        if nodes {
                            cells.push(model::percent(mem, mem_alloc));
                        }
                    }
                    None => cells.extend(std::iter::repeat_n(String::new(), if nodes { 4 } else { 2 })),
                }
            }
            (cells, model::row_health(&t.table, r), r.deleting)
        })
        .collect();
    let mut widths: Vec<u16> = headers.iter().map(|h| h.chars().count() as u16).collect();
    for (cells, _, _) in &rows {
        for (i, c) in cells.iter().enumerate() {
            if let Some(w) = widths.get_mut(i) {
                *w = (*w).max(c.chars().count().min(60) as u16);
            }
        }
    }
    let header = TRow::new(headers.into_iter().map(|h| Cell::from(h).style(Style::new().fg(DIM).bold())));
    let status_col = t.table.column("Status").and_then(|si| cols.iter().position(|c| c.index == si)).map(|p| p + usize::from(all_ns));
    let trows: Vec<TRow> = rows
        .into_iter()
        .enumerate()
        .map(|(i, (cells, health, deleting))| {
            let selected = t.offset + i == t.cursor;
            let mut style = Style::new().fg(health_color(health));
            if deleting {
                style = style.add_modifier(Modifier::CROSSED_OUT | Modifier::DIM);
            }
            if selected {
                style = style.bg(Color::Rgb(60, 45, 40)).add_modifier(Modifier::BOLD);
            }
            let cells: Vec<Cell> = cells
                .into_iter()
                .enumerate()
                .map(|(ci, c)| {
                    let cell = Cell::from(c);
                    if Some(ci) == status_col && health != Health::Ok { cell.style(Style::new().fg(health_color(health)).bold()) } else { cell }
                })
                .collect();
            TRow::new(cells).style(style)
        })
        .collect();
    let constraints: Vec<Constraint> = widths.iter().map(|w| Constraint::Length(*w)).collect();
    f.render_widget(TTable::new(trows, constraints).header(header).column_spacing(2), inner);
}

fn draw_text(f: &mut Frame, area: Rect, t: &TextView) {
    let block = Block::default().borders(Borders::TOP).border_style(Style::new().fg(DIM)).title(Span::styled(format!(" {} ", t.title), Style::new().bold()));
    let lines: Vec<Line> = t.lines.iter().skip(t.scroll).cloned().collect();
    f.render_widget(Paragraph::new(lines).block(block).wrap(Wrap { trim: false }), area);
}

fn level_color(level: Option<&str>) -> Color {
    match level {
        Some("error") | Some("fatal") => BAD,
        Some("warn") => WARN,
        Some("debug") | Some("trace") => DIM,
        _ => Color::Reset,
    }
}

fn draw_logs(f: &mut Frame, area: Rect, l: &LogsView) {
    let mut title = vec![Span::styled(format!(" {} ", l.title), Style::new().bold())];
    if l.targets > 1 {
        title.push(Span::styled(format!("{} containers ", l.targets), Style::new().fg(DIM)));
    }
    if !l.filter.is_empty() {
        title.push(Span::styled(format!("/{} ", l.filter), Style::new().fg(WARN)));
    }
    let state = if l.targets > 0 && l.ended >= l.targets {
        Span::styled("■ ended ", Style::new().fg(DIM))
    } else if l.follow {
        Span::styled("● following ", Style::new().fg(OK))
    } else {
        Span::styled("❚❚ paused (G to follow) ", Style::new().fg(WARN))
    };
    let block = Block::default().borders(Borders::TOP).border_style(Style::new().fg(DIM)).title(Line::from(title)).title(Line::from(state).right_aligned());
    let inner = block.inner(area);
    f.render_widget(block, area);
    let filter = l.filter.to_lowercase();
    let shown: Vec<&LogLine> = l.lines.iter().filter(|x| filter.is_empty() || x.text.to_lowercase().contains(&filter)).collect();
    let h = inner.height as usize;
    let end = shown.len().saturating_sub(l.scroll.min(shown.len()));
    let start = end.saturating_sub(h);
    let lines: Vec<Line> = shown[start..end]
        .iter()
        .map(|x| {
            let mut spans = vec![];
            if l.multi {
                spans.push(Span::styled(format!("{}/{} ", short_pod(&x.pod), x.container), Style::new().fg(pod_color(&x.pod))));
            }
            spans.push(Span::styled(x.text.clone(), Style::new().fg(level_color(x.level.as_deref()))));
            Line::from(spans)
        })
        .collect();
    let mut p = Paragraph::new(lines);
    if l.wrap {
        p = p.wrap(Wrap { trim: false });
    }
    if shown.is_empty() {
        p = Paragraph::new(Span::styled("  waiting for lines…", Style::new().fg(DIM)));
    }
    f.render_widget(p, inner);
}

fn short_pod(pod: &str) -> &str {
    // web-7d9f8b6c5-x2k4q -> x2k4q
    pod.rsplit('-').next().unwrap_or(pod)
}

fn pod_color(pod: &str) -> Color {
    const C: [Color; 6] = [Color::Cyan, Color::Magenta, Color::Blue, Color::Green, Color::LightYellow, Color::LightRed];
    C[pod.bytes().fold(0usize, |a, b| a.wrapping_mul(31).wrapping_add(b as usize)) % C.len()]
}

fn draw_forwards(f: &mut Frame, area: Rect, v: &ForwardsView) {
    let block = Block::default().borders(Borders::TOP).border_style(Style::new().fg(DIM)).title(Span::styled(format!(" port-forwards [{}] ", v.list.len()), Style::new().bold()));
    let inner = block.inner(area);
    f.render_widget(block, area);
    if v.list.is_empty() {
        f.render_widget(Paragraph::new(Span::styled("  no port-forwards; F on a pod, service or workload starts one", Style::new().fg(DIM))), inner);
        return;
    }
    let header = TRow::new(["LOCAL", "TARGET", "REMOTE", "CONTEXT", "CONNS", "STATUS"].map(|h| Cell::from(h).style(Style::new().fg(DIM).bold())));
    let rows: Vec<TRow> = v
        .list
        .iter()
        .enumerate()
        .map(|(i, fw)| {
            let status = fw["status"].as_str().unwrap_or_default();
            let color = match status {
                "active" | "ready" | "running" => OK,
                "error" | "failed" => BAD,
                _ => WARN,
            };
            let mut st = Style::new();
            if i == v.cursor {
                st = st.bg(Color::Rgb(60, 45, 40)).bold();
            }
            TRow::new(vec![
                Cell::from(format!("{}:{}", fw["address"].as_str().unwrap_or("127.0.0.1"), fw["localPort"])),
                Cell::from(format!("{}/{}", fw["namespace"].as_str().unwrap_or_default(), fw["target"]["name"].as_str().or(fw["pod"].as_str()).unwrap_or_default())),
                Cell::from(model::cell_text(&fw["remotePort"])),
                Cell::from(fw["context"].as_str().unwrap_or_default().to_string()),
                Cell::from(fw["connections"].to_string()),
                Cell::from(Span::styled(status.to_string(), Style::new().fg(color))),
            ])
            .style(st)
        })
        .collect();
    let widths = [Constraint::Length(22), Constraint::Min(20), Constraint::Length(8), Constraint::Length(20), Constraint::Length(6), Constraint::Length(10)];
    f.render_widget(TTable::new(rows, widths).header(header).column_spacing(2), inner);
}

fn diff_line(d: &(Kind, String)) -> Line<'static> {
    match d.0 {
        Kind::Add => Line::from(Span::styled(format!("+ {}", d.1), Style::new().fg(OK))),
        Kind::Del => Line::from(Span::styled(format!("- {}", d.1), Style::new().fg(BAD))),
        Kind::Same => Line::from(Span::styled(format!("  {}", d.1), Style::new().fg(DIM))),
        Kind::Gap => Line::from(Span::styled(d.1.clone(), Style::new().fg(Color::Cyan).bold())),
    }
}

fn draw_review(f: &mut Frame, area: Rect, r: &ReviewView) {
    let (adds, dels) = diff::stat(&r.diff);
    let mut title = vec![Span::styled(format!(" {} ", r.title), Style::new().bold())];
    if r.source == Source::Edit || adds + dels > 0 {
        title.push(Span::styled(format!("+{adds} "), Style::new().fg(OK)));
        title.push(Span::styled(format!("-{dels} "), Style::new().fg(BAD)));
    }
    title.push(Span::styled(format!("in {} ", r.context), Style::new().fg(ACCENT)));
    let block = Block::default().borders(Borders::TOP).border_style(Style::new().fg(DIM)).title(Line::from(title)).title(
        Line::from(Span::styled(if r.full { " manifest (tab: diff) " } else { " diff (tab: manifest) " }, Style::new().fg(DIM))).right_aligned(),
    );
    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut head: Vec<Line> = vec![];
    match &r.dry {
        Dry::Running => head.push(Line::from(Span::styled("◌ dry run on the server…", Style::new().fg(DIM)))),
        Dry::Ok => head.push(Line::from(vec![
            Span::styled("✓ the server accepts this change (dry run)", Style::new().fg(OK).bold()),
            Span::styled("   ⏎ apply", Style::new().fg(DIM)),
        ])),
        Dry::Failed(m) => {
            let hint = match (r.conflict, r.target.is_some()) {
                (Some(Conflict::Version), true) => "the object changed since you started: r rebases your change on it",
                (Some(Conflict::FieldManager), true) => {
                    "another field manager changed some of these fields: r rebases on the server's version (keeps theirs where you did not edit), f takes them over"
                }
                (Some(Conflict::FieldManager), false) => "another field manager owns some of these fields: f takes them over",
                _ => "e to fix it in the editor",
            };
            head.push(Line::from(Span::styled(format!("✗ {hint}"), Style::new().fg(BAD).bold())));
            for l in m.lines().take(4) {
                head.push(Line::from(Span::styled(format!("  {l}"), Style::new().fg(BAD))));
            }
        }
    }
    for w in &r.warnings {
        head.push(Line::from(Span::styled(format!("! {w}"), Style::new().fg(WARN))));
    }
    if let Some(o) = &r.owner {
        head.push(Line::from(Span::styled(format!("! managed by {o}: it will put its own version back unless you change the source"), Style::new().fg(WARN))));
    }
    let [top, body] = Layout::vertical([Constraint::Length(head.len() as u16 + 1), Constraint::Min(1)]).areas(inner);
    f.render_widget(Paragraph::new(head).wrap(Wrap { trim: false }), top);
    let lines: Vec<Line> = if r.full {
        yaml_lines(&r.buffer).into_iter().skip(r.scroll).take(body.height as usize).collect()
    } else if r.diff.is_empty() {
        vec![Line::from(Span::styled("no changes", Style::new().fg(DIM)))]
    } else {
        r.diff.iter().skip(r.scroll).take(body.height as usize).map(diff_line).collect()
    };
    f.render_widget(Paragraph::new(lines), body);
}

fn draw_revisions(f: &mut Frame, area: Rect, v: &RevisionsView) {
    let block = Block::default().borders(Borders::TOP).border_style(Style::new().fg(DIM)).title(Span::styled(format!(" history · {} [{}] ", v.label, v.list.len()), Style::new().bold()));
    let inner = block.inner(area);
    f.render_widget(block, area);
    if v.list.is_empty() {
        let msg = if v.loading { "loading…" } else { "no revisions" };
        f.render_widget(Paragraph::new(Span::styled(format!("  {msg}"), Style::new().fg(DIM))), inner);
        return;
    }
    let now = jiff::Timestamp::now();
    let header = TRow::new(["REVISION", "AGE", "IMAGE", ""].map(|h| Cell::from(h).style(Style::new().fg(DIM).bold())));
    let h = inner.height.saturating_sub(1) as usize;
    let off = v.cursor.saturating_sub(h.saturating_sub(1));
    let rows: Vec<TRow> = v
        .list
        .iter()
        .enumerate()
        .skip(off)
        .take(h)
        .map(|(i, rev)| {
            let mut st = if i == 0 { Style::new().fg(OK) } else { Style::new() };
            if i == v.cursor {
                st = st.bg(Color::Rgb(60, 45, 40)).bold();
            }
            TRow::new(vec![
                Cell::from(rev["revision"].to_string()),
                Cell::from(rev["createdAt"].as_str().map(|c| model::age(c, now)).unwrap_or_default()),
                Cell::from(rev["image"].as_str().unwrap_or_default().to_string()),
                Cell::from(if i == 0 { "running" } else { "" }),
            ])
            .style(st)
        })
        .collect();
    let widths = [Constraint::Length(9), Constraint::Length(6), Constraint::Min(20), Constraint::Length(8)];
    f.render_widget(TTable::new(rows, widths).header(header).column_spacing(2), inner);
}

/// `namespaces "x" not found` → `x`.
fn missing_namespace(message: &str) -> Option<String> {
    let rest = message.split("namespaces \"").nth(1)?;
    let (ns, tail) = rest.split_once('"')?;
    tail.trim_start().starts_with("not found").then(|| ns.to_string())
}

fn expand_home(p: &str) -> std::path::PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| p.into()),
        None => p.into(),
    }
}

/// An `EnvReport` (contract/dev.rs): the container's resolved environment, values redacted.
fn env_lines(v: &Value) -> Vec<Line<'static>> {
    let mut out = vec![];
    let containers: Vec<String> = v["containers"].as_array().into_iter().flatten().filter_map(|c| c.as_str().map(str::to_string)).collect();
    out.push(Line::from(vec![
        Span::styled(format!("container {}", v["container"].as_str().unwrap_or_default()), Style::new().bold()),
        Span::styled(if containers.len() > 1 { format!("  (of {})", containers.join(", ")) } else { String::new() }, Style::new().fg(DIM)),
    ]));
    out.push(Line::from(""));
    let rows = v["rows"].as_array().cloned().unwrap_or_default();
    let width = rows.iter().filter_map(|r| r["key"].as_str()).map(|k| k.chars().count()).max().unwrap_or(0).min(40);
    for r in &rows {
        let key = r["key"].as_str().unwrap_or_default();
        let source = r["source"].as_str().unwrap_or_default();
        let value = match (r["value"].as_str(), r["masked"].as_bool().unwrap_or(false)) {
            (Some(v), _) => v.to_string(),
            (None, true) => "•••".into(),
            (None, false) => String::new(),
        };
        let from = r["from"].as_str().map(|f| format!("  ← {source} {f}")).unwrap_or_else(|| if source == "literal" { String::new() } else { format!("  ← {source}") });
        out.push(Line::from(vec![
            Span::styled(format!("{key:<width$} "), Style::new().fg(Color::Cyan)),
            Span::raw(value),
            Span::styled(from, Style::new().fg(DIM)),
        ]));
    }
    if rows.is_empty() {
        out.push(Line::from(Span::styled("no environment variables", Style::new().fg(DIM))));
    }
    for w in v["warnings"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        out.push(Line::from(Span::styled(format!("! {w}"), Style::new().fg(WARN))));
    }
    out
}

// ───────────────────────── text content ─────────────────────────

fn yaml_lines(text: &str) -> Vec<Line<'static>> {
    text.lines()
        .map(|l| {
            let trimmed = l.trim_start();
            let indent = &l[..l.len() - trimmed.len()];
            let body = trimmed.strip_prefix("- ").map(|b| (format!("{indent}- "), b)).unwrap_or((indent.to_string(), trimmed));
            match body.1.split_once(':') {
                Some((k, v)) if !k.contains(' ') || k.starts_with('"') => Line::from(vec![
                    Span::raw(body.0),
                    Span::styled(k.to_string(), Style::new().fg(Color::Cyan)),
                    Span::styled(":".to_string(), Style::new().fg(DIM)),
                    Span::raw(v.to_string()),
                ]),
                _ => Line::from(l.to_string()),
            }
        })
        .collect()
}

fn why_lines(d: &Value) -> Vec<Line<'static>> {
    let mut out = vec![];
    let findings = d["findings"].as_array().cloned().unwrap_or_default();
    if findings.is_empty() {
        out.push(Line::from(Span::styled("✓ nothing looks wrong", Style::new().fg(OK).bold())));
    }
    for f in findings {
        let sev = f["severity"].as_str().unwrap_or("info");
        let (glyph, color) = match sev {
            "error" | "critical" => ("✗", BAD),
            "warning" | "warn" => ("!", WARN),
            _ => ("i", Color::Cyan),
        };
        out.push(Line::from(vec![Span::styled(format!("{glyph} "), Style::new().fg(color).bold()), Span::styled(f["title"].as_str().unwrap_or_default().to_string(), Style::new().bold())]));
        if let Some(detail) = f["detail"].as_str() {
            for l in detail.lines() {
                out.push(Line::from(format!("    {l}")));
            }
        }
        for e in f["evidence"].as_array().into_iter().flatten() {
            for l in evidence_text(e).lines().take(12) {
                out.push(Line::from(Span::styled(format!("    │ {l}"), Style::new().fg(DIM))));
            }
        }
        out.push(Line::from(""));
    }
    let checked: Vec<String> = d["checked"].as_array().into_iter().flatten().filter_map(|c| c.as_str().map(str::to_string)).collect();
    if !checked.is_empty() {
        out.push(Line::from(Span::styled(format!("checked: {}", checked.join(", ")), Style::new().fg(DIM))));
    }
    out
}

/// One `Evidence` (contract/diag.rs) as text.
fn evidence_text(e: &Value) -> String {
    let s = |k: &str| e[k].as_str().unwrap_or_default();
    let obj = |r: &Value| format!("{}/{}", r["gvr"]["resource"].as_str().unwrap_or_default(), r["name"].as_str().unwrap_or_default());
    match s("type") {
        "field" => format!("{} = {}", s("path").trim_start_matches('/').replace('/', "."), s("value")),
        "logLine" => format!("{}{}", if e["previous"] == true { "(previous) " } else { "" }, s("text")),
        "event" => format!("{}: {}", e["event"]["reason"].as_str().unwrap_or_default(), e["event"]["message"].as_str().unwrap_or_default()),
        "object" => obj(&e["ref"]),
        "diff" => format!("{}\n→\n{}", s("left"), s("right")),
        _ => model::cell_text(e),
    }
}

fn event_lines(v: &Value) -> Vec<Line<'static>> {
    let rows = v.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return vec![Line::from(Span::styled("no events (they expire after an hour)", Style::new().fg(DIM)))];
    }
    rows.iter()
        .map(|e| {
            let warn = e["type"] == "Warning";
            let seen = e["lastSeen"].as_str().map(|t| model::age(t, jiff::Timestamp::now())).unwrap_or_default();
            let count = e["count"].as_i64().unwrap_or(1);
            Line::from(vec![
                Span::styled(format!("{seen:>4} "), Style::new().fg(DIM)),
                Span::styled(format!("{:<22} ", e["reason"].as_str().unwrap_or_default()), Style::new().fg(if warn { WARN } else { Color::Cyan }).bold()),
                Span::raw(e["message"].as_str().unwrap_or_default().to_string()),
                Span::styled(if count > 1 { format!("  ×{count}") } else { String::new() }, Style::new().fg(DIM)),
            ])
        })
        .collect()
}

fn secret_lines(v: &Value) -> Vec<Line<'static>> {
    let Some(map) = v.as_object() else { return vec![] };
    let mut out = vec![Line::from(Span::styled("decoded values; this view is not logged anywhere", Style::new().fg(WARN))), Line::from("")];
    for (k, val) in map {
        out.push(Line::from(Span::styled(k.clone(), Style::new().fg(Color::Cyan).bold())));
        match val.as_str() {
            Some(s) => s.lines().for_each(|l| out.push(Line::from(format!("  {l}")))),
            None => out.push(Line::from(Span::styled("  (binary)", Style::new().fg(DIM)))),
        }
    }
    out
}

fn help_lines() -> Vec<Line<'static>> {
    let k = |key: &str, what: &str| Line::from(vec![Span::styled(format!("  {key:<14}"), Style::new().fg(ACCENT).bold()), Span::raw(what.to_string())]);
    let h = |t: &str| Line::from(Span::styled(t.to_string(), Style::new().bold()));
    vec![
        h("anywhere"),
        k(":", "resource or command: :deploy, :svc kube-system, :ctx, :ns, :pf, :res"),
        k(":apply [file]", "review a file (or a new buffer) against the cluster, then apply"),
        k(":new [kind]", "start from a manifest: deploy, svc, cm, secret, job, cj, pod, ns"),
        k("c / n", "pick context / namespace"),
        k("/", "filter (words match name, namespace and columns)"),
        k("W", "open the kns window"),
        k("q / esc", "back (quit at the top)"),
        Line::from(""),
        h("on a row"),
        k("⏎", "pods of a workload/service/node, logs of a pod"),
        k("e", "edit in $EDITOR → diff + server dry run → ⏎ apply"),
        k("y  d  E", "YAML, why is it broken, events"),
        k("v", "resolved environment of a pod or workload"),
        k("i  h", "set image, history (diff a revision, u rolls back)"),
        k("o", "sort: name, newest, problems, cpu, memory"),
        k("l  p", "logs (herdr: in a new pane), previous logs"),
        k("s", "shell (herdr: in a new pane)"),
        k("F", "port-forward: [local:]remote"),
        k("r  S  t", "restart, scale, run a CronJob now"),
        k("x", "decode a Secret"),
        k("D / del", "delete"),
        k("R", "re-list"),
        Line::from(""),
        h("review (after e or :apply)"),
        k("⏎  e", "apply, back to the editor"),
        k("r  f", "rebase on a changed object, force over another field manager"),
        k("tab  w  q", "diff/manifest, save to a file, discard"),
        Line::from(""),
        h("protected contexts"),
        Line::from("  changes ask you to type the context name; read-only contexts refuse them"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_matching() {
        assert!(fuzzy("prod-eu-west", "pew"));
        assert!(!fuzzy("dev", "prod"));
        assert!(fuzzy("anything", ""));
    }

    #[test]
    fn pod_suffix() {
        assert_eq!(short_pod("web-7d9f8b6c5-x2k4q"), "x2k4q");
        assert_eq!(short_pod("db"), "db");
    }

    #[test]
    fn missing_namespace_from_the_error() {
        assert_eq!(missing_namespace("NotFound: Deployment/x: namespaces \"team\" not found").as_deref(), Some("team"));
        assert_eq!(missing_namespace("deployments.apps \"x\" not found"), None);
    }
}
