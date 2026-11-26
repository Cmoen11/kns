//! `kns-tui`: a terminal frontend for kns, built for herdr panes (docs/plan-background.md).
//!
//! It talks to the running kns over its local socket (`src/rpc`) and never holds cluster
//! credentials itself. When no kns answers it starts `kns --background`. The modules live in
//! `src/tui/` and are compiled in directly, so this binary links no Tauri or Kubernetes code.
#[cfg(unix)]
#[path = "../rpc/path.rs"]
mod path;

#[cfg(unix)]
#[path = "../tui/app.rs"]
mod app;
#[cfg(unix)]
#[path = "../tui/client.rs"]
mod client;
#[cfg(unix)]
#[path = "../tui/diff.rs"]
mod diff;
#[cfg(unix)]
#[path = "../tui/edit.rs"]
mod edit;
#[cfg(unix)]
#[path = "../tui/exec.rs"]
mod exec;
#[cfg(unix)]
#[path = "../tui/herdr.rs"]
mod herdr;
#[cfg(unix)]
#[path = "../tui/model.rs"]
mod model;
#[cfg(unix)]
#[path = "../tui/plugin.rs"]
mod plugin;
#[cfg(unix)]
#[path = "../tui/project.rs"]
mod project;

#[cfg(not(unix))]
fn main() {
    eprintln!("kns-tui: not available on this platform yet");
    std::process::exit(2);
}

#[cfg(unix)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(cli::run(&args));
}

#[cfg(unix)]
mod cli {
    use std::sync::mpsc;

    use serde_json::{Value, json};

    use super::{
        app::{self, Start},
        client::{self, Client, Msg, Tag},
        exec::{self, ExecTarget},
        herdr, plugin, project,
    };

    const USAGE: &str = "kns-tui: Kubernetes in your terminal, through the running kns

usage:
  kns-tui [resource] [-c context] [-n namespace|-A] [-l selector]   the TUI
  kns-tui logs [ctx/]ns/pod [-C container] [--previous]            follow logs
  kns-tui logs [ctx/]ns/<resource>/<name> --workload                logs of every pod of a workload
  kns-tui exec [ctx/]ns/pod [-C container] [-- command…]            a shell in a pod
  kns-tui herdr <tui|logs|exec>        entrypoint for herdr plugin panes (reads KNS_* variables)
  kns-tui herdr install                 install the herdr plugin (herdr plugin link)
  kns-tui call <method> ['{json}']      one backend call, JSON out (streams print until Ctrl+C)
  kns-tui status                        is kns running, socket, clients, background settings
  kns-tui start                         start kns in the background (tray, no window)
  kns-tui open                          open the kns window
  kns-tui keep-running on|off           keep kns in the tray when its window closes
  kns-tui login-item on|off             start kns in the background at login (macOS)

A .kns.toml in the repo (context, namespace, resource, selector) picks the first view.
Exit codes: 0 ok, 1 error, 2 usage, 3 kns not reachable.";

    pub fn run(args: &[String]) -> i32 {
        let first = args.first().map(String::as_str);
        let result = match first {
            Some("-h" | "--help" | "help") => {
                println!("{USAGE}");
                return 0;
            }
            Some("-V" | "--version") => {
                println!("kns-tui {}", env!("CARGO_PKG_VERSION"));
                return 0;
            }
            Some("logs") => logs(&args[1..]),
            Some("exec") => exec_cmd(&args[1..]),
            Some("herdr") => herdr_cmd(&args[1..]),
            Some("call") => call(&args[1..]),
            Some("status") => status(),
            Some("start") => start(),
            Some("open") => one("show_window", json!({})).map(|_| ()),
            Some("keep-running") => toggle(&args[1..], |on| json!({ "keepRunning": on })),
            Some("login-item") => toggle(&args[1..], |on| json!({ "keepRunning": true, "launchAtLogin": on })),
            Some("socket") => {
                println!("{}", super::path::socket_path().map(|p| p.display().to_string()).unwrap_or_default());
                Ok(())
            }
            _ => ui(args),
        };
        match result {
            Ok(()) => 0,
            Err(Fail::Usage(m)) => {
                eprintln!("kns-tui: {m}\n\n{USAGE}");
                2
            }
            Err(Fail::Down(m)) => {
                eprintln!("kns-tui: {m}");
                3
            }
            Err(Fail::Error(m)) => {
                eprintln!("kns-tui: {m}");
                1
            }
        }
    }

    enum Fail {
        Usage(String),
        Down(String),
        Error(String),
    }

    impl From<client::RpcError> for Fail {
        fn from(e: client::RpcError) -> Self {
            match e.reason.as_str() {
                "NotRunning" | "NotInstalled" | "Closed" | "Spawn" => Fail::Down(e.message),
                _ => Fail::Error(format!("{}: {}", e.reason, e.message)),
            }
        }
    }

    /// `-x value` / `--long value` / `--long=value`
    struct Flags {
        rest: Vec<String>,
        pairs: Vec<(String, String)>,
        switches: Vec<String>,
        tail: Vec<String>,
    }

    fn flags(args: &[String], with_value: &[&str]) -> Flags {
        let mut f = Flags { rest: vec![], pairs: vec![], switches: vec![], tail: vec![] };
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if a == "--" {
                f.tail = it.cloned().collect();
                break;
            }
            if let Some((k, v)) = a.split_once('=').filter(|(k, _)| k.starts_with("--")) {
                f.pairs.push((k.to_string(), v.to_string()));
            } else if with_value.contains(&a.as_str()) {
                if let Some(v) = it.next() {
                    f.pairs.push((a.clone(), v.clone()));
                }
            } else if a.starts_with('-') && a.len() > 1 {
                f.switches.push(a.clone());
            } else {
                f.rest.push(a.clone());
            }
        }
        f
    }

    impl Flags {
        fn get(&self, names: &[&str]) -> Option<String> {
            self.pairs.iter().rev().find(|(k, _)| names.contains(&k.as_str())).map(|(_, v)| v.clone())
        }
        fn has(&self, names: &[&str]) -> bool {
            self.switches.iter().any(|s| names.contains(&s.as_str()))
        }
    }

    fn cwd_project() -> project::Project {
        std::env::current_dir().map(|d| project::find(&d)).unwrap_or_default()
    }

    fn ui(args: &[String]) -> Result<(), Fail> {
        let f = flags(args, &["-c", "--context", "-n", "--namespace", "-l", "--selector"]);
        if let Some(bad) = f.switches.iter().find(|s| !["-A", "--all-namespaces"].contains(&s.as_str())) {
            return Err(Fail::Usage(format!("unknown option {bad}")));
        }
        let mut start = Start {
            context: f.get(&["-c", "--context"]),
            namespace: f.get(&["-n", "--namespace"]),
            resource: f.rest.first().cloned(),
            selector: f.get(&["-l", "--selector"]),
            logs: None,
            project: cwd_project(),
        };
        if f.has(&["-A", "--all-namespaces"]) {
            start.namespace = None;
            start.project.namespace = None;
        }
        app::run(start).map_err(Fail::Down)
    }

    /// `[ctx/]ns/pod` or, with `--workload`, `[ctx/]ns/<resource>/<name>`.
    fn target_from(spec: &str, workload: bool, container: Option<String>) -> Result<herdr::Target, Fail> {
        let parts: Vec<&str> = spec.split('/').collect();
        let (ctx, ns, rest): (Option<&str>, &str, String) = match (workload, parts.as_slice()) {
            (false, [c, n, p]) => (Some(c), n, p.to_string()),
            (false, [n, p]) => (None, n, p.to_string()),
            (true, [c, n, r, name]) => (Some(c), n, format!("{r}/{name}")),
            (true, [n, r, name]) => (None, n, format!("{r}/{name}")),
            _ => return Err(Fail::Usage(format!("cannot read target \"{spec}\""))),
        };
        Ok(herdr::Target {
            context: ctx.map(str::to_string),
            namespace: Some(ns.to_string()),
            pod: (!workload).then(|| rest.clone()),
            container,
            workload: workload.then_some(rest),
        })
    }

    fn logs(args: &[String]) -> Result<(), Fail> {
        let f = flags(args, &["-C", "--container"]);
        let spec = f.rest.first().ok_or_else(|| Fail::Usage("logs needs a target".into()))?;
        let target = target_from(spec, f.has(&["--workload", "-w"]), f.get(&["-C", "--container"]))?;
        logs_ui(target)
    }

    fn logs_ui(target: herdr::Target) -> Result<(), Fail> {
        let start = Start { context: target.context.clone(), namespace: target.namespace.clone(), logs: Some(target), project: cwd_project(), ..Default::default() };
        app::run(start).map_err(Fail::Down)
    }

    fn exec_cmd(args: &[String]) -> Result<(), Fail> {
        let f = flags(args, &["-C", "--container"]);
        let spec = f.rest.first().ok_or_else(|| Fail::Usage("exec needs [ctx/]ns/pod".into()))?;
        let default_ctx = current_context();
        let (context, namespace, pod) = exec::parse_target(spec, default_ctx.as_deref()).ok_or_else(|| Fail::Usage(format!("cannot read target \"{spec}\"")))?;
        exec_run(ExecTarget { context, namespace, pod, container: f.get(&["-C", "--container"]), command: f.tail })
    }

    fn exec_run(t: ExecTarget) -> Result<(), Fail> {
        match exec::run(&t) {
            Ok(0) => Ok(()),
            Ok(code) => std::process::exit(code),
            Err(e) => Err(Fail::Error(e)),
        }
    }

    fn current_context() -> Option<String> {
        let p = cwd_project();
        if p.context.is_some() {
            return p.context;
        }
        let v = one("list_contexts", json!({})).ok()?;
        v["current"].as_str().map(str::to_string)
    }

    /// herdr plugin pane entrypoints. The manifest fixes argv, so the target is in `KNS_*`.
    fn herdr_cmd(args: &[String]) -> Result<(), Fail> {
        let env = herdr::from_env();
        match args.first().map(String::as_str) {
            None | Some("tui") => {
                // a plugin pane starts in the plugin root; the workspace's directory is in the context
                if let Some(dir) = plugin::workspace_dir() {
                    let _ = std::env::set_current_dir(dir);
                }
                ui(args.get(1..).unwrap_or_default())
            }
            Some("logs") => {
                if env.pod.is_none() && env.workload.is_none() {
                    return Err(Fail::Usage("KNS_POD or KNS_WORKLOAD must be set".into()));
                }
                logs_ui(env)
            }
            Some("exec") => {
                let (Some(context), Some(namespace), Some(pod)) = (env.context.or_else(current_context), env.namespace, env.pod) else {
                    return Err(Fail::Usage("KNS_CONTEXT, KNS_NAMESPACE and KNS_POD must be set".into()));
                };
                exec_run(ExecTarget { context, namespace, pod, container: env.container, command: vec![] })
            }
            Some("install") => plugin::install().map_err(Fail::Error),
            Some("open-pane") => plugin::open_pane(args.get(1).map(String::as_str).unwrap_or("tui")).map_err(Fail::Error),
            Some(other) => Err(Fail::Usage(format!("unknown herdr entrypoint \"{other}\""))),
        }
    }

    fn connect() -> Result<(Client, mpsc::Receiver<Msg>), Fail> {
        let (tx, rx) = mpsc::channel();
        Ok((Client::connect(tx, true)?, rx))
    }

    fn one(method: &str, params: Value) -> Result<Value, Fail> {
        let (c, _rx) = connect()?;
        Ok(c.call(method, params)?)
    }

    fn call(args: &[String]) -> Result<(), Fail> {
        let method = args.first().ok_or_else(|| Fail::Usage("call needs a method (kns-tui call hello lists them)".into()))?;
        let params: Value = match args.get(1) {
            Some(p) => serde_json::from_str(p).map_err(|e| Fail::Usage(format!("params are not JSON: {e}")))?,
            None => json!({}),
        };
        let (c, rx) = connect()?;
        let streaming = ["subscribe_table", "stream_logs", "subscribe_ns_health"].contains(&method.as_str());
        if !streaming {
            let v = c.call(method, params)?;
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            return Ok(());
        }
        let id = c.call_stream(Tag { kind: "cli", epoch: 0 }, method, params)?;
        eprintln!("stream {} (Ctrl+C to stop)", id.as_str().unwrap_or_default());
        for m in rx {
            match m {
                Msg::Stream { event, .. } => println!("{}", serde_json::to_string(&event).unwrap_or_default()),
                Msg::Closed => return Err(Fail::Down("kns went away".into())),
                _ => {}
            }
        }
        Ok(())
    }

    fn status() -> Result<(), Fail> {
        let (tx, _rx) = mpsc::channel();
        let sock = super::path::socket_path().map(|p| p.display().to_string()).unwrap_or_default();
        match Client::connect(tx, false) {
            Ok(c) => {
                let h = &c.hello;
                println!("kns {} running (pid {}), protocol {}", h["version"].as_str().unwrap_or("?"), h["pid"], h["protocol"]);
                println!("socket   {sock}");
                if let Ok(b) = c.call("background_status", json!({})) {
                    println!("clients  {}", b["socket"]["clients"]);
                    println!("window   {}", if b["windowOpen"] == true { "open" } else { "closed" });
                    println!("tray     keep running {}, launch at login {}", onoff(&b["keepRunning"]), onoff(&b["launchAtLogin"]));
                }
                if let Ok(v) = c.call("connected_contexts", json!({})) {
                    let list: Vec<&str> = v.as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                    println!("contexts {}", if list.is_empty() { "(none connected)".to_string() } else { list.join(", ") });
                }
                Ok(())
            }
            Err(e) => {
                println!("kns is not running (socket {sock})");
                match client::app_binary() {
                    Some(b) => println!("start it with: kns-tui start   ({})", b.display()),
                    None => println!("kns.app not found; set KNS_APP to the kns binary"),
                }
                Err(Fail::Down(e.message))
            }
        }
    }

    fn onoff(v: &Value) -> &'static str {
        if v == true { "on" } else { "off" }
    }

    fn start() -> Result<(), Fail> {
        let (tx, _rx) = mpsc::channel();
        if Client::connect(tx.clone(), false).is_ok() {
            println!("kns is already running");
            return Ok(());
        }
        let c = Client::connect(tx, true)?;
        println!("kns {} started in the background (pid {})", c.hello["version"].as_str().unwrap_or("?"), c.hello["pid"]);
        Ok(())
    }

    fn toggle(args: &[String], params: impl Fn(bool) -> Value) -> Result<(), Fail> {
        let on = match args.first().map(String::as_str) {
            Some("on" | "true" | "yes") => true,
            Some("off" | "false" | "no") => false,
            _ => return Err(Fail::Usage("say on or off".into())),
        };
        let b = one("background_set", params(on))?;
        println!("keep running {}, launch at login {}", onoff(&b["keepRunning"]), onoff(&b["launchAtLogin"]));
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn flag_parsing() {
            let a: Vec<String> = ["pods", "-n", "shop", "--context=dev", "-A", "--", "sh", "-c", "x"].iter().map(|s| s.to_string()).collect();
            let f = flags(&a, &["-n", "--context"]);
            assert_eq!(f.rest, vec!["pods"]);
            assert_eq!(f.get(&["-n"]).as_deref(), Some("shop"));
            assert_eq!(f.get(&["--context"]).as_deref(), Some("dev"));
            assert!(f.has(&["-A"]));
            assert_eq!(f.tail, vec!["sh", "-c", "x"]);
        }

        #[test]
        fn targets() {
            let t = target_from("dev/shop/web-1", false, None).ok().unwrap();
            assert_eq!((t.context.as_deref(), t.namespace.as_deref(), t.pod.as_deref()), (Some("dev"), Some("shop"), Some("web-1")));
            let w = target_from("shop/deployments.apps/web", true, None).ok().unwrap();
            assert_eq!(w.workload.as_deref(), Some("deployments.apps/web"));
            assert!(w.context.is_none());
            assert!(target_from("x", false, None).is_err());
        }
    }
}
