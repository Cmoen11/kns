//! Integration check of logs, exec and port-forward against the real cluster, without a webview.
//! Calls the same functions the Tauri commands delegate to. Only touches namespace `kns-spike`:
//! pod `sh` (busybox, httpd on 8080) must exist; a throwaway pod `kns-streams` is created and deleted.
//! Run: `cargo run --example streams_check`
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, bail, ensure};
use base64::Engine;
use kns_lib::{
    exec,
    forward::{self, ForwardQuery},
    ipc::{
        ApplyOptions, BackendError, DeleteOptions, ExecEvent, ExecQuery, FnSink, ForwardStatus, Gvr,
        Json, LogEvent, LogLine, LogQuery, LogTarget, ObjRef, Propagation,
    },
    logs, mutate, objects,
    state::AppState,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc::{UnboundedReceiver, unbounded_channel},
    time::{sleep, timeout},
};

const CTX: &str = "default";
/// The only namespace this example may touch.
const NS: &str = "kns-spike";
const SH: &str = "sh";
const POD: &str = "kns-streams";
const BURST_LINES: usize = 3000;

fn pod_ref(name: &str) -> ObjRef {
    ObjRef { context: CTX.into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some(NS.into()), name: name.into() }
}

fn target(pod: &str, container: &str) -> LogTarget {
    LogTarget { namespace: NS.into(), pod: pod.into(), container: container.into() }
}

/// Polls until `done` holds.
async fn eventually(what: &str, secs: u64, mut done: impl FnMut() -> bool) -> anyhow::Result<Duration> {
    let started = Instant::now();
    while !done() {
        ensure!(started.elapsed() < Duration::from_secs(secs), "timed out after {secs}s: {what}");
        sleep(Duration::from_millis(10)).await;
    }
    Ok(started.elapsed())
}

async fn container_status(state: &AppState, pod: &str, container: &str) -> anyhow::Result<Json> {
    let pod = objects::get_json(state, &pod_ref(pod)).await?;
    let statuses = pod["status"]["containerStatuses"].as_array().cloned().unwrap_or_default();
    Ok(statuses.into_iter().find(|s| s["name"] == container).unwrap_or_default())
}

// ───────────────────────── logs ─────────────────────────

struct Logs {
    id: String,
    rx: UnboundedReceiver<(Instant, LogEvent)>,
    events: Vec<(Instant, LogEvent)>,
}

impl Logs {
    async fn start(state: &AppState, targets: Vec<LogTarget>, edit: impl FnOnce(&mut LogQuery)) -> anyhow::Result<Self> {
        let mut query =
            LogQuery { context: CTX.into(), targets, follow: false, tail_lines: None, since_seconds: None, since_time: None, previous: None, parse: None };
        edit(&mut query);
        let (tx, rx) = unbounded_channel();
        let id = logs::stream_logs(state, query, FnSink(move |e| tx.send((Instant::now(), e)).is_ok())).await?;
        Ok(Self { id, rx, events: Vec::new() })
    }

    /// Reads events until `done` holds for everything received so far.
    async fn until(&mut self, secs: u64, what: &str, done: impl Fn(&[(Instant, LogEvent)]) -> bool) -> anyhow::Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        while !done(&self.events) {
            let event = tokio::time::timeout_at(deadline, self.rx.recv())
                .await
                .map_err(|_| anyhow!("timed out after {secs}s waiting for {what}"))?
                .ok_or_else(|| anyhow!("log stream closed while waiting for {what}"))?;
            self.events.push(event);
        }
        Ok(())
    }

    /// Reads until the stream's task has ended by itself (its sink is dropped).
    async fn drain(&mut self, secs: u64) -> anyhow::Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(event)) => self.events.push(event),
                Ok(None) => return Ok(()),
                Err(_) => bail!("log stream did not end by itself within {secs}s"),
            }
        }
    }

    fn lines(&self) -> Vec<&LogLine> {
        self.events
            .iter()
            .filter_map(|(_, e)| if let LogEvent::Lines { lines } = e { Some(lines) } else { None })
            .flatten()
            .collect()
    }

    fn batches(&self) -> Vec<usize> {
        self.events.iter().filter_map(|(_, e)| if let LogEvent::Lines { lines } = e { Some(lines.len()) } else { None }).collect()
    }

    fn ended(&self, pod: &str, container: &str) -> bool {
        self.events.iter().any(|(_, e)| matches!(e, LogEvent::End { pod: p, container: c } if p == pod && c == container))
    }

    fn error(&self, pod: &str, container: &str) -> Option<&str> {
        self.events.iter().find_map(|(_, e)| match e {
            LogEvent::Error { pod: p, container: c, message } if p == pod && c == container => Some(message.as_str()),
            _ => None,
        })
    }
}

fn ends(events: &[(Instant, LogEvent)]) -> usize {
    events.iter().filter(|(_, e)| !matches!(e, LogEvent::Lines { .. })).count()
}

async fn check_logs(state: &AppState) -> anyhow::Result<()> {
    // tail: exactly N lines, timestamp split off, stream ends and unregisters by itself.
    let mut tail = Logs::start(state, vec![target(SH, SH)], |q| q.tail_lines = Some(3)).await?;
    tail.drain(15).await?;
    let lines = tail.lines();
    ensure!(lines.len() == 3, "tail=3 gave {} lines", lines.len());
    for line in &lines {
        let ts: jiff::Timestamp = line.ts.parse().with_context(|| format!("ts {:?} is not RFC3339", line.ts))?;
        ensure!((jiff::Timestamp::now() - ts).get_seconds().abs() < 600, "timestamp {ts} is far off");
        ensure!(line.text == "tick" && &*line.pod == SH && &*line.container == SH, "unexpected line {line:?}");
    }
    ensure!(tail.ended(SH, SH) && ends(&tail.events) == 1, "expected exactly one end event");
    ensure!(matches!(tail.events.last(), Some((_, LogEvent::End { .. }))), "end is not the last event");
    eventually("finished stream leaves the registry", 2, || state.stream_count() == 0).await?;
    println!("[logs tail] 3 lines, ts={:?} text={:?}, end event, stream unregistered itself", lines[0].ts, lines[0].text);

    // since: `sh` prints one line every 2 s.
    let mut since = Logs::start(state, vec![target(SH, SH)], |q| q.since_seconds = Some(9)).await?;
    since.drain(15).await?;
    let n = since.lines().len();
    ensure!((3..=6).contains(&n), "sinceSeconds=9 gave {n} lines, expected about 4-5");
    let mut all = Logs::start(state, vec![target(SH, SH)], |_| {}).await?;
    all.drain(30).await?;
    ensure!(all.lines().len() > n, "unbounded read is not longer than the since read");
    println!("[logs since] sinceSeconds=9 -> {n} lines (unbounded: {})", all.lines().len());

    // Backlog: batches of at most 500, long line capped, lines without loss or reordering.
    let mut burst = Logs::start(state, vec![target(POD, "burst")], |_| {}).await?;
    burst.drain(30).await?;
    let (lines, batches) = (burst.lines(), burst.batches());
    let numbered: Vec<&str> = lines.iter().filter_map(|l| l.text.strip_prefix("burst ")).collect();
    let expected: Vec<String> = (1..=BURST_LINES).map(|i| i.to_string()).collect();
    ensure!(numbered == expected, "burst lines lost or reordered ({} of {BURST_LINES})", numbered.len());
    let max = batches.iter().copied().max().unwrap_or(0);
    ensure!(max == 500, "largest batch is {max}, expected 500");
    ensure!(batches.len() <= lines.len() / 100, "{} batches for {} lines: not batched", batches.len(), lines.len());
    let long = lines.iter().map(|l| l.text.len()).max().unwrap_or(0);
    ensure!(long == 16 * 1024, "longest line is {long} bytes, expected the 16 KiB cap");
    ensure!(lines.iter().any(|l| l.text == "after-long"), "line after the long one is missing");
    println!("[logs backlog] {} lines in {} events (max {max}); 20000-char line capped to {long}", lines.len(), batches.len());

    // previous: needs a restarted container; a container that never restarted reports an error.
    let started = Instant::now();
    loop {
        if container_status(state, POD, "burst").await?["restartCount"].as_i64().unwrap_or(0) > 0 {
            break;
        }
        ensure!(started.elapsed() < Duration::from_secs(60), "burst container did not restart");
        sleep(Duration::from_millis(500)).await;
    }
    let mut previous = Logs::start(state, vec![target(POD, "burst"), target(POD, "fast")], |q| {
        q.previous = Some(true);
        q.tail_lines = Some(2);
    })
    .await?;
    previous.drain(15).await?;
    let texts: Vec<&str> = previous.lines().iter().map(|l| l.text.as_str()).collect();
    ensure!(texts == ["after-long", "burst-done"], "previous tail=2 gave {texts:?}");
    let message = previous.error(POD, "fast").ok_or_else(|| anyhow!("no error for a container without a previous run"))?;
    ensure!(previous.ended(POD, "burst") && !previous.ended(POD, "fast"));
    println!("[logs previous] {texts:?} + end; never-restarted container -> error {message:?}");

    // Follow, several targets merged, one of them missing.
    let targets = vec![target(SH, SH), target(POD, "fast"), target(POD, "burst"), target("kns-nope", "x")];
    let mut follow = Logs::start(state, targets, |q| {
        q.follow = true;
        q.tail_lines = Some(5);
    })
    .await?;
    let opened = Instant::now();
    follow
        .until(40, "lines from sh and fast, end of burst, error of kns-nope", |ev| {
            let from = |pod: &str, c: &str| {
                ev.iter().any(|(_, e)| matches!(e, LogEvent::Lines { lines } if lines.iter().any(|l| &*l.pod == pod && &*l.container == c)))
            };
            let live = ev.iter().filter(|(at, e)| matches!(e, LogEvent::Lines { .. }) && *at > opened + Duration::from_secs(3)).count();
            from(SH, SH) && from(POD, "fast") && from(POD, "burst") && ends(ev) == 2 && live >= 10
        })
        .await?;
    ensure!(follow.ended(POD, "burst"), "no end event for the exited container");
    ensure!(!follow.ended(SH, SH) && !follow.ended(POD, "fast"), "a running container reported end");
    let nope = follow.error("kns-nope", "x").ok_or_else(|| anyhow!("no error event for the missing pod"))?.to_string();
    // A quiet stream is flushed on the timer (never waits for 500 lines), and no faster than it.
    let fast: Vec<(Instant, usize)> = follow
        .events
        .iter()
        .filter(|(at, _)| *at > opened + Duration::from_secs(3))
        .filter_map(|(at, e)| if let LogEvent::Lines { lines } = e { Some((*at, lines.len())) } else { None })
        .collect();
    let gaps: Vec<u128> = fast.windows(2).map(|w| (w[1].0 - w[0].0).as_millis()).collect();
    // An end event flushes early, so only directly adjacent lines events are held to the timer.
    let min_gap = follow
        .events
        .windows(2)
        .filter(|w| w[0].0 > opened + Duration::from_secs(3))
        .filter(|w| matches!((&w[0].1, &w[1].1), (LogEvent::Lines { .. }, LogEvent::Lines { .. })))
        .map(|w| (w[1].0 - w[0].0).as_millis())
        .min()
        .unwrap_or(0);
    let max_gap = gaps.iter().copied().max().unwrap_or(0);
    ensure!(fast.iter().all(|(_, n)| *n <= 3), "live batches too large: {:?}", fast.iter().map(|f| f.1).collect::<Vec<_>>());
    ensure!(min_gap >= 95, "two lines events only {min_gap} ms apart");
    ensure!(max_gap <= 450, "{max_gap} ms without a lines event although a line is logged every 200 ms");
    // In each target, lines arrive in timestamp order.
    for (pod, c) in [(SH, SH), (POD, "fast")] {
        let ts: Vec<&str> = follow.lines().into_iter().filter(|l| &*l.pod == pod && &*l.container == c).map(|l| l.ts.as_str()).collect();
        ensure!(ts.windows(2).all(|w| w[0] <= w[1]), "{pod}/{c} lines out of order");
    }
    println!(
        "[logs follow] 4 targets merged: {} lines in {} events; live batches every {min_gap}-{max_gap} ms; burst -> end; kns-nope -> error {nope:?}",
        follow.lines().len(),
        follow.batches().len()
    );

    // Cancellation: registry empty, sink dropped (all tasks gone), nothing delivered afterwards.
    ensure!(state.stream_count() == 1, "expected one running stream");
    let stopping = Instant::now();
    ensure!(state.stop_stream(&follow.id), "stop_stream did not find the stream");
    let before = follow.events.len();
    follow.drain(2).await?;
    let late = follow.events.len() - before;
    ensure!(late <= 1, "{late} events delivered after stop_stream");
    ensure!(state.stream_count() == 0, "stream still registered");
    println!("[logs stop] all reader tasks gone {:?} after stop_stream, registry empty", stopping.elapsed());

    // A receiver that goes away ends the stream too.
    let id = logs::stream_logs(
        state,
        LogQuery { context: CTX.into(), targets: vec![target(SH, SH)], follow: true, tail_lines: Some(1), since_seconds: None, since_time: None, previous: None, parse: None },
        FnSink(|_| false),
    )
    .await?;
    let took = eventually("stream with a dead sink ends", 5, || state.stream_count() == 0).await?;
    println!("[logs dead sink] {id} ended by itself after {took:?}");

    // A silent follow is reopened from its last line. With an idle time below the 200 ms between
    // lines every line comes from a reopened stream: none may be lost or repeated.
    let (tx, mut rx) = unbounded_channel();
    let query = LogQuery { context: CTX.into(), targets: vec![target(POD, "fast")], follow: true, tail_lines: Some(1), since_seconds: None, since_time: None, previous: None, parse: None };
    let id = logs::stream_logs_with(state, query, FnSink(move |e| tx.send(e).is_ok()), Duration::from_millis(120)).await?;
    let mut numbers: Vec<u64> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        match event {
            LogEvent::Lines { lines } => numbers.extend(lines.iter().filter_map(|l| l.text.strip_prefix("fast ")?.parse::<u64>().ok())),
            other => bail!("reopened follow reported {other:?}"),
        }
    }
    ensure!(state.stop_stream(&id));
    ensure!(numbers.len() >= 15, "only {} lines in 5 s through reopened follows", numbers.len());
    ensure!(numbers.windows(2).all(|w| w[1] == w[0] + 1), "lines lost or repeated across reopens: {numbers:?}");
    println!("[logs reopen] idle 120 ms: {} consecutive lines ({}..={}) across reopened follows, none lost or repeated", numbers.len(), numbers[0], numbers[numbers.len() - 1]);
    Ok(())
}

// ───────────────────────── exec ─────────────────────────

struct Term {
    id: String,
    rx: UnboundedReceiver<ExecEvent>,
    out: String,
    data_events: usize,
    last: Option<ExecEvent>,
    /// The session's task has ended (its sink is dropped).
    closed: bool,
}

impl Term {
    async fn start(state: &AppState, command: &[&str], tty: bool, edit: impl FnOnce(&mut ExecQuery)) -> anyhow::Result<Self> {
        let mut query = ExecQuery {
            context: CTX.into(),
            namespace: NS.into(),
            pod: SH.into(),
            container: None,
            command: command.iter().map(|s| s.to_string()).collect(),
            tty,
            attach: None,
            cols: 100,
            rows: 30,
        };
        edit(&mut query);
        let (tx, rx) = unbounded_channel();
        let id = exec::exec_start(state, query, FnSink(move |e| tx.send(e).is_ok())).await?;
        Ok(Self { id, rx, out: String::new(), data_events: 0, last: None, closed: false })
    }

    /// Pumps events until `done` holds for the output after byte `from`; false on timeout or end.
    async fn wait(&mut self, millis: u64, from: usize, done: impl Fn(&str) -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(millis);
        while !done(&self.out[from..]) {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(ExecEvent::Data { b64 })) => {
                    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default();
                    // Output here is ASCII; lossy decoding keeps byte offsets valid.
                    self.out.push_str(&String::from_utf8_lossy(&bytes).replace('\u{fffd}', "?"));
                    self.data_events += 1;
                }
                Ok(Some(other)) => self.last = Some(other),
                Ok(None) => {
                    self.closed = true;
                    return done(&self.out[from..]);
                }
                Err(_) => return false,
            }
        }
        true
    }

    /// Pumps until the session's task has ended; returns the final (non-data) event.
    async fn finish(&mut self, secs: u64) -> anyhow::Result<ExecEvent> {
        self.wait(secs * 1000, 0, |_| false).await;
        ensure!(self.closed, "session {} still running after {secs}s; output tail {:?}", self.id, tail(&self.out, 300));
        self.last.clone().ok_or_else(|| anyhow!("session {} ended without exit/error event; output {:?}", self.id, self.out))
    }

    async fn write(&self, state: &AppState, data: &str) -> anyhow::Result<()> {
        Ok(exec::exec_write(state, &self.id, data)?)
    }

    /// Runs `stty size` until it prints `expect` ("rows cols"); returns the number of tries.
    async fn size_is(&mut self, state: &AppState, expect: &str) -> anyhow::Result<usize> {
        for attempt in 1..=20 {
            let from = self.out.len();
            self.write(state, "stty size\n").await?;
            if self.wait(500, from, |o| o.contains(expect)).await {
                return Ok(attempt);
            }
        }
        bail!("terminal never reported size {expect:?}; output tail {:?}", tail(&self.out, 300))
    }
}

fn tail(s: &str, n: usize) -> &str {
    &s[s.ceil_char_boundary(s.len().saturating_sub(n))..]
}

/// What a command printed on a TTY, without the echoed input and the prompt.
fn answer(output: &str) -> String {
    output.lines().map(str::trim).filter(|l| !l.contains("echo") && !l.is_empty() && *l != "/ #").collect::<Vec<_>>().join(" | ")
}

/// Runs a command without TTY and returns its exit code.
async fn exit_code(state: &AppState, command: &[&str]) -> anyhow::Result<Option<i32>> {
    match Term::start(state, command, false, |_| {}).await?.finish(10).await? {
        ExecEvent::Exit { code, .. } => Ok(code),
        other => bail!("{command:?} ended with {other:?}"),
    }
}

async fn check_exec(state: &AppState) -> anyhow::Result<()> {
    // TTY shell with the default (auto-detected) command.
    let mut term = Term::start(state, &[], true, |_| {}).await?;
    ensure!(state.stream_count() == 1);
    // The TTY echoes what is typed, so only computed markers prove that a command ran.
    term.write(state, "echo shell-$((40+2))-$0; command -v bash || echo no-bash-$((1+1))\n").await?;
    ensure!(term.wait(8000, 0, |o| o.contains("shell-42-") && (o.contains("no-bash-2") || o.contains("/bash"))).await, "shell did not answer: {:?}", term.out);
    let shell = term.out.split("shell-42-").nth(1).and_then(|s| s.split_whitespace().next()).unwrap_or_default().to_string();
    let has_bash = !term.out.contains("no-bash-2");
    ensure!(shell == if has_bash { "bash" } else { "sh" }, "container has bash={has_bash} but the shell is {shell:?}");
    println!("[exec tty] default command started {shell:?} (bash in image: {has_bash}); stdin write + output ok");

    // The bash arm of the default command: a container whose PATH has a `bash` (a wrapper around sh).
    let mut bash = Term::start(state, &[], true, |q| (q.pod, q.container) = (POD.into(), Some("bash".into()))).await?;
    ensure!(bash.wait(8000, 0, |o| o.contains("fake-bash-started")).await, "default command did not pick bash: {:?}", bash.out);
    bash.write(state, "exit\n").await?;
    let exit = bash.finish(10).await?;
    println!("[exec tty] container with bash on PATH: default command started bash (wrapper marker seen), {exit:?}");

    // Resize. The initial size is sent right after start.
    let tries = term.size_is(state, "30 100").await?;
    println!("[exec resize] initial 100x30 reported by `stty size` (try {tries})");
    // SIGWINCH reaches the foreground job. (At the prompt busybox's line editor takes the signal
    // itself, so the trap is set in a subshell that is busy while the resize happens.)
    let from = term.out.len();
    term.write(state, "(trap 'echo winch-$((20+3))' WINCH; sleep 2; true)\n").await?;
    sleep(Duration::from_millis(700)).await;
    exec::exec_resize(state, &term.id, 132, 43)?;
    let winch = term.wait(8000, from, |o| o.contains("winch-23")).await;
    let tries = term.size_is(state, "43 132").await?;
    println!("[exec resize] -> 132x43 reported (try {tries}); foreground job got SIGWINCH: {winch}");
    exec::exec_resize(state, &term.id, 80, 24)?;
    let tries = term.size_is(state, "24 80").await?;
    let from = term.out.len();
    term.write(state, "stty -a | head -n 1; echo cols-$(stty -a | head -n 1 | sed 's/.*columns \\([0-9]*\\).*/\\1/')\n").await?;
    ensure!(term.wait(5000, from, |o| o.contains("cols-80")).await, "stty -a does not show 80 columns: {:?}", tail(&term.out, 300));
    let stty = term.out[from..].lines().find(|l| l.starts_with("speed")).unwrap_or_default().trim().to_string();
    println!("[exec resize] -> 80x24 reported (try {tries}); stty -a: {stty:?}");
    // A burst of resizes: the last one wins.
    for cols in 90..120 {
        exec::exec_resize(state, &term.id, cols, 40)?;
    }
    term.size_is(state, "40 119").await?;

    // Exit status.
    term.write(state, "trap - WINCH; exit 7\n").await?;
    let exit = term.finish(10).await?;
    ensure!(matches!(exit, ExecEvent::Exit { code: Some(7), .. }), "expected exit code 7, got {exit:?}");
    eventually("ended session leaves the registries", 2, || state.stream_count() == 0).await?;
    let late = exec::exec_write(state, &term.id, "x").err().map(|e| e.reason);
    ensure!(late.as_deref() == Some("NotFound"), "write to an ended session: {late:?}");
    ensure!(exec::exec_resize(state, &term.id, 1, 1).is_err());
    println!("[exec exit] `exit 7` -> {exit:?}; session unregistered, later write -> {late:?}");

    // The earlier spike sent a resize and `stty size` in the same instant on a fresh pty and read
    // "stty: standard input". Same here: cols/rows 0 = no initial size, so the pty starts 0x0.
    let mut unsized_term = Term::start(state, &["sh"], true, |q| (q.cols, q.rows) = (0, 0)).await?;
    let ask = "stty size; echo rc-$?-$((1+1))\n";
    unsized_term.write(state, ask).await?;
    ensure!(unsized_term.wait(8000, 0, |o| o.contains("-2\r")).await);
    let zero = answer(&unsized_term.out);
    let from = unsized_term.out.len();
    exec::exec_resize(state, &unsized_term.id, 77, 22)?;
    unsized_term.write(state, ask).await?;
    ensure!(unsized_term.wait(8000, from, |o| o.contains("-2\r")).await);
    let raced = answer(&unsized_term.out[from..]);
    let tries = unsized_term.size_is(state, "22 77").await?;
    println!("[exec resize] 0x0 pty: `stty size` -> {zero:?}; resize(77,22) and `stty size` sent together -> {raced:?}; asked again -> 22 77 (try {tries})");
    // stop_stream: the session is closed on our side at once and stdin gets EOF. A shell on a pipe
    // exits on that; a TTY has no EOF, so it is sent Ctrl-C, Ctrl-D, which also ends a foreground job.
    for tty in [true, false] {
        let mut shell = if tty { unsized_term } else { Term::start(state, &["sh"], false, |_| {}).await? };
        let from = shell.out.len();
        shell.write(state, "echo pid-$$-$((1+1))\n").await?;
        ensure!(shell.wait(5000, from, |o| o.contains("-2\r") || o.contains("-2\n")).await, "no pid: {:?}", shell.out);
        let pid = shell.out[from..].rsplit("pid-").next().and_then(|s| s.split('-').next()).unwrap_or_default().to_string();
        if tty {
            shell.write(state, "sleep 300\n").await?;
            sleep(Duration::from_millis(500)).await;
        }
        let stopping = Instant::now();
        ensure!(state.stop_stream(&shell.id) && state.stream_count() == 0);
        shell.wait(4000, 0, |_| false).await;
        ensure!(shell.closed && shell.last.is_none(), "session not closed cleanly by stop_stream");
        let closed_in = stopping.elapsed();
        ensure!(exec::exec_write(state, &shell.id, "x").is_err(), "write to a stopped session succeeded");
        let alive = exit_code(state, &["kill", "-0", &pid]).await? == Some(0);
        println!("[exec stop] tty={tty}: session closed in {closed_in:?}, later write fails; remote shell (pid {pid}) still alive: {alive}");
        if alive {
            let _ = exit_code(state, &["kill", "-HUP", &pid]).await;
            bail!("the remote shell (tty={tty}) is still running after stop_stream");
        }
        unsized_term = shell;
    }

    // A refused upgrade keeps its HTTP status.
    let no_pod = Term::start(state, &["true"], false, |q| q.pod = "kns-no-such-pod".into()).await.err();
    let no_pod = no_pod.and_then(|e| e.downcast::<BackendError>().ok()).map(|e| (e.code, e.reason));
    ensure!(no_pod == Some((404, "NotFound".into())), "exec into a missing pod: {no_pod:?}");
    println!("[exec error] exec into a missing pod -> {no_pod:?}");

    // Input for a process that never reads is refused once 1 MiB is queued, not buffered without bound.
    let deaf = Term::start(state, &["sleep", "25"], false, |_| {}).await?;
    let chunk = "x".repeat(64 * 1024);
    let mut accepted = 0;
    let refused = loop {
        match exec::exec_write(state, &deaf.id, &chunk) {
            Ok(()) => accepted += chunk.len(),
            Err(e) => break e,
        }
        ensure!(accepted < 64 << 20, "64 MiB of input queued for a process that does not read");
        if accepted % (1 << 20) == 0 {
            sleep(Duration::from_millis(50)).await;
        }
    };
    ensure!(refused.reason == "Busy", "unexpected error {refused}");
    ensure!(state.stop_stream(&deaf.id));
    println!("[exec stdin cap] `sleep` reads nothing: {} KiB accepted, then {:?}", accepted / 1024, refused.reason);

    // No TTY: stdout and stderr are separate streams, merged into data; stdin works; exit code.
    let script = "echo out-$((1+1)); echo err-$((2+2)) >&2; read line; echo got-$line; exit 3";
    let mut plain = Term::start(state, &["sh", "-c", script], false, |_| {}).await?;
    ensure!(plain.wait(8000, 0, |o| o.contains("out-2") && o.contains("err-4")).await, "missing stdout/stderr: {:?}", plain.out);
    exec::exec_resize(state, &plain.id, 10, 10)?;
    plain.write(state, "hello\n").await?;
    let exit = plain.finish(10).await?;
    ensure!(plain.out.contains("got-hello") && !plain.out.contains("hello\r"), "stdin not delivered or echoed: {:?}", plain.out);
    ensure!(matches!(exit, ExecEvent::Exit { code: Some(3), .. }), "expected exit code 3, got {exit:?}");
    println!("[exec plain] stdout+stderr merged {:?}, stdin read, {exit:?}", plain.out);

    // Writes issued back to back arrive complete and in order.
    let mut ordered = Term::start(state, &["head", "-n", "500"], false, |_| {}).await?;
    let expected: String = (1..=500).map(|i| format!("line-{i}\n")).collect();
    for line in expected.split_inclusive('\n') {
        exec::exec_write(state, &ordered.id, line)?;
    }
    let exit = ordered.finish(15).await?;
    ensure!(ordered.out == expected, "stdin writes lost or reordered ({} of {} bytes)", ordered.out.len(), expected.len());
    println!("[exec stdin] 500 back-to-back writes echoed in order, {exit:?}");

    let mut ok = Term::start(state, &["true"], false, |_| {}).await?;
    let exit = ok.finish(10).await?;
    ensure!(matches!(exit, ExecEvent::Exit { code: Some(0), message: None }), "expected exit 0, got {exit:?}");
    let missing = match Term::start(state, &["/no/such/binary"], false, |_| {}).await {
        Ok(mut t) => format!("{:?}", t.finish(10).await?),
        Err(e) => format!("start error: {e:#}"),
    };
    ensure!(!missing.contains("Some(0)"), "a missing binary reported success");
    println!("[exec status] `true` -> {exit:?}; missing binary -> {missing}");

    // Throughput and integrity: 588895 bytes through the batching, nothing lost or reordered.
    let started = Instant::now();
    let mut big = Term::start(state, &["seq", "1", "100000"], false, |_| {}).await?;
    let exit = big.finish(60).await?;
    let expected: String = (1..=100000).map(|i| format!("{i}\n")).collect();
    ensure!(big.out == expected, "bulk output differs: {} bytes, expected {}", big.out.len(), expected.len());
    ensure!(matches!(exit, ExecEvent::Exit { code: Some(0), .. }));
    println!("[exec bulk] {} bytes intact in {} data events, {:?}", big.out.len(), big.data_events, started.elapsed());

    // Attach to the container's main process (no TTY there): its output arrives; closing leaves it running.
    let before = container_status(state, SH, SH).await?;
    let mut attached = Term::start(state, &[], false, |q| q.attach = Some(true)).await?;
    ensure!(attached.wait(8000, 0, |o| o.matches("tick").count() >= 2).await, "no output from attach: {:?}", attached.out);
    ensure!(state.stop_stream(&attached.id));
    attached.wait(3000, 0, |_| false).await;
    ensure!(attached.closed, "attach not closed by stop_stream");
    eventually("attach leaves the registry", 2, || state.stream_count() == 0).await?;
    let after = container_status(state, SH, SH).await?;
    ensure!(after["state"]["running"].is_object() && after["restartCount"] == before["restartCount"], "attach disturbed the container");
    println!("[exec attach] received {:?}; stopped, container still running", attached.out);

    // Nothing may be left behind in the pod.
    let mut ps = Term::start(state, &["ps"], false, |_| {}).await?;
    ps.finish(10).await?;
    let stray: Vec<&str> = ps
        .out
        .lines()
        .skip(1)
        .filter(|l| !["while true", "httpd", "sleep 2", "ps"].iter().any(|known| l.contains(known)))
        .collect();
    ensure!(stray.is_empty(), "stray processes in the pod: {stray:?}");
    println!("[exec ps] no stray processes in {SH}");
    Ok(())
}

// ───────────────────────── port-forward ─────────────────────────

fn forward_query(pod: &str, remote_port: u16, local_port: Option<u16>) -> ForwardQuery {
    // an explicit local port stays exact (pinned), as the dialog used to do
    ForwardQuery {
        context: CTX.into(),
        target: kns_lib::ipc::ForwardTarget::Pod { namespace: NS.into(), name: pod.into() },
        remote_port: kns_lib::ipc::PortRef::Number(remote_port),
        pin: Some(local_port.is_some_and(|p| p != 0)),
        local_port,
        address: None,
        label: None,
        dev_set: None,
        proposal_id: None,
    }
}

/// HTTP/1.0 request read to EOF: only returns when the close propagates through the tunnel.
async fn http_get(port: u16) -> anyhow::Result<String> {
    let exchange = async {
        let mut tcp = TcpStream::connect(("127.0.0.1", port)).await?;
        tcp.write_all(b"GET / HTTP/1.0\r\n\r\n").await?;
        let mut response = Vec::new();
        tcp.read_to_end(&mut response).await?;
        anyhow::Ok(String::from_utf8_lossy(&response).into_owned())
    };
    timeout(Duration::from_secs(15), exchange).await.map_err(|_| anyhow!("HTTP exchange through port {port} hung"))?
}

async fn the_forward(state: &AppState, id: &str) -> anyhow::Result<kns_lib::ipc::Forward> {
    let all = forward::list_forwards(state).await?;
    all.into_iter().find(|f| f.id == id).ok_or_else(|| anyhow!("forward {id} is not listed"))
}

async fn connections(state: &AppState, id: &str, expect: u32) -> anyhow::Result<()> {
    let started = Instant::now();
    loop {
        let n = the_forward(state, id).await?.connections;
        if n == expect {
            return Ok(());
        }
        ensure!(started.elapsed() < Duration::from_secs(5), "connections is {n}, expected {expect}");
        sleep(Duration::from_millis(20)).await;
    }
}

async fn check_forward(state: &AppState) -> anyhow::Result<()> {
    ensure!(forward::list_forwards(state).await?.is_empty());

    // Free port on 127.0.0.1.
    let fwd = forward::start_forward(state, forward_query(SH, 8080, None)).await?;
    ensure!(fwd.local_port != 0 && fwd.address == "127.0.0.1" && fwd.status == ForwardStatus::Active && fwd.connections == 0);
    let response = http_get(fwd.local_port).await?;
    let status_line = response.lines().next().unwrap_or_default().to_string();
    ensure!(status_line.starts_with("HTTP/1."), "unexpected response {response:?}");
    connections(state, &fwd.id, 0).await?;
    println!("[forward] {} 127.0.0.1:{} -> {SH}:8080: {status_line:?} ({} bytes, read to EOF)", fwd.id, fwd.local_port, response.len());

    // Several connections at once, counted while open.
    let mut clients = Vec::new();
    for _ in 0..6 {
        clients.push(TcpStream::connect(("127.0.0.1", fwd.local_port)).await?);
    }
    connections(state, &fwd.id, 6).await?;
    let exchanges = clients.into_iter().map(|mut tcp| async move {
        tcp.write_all(b"GET / HTTP/1.0\r\n\r\n").await?;
        let mut response = Vec::new();
        timeout(Duration::from_secs(15), tcp.read_to_end(&mut response)).await??;
        anyhow::Ok(response)
    });
    let responses = futures::future::try_join_all(exchanges).await?;
    ensure!(responses.iter().all(|r| r.starts_with(b"HTTP/1.")), "a concurrent response is broken");
    connections(state, &fwd.id, 0).await?;
    ensure!(the_forward(state, &fwd.id).await?.status == ForwardStatus::Active);
    println!("[forward concurrent] 6 connections counted while open, 6 responses, count back to 0");

    // Same port again: AddrInUse, and nothing is registered for the failed attempt.
    let clash = forward::start_forward(state, forward_query(SH, 8080, Some(fwd.local_port))).await.err();
    let clash: BackendError = clash.ok_or_else(|| anyhow!("second forward on the same port succeeded"))?;
    ensure!(clash.reason == "AddrInUse", "expected AddrInUse, got {clash}");
    ensure!(forward::list_forwards(state).await?.len() == 1);
    println!("[forward in use] second forward on :{} -> {} ({})", fwd.local_port, clash.reason, clash.message);

    // Stop: an open connection is closed, the listener is gone, the port can be bound again.
    let mut idle = TcpStream::connect(("127.0.0.1", fwd.local_port)).await?;
    connections(state, &fwd.id, 1).await?;
    let stopping = Instant::now();
    forward::stop_forward(state, &fwd.id).await?;
    let stopped_in = stopping.elapsed();
    let mut byte = [0u8; 1];
    let closed = timeout(Duration::from_secs(3), idle.read(&mut byte)).await.map_err(|_| anyhow!("open connection survived stop_forward"))?;
    ensure!(matches!(closed, Ok(0) | Err(_)), "open connection still delivers data");
    ensure!(TcpStream::connect(("127.0.0.1", fwd.local_port)).await.is_err(), "port still accepts connections after stop");
    drop(std::net::TcpListener::bind(("127.0.0.1", fwd.local_port)).context("port not released after stop")?);
    ensure!(forward::list_forwards(state).await?.is_empty());
    forward::stop_forward(state, &fwd.id).await?;
    println!("[forward stop] stopped in {stopped_in:?}: open connection closed, connect refused, port {} rebindable", fwd.local_port);

    // Fixed port (the one just released), next to a second forward.
    let fixed = forward::start_forward(state, forward_query(SH, 8080, Some(fwd.local_port))).await?;
    ensure!(fixed.local_port == fwd.local_port && fixed.id != fwd.id);
    let other = forward::start_forward(state, forward_query(POD, 9, Some(0))).await?;
    ensure!(http_get(fixed.local_port).await?.starts_with("HTTP/1."));
    let listed: Vec<String> = forward::list_forwards(state).await?.iter().map(|f| format!("{}:{}->{}:{}", f.id, f.local_port, f.pod, f.remote_port)).collect();
    ensure!(listed.len() == 2 && listed[0].starts_with(&fixed.id), "unexpected list {listed:?}");
    println!("[forward fixed] fixed port {} works again; list = {listed:?}", fixed.local_port);

    // Nothing listens on the remote port: the client is disconnected and the forward shows why.
    let refused = http_get(other.local_port).await.unwrap_or_else(|e| format!("error: {e}"));
    let started = Instant::now();
    let shown = loop {
        let f = the_forward(state, &other.id).await?;
        if f.status == ForwardStatus::Error || started.elapsed() > Duration::from_secs(5) {
            break f;
        }
        sleep(Duration::from_millis(50)).await;
    };
    ensure!(shown.status == ForwardStatus::Error && shown.message.is_some() && shown.connections == 0, "dead remote port not reported: {shown:?}");
    ensure!(the_forward(state, &fixed.id).await?.status == ForwardStatus::Active);
    println!("[forward refused] remote port 9: client got {refused:?}; status={:?} message={:?}", shown.status, shown.message.unwrap_or_default());

    let missing = forward::start_forward(state, forward_query("kns-nope", 80, None)).await.err();
    ensure!(missing.as_ref().is_some_and(|e| e.code == 404), "missing pod: {missing:?}");
    forward::stop_forward(state, &fixed.id).await?;
    forward::stop_forward(state, &other.id).await?;
    ensure!(forward::list_forwards(state).await?.is_empty());
    ensure!(TcpStream::connect(("127.0.0.1", fixed.local_port)).await.is_err());
    println!("[forward] missing pod -> {}; all forwards stopped", missing.map(|e| e.reason).unwrap_or_default());
    Ok(())
}

// ───────────────────────── setup ─────────────────────────

async fn setup(state: &AppState) -> anyhow::Result<()> {
    let sh = objects::get_json(state, &pod_ref(SH)).await.context("pod kns-spike/sh is required")?;
    let image = sh["spec"]["containers"][0]["image"].as_str().unwrap_or("busybox").to_string();
    // fast: a line every 200 ms. burst: a backlog and an over-long line, then exits so it has a previous run.
    let pod = format!(
        r#"apiVersion: v1
kind: Pod
metadata:
  name: {POD}
  namespace: {NS}
spec:
  terminationGracePeriodSeconds: 0
  containers:
  - name: fast
    image: {image}
    command: ["sh", "-c", "i=0; while true; do echo fast $i; i=$((i+1)); usleep 200000; done"]
  - name: burst
    image: {image}
    command: ["sh", "-c", "seq 1 {BURST_LINES} | sed 's/^/burst /'; head -c 20000 /dev/zero | tr '\\0' x; echo; echo after-long; sleep 6; echo burst-done; exit 3"]
  - name: bash
    image: {image}
    command: ["sh", "-c", "printf '#!/bin/sh\necho fake-bash-started\nexec sh\n' > /bin/bash; chmod +x /bin/bash; exec sleep 3600"]
"#
    );
    mutate::apply_yaml(state, CTX, &pod, &ApplyOptions::default()).await?;
    let started = Instant::now();
    loop {
        let fast = container_status(state, POD, "fast").await?;
        let burst = container_status(state, POD, "burst").await?;
        let bash = container_status(state, POD, "bash").await?;
        if [&fast, &burst, &bash].iter().all(|c| c["state"]["running"].is_object()) {
            break;
        }
        ensure!(started.elapsed() < Duration::from_secs(90), "pod {POD} did not start: {fast} {burst}");
        sleep(Duration::from_millis(300)).await;
    }
    println!("[setup] pod {NS}/{POD} running ({image}) after {:?}", started.elapsed());
    Ok(())
}

async fn cleanup(state: &AppState) -> anyhow::Result<()> {
    for f in forward::list_forwards(state).await? {
        forward::stop_forward(state, &f.id).await?;
    }
    let opts = DeleteOptions { propagation: Some(Propagation::Background), grace_period_seconds: Some(0) };
    match mutate::delete_object(state, &pod_ref(POD), &opts).await {
        Ok(()) => println!("[cleanup] deleted pod {NS}/{POD}"),
        Err(e) if e.code == 404 => {}
        Err(e) => bail!("cleanup failed: {e}"),
    }
    Ok(())
}

async fn check(state: &AppState) -> anyhow::Result<()> {
    setup(state).await?;
    check_logs(state).await.context("logs")?;
    check_exec(state).await.context("exec")?;
    check_forward(state).await.context("forward")?;
    ensure!(state.stream_count() == 0, "{} streams left in the registry", state.stream_count());
    Ok(())
}

#[tokio::main]
async fn main() {
    let state = AppState::default();
    let started = Instant::now();
    let result = check(&state).await;
    let cleaned = cleanup(&state).await;
    match (result, cleaned) {
        (Ok(()), Ok(())) => println!("STREAMS CHECK PASSED in {:?}", started.elapsed()),
        (result, cleaned) => {
            for e in [result.err(), cleaned.err()].into_iter().flatten() {
                println!("STREAMS CHECK FAILED: {e:#}");
            }
            std::process::exit(1);
        }
    }
}
