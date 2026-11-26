//! The stdio shim against the real server (H3 acceptance): the listener of `server::start` on a
//! free loopback port, the auth gate and rmcp behind it, the shim's own HTTP client in front.
//! No cluster: only `get_status`, prompts and the policy-denied resource are called.
use std::{path::PathBuf, sync::Arc};

use serde_json::{Value, json};

use super::shim::{Outcome, Shim};
use crate::{mcp, state::AppState};

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn write_config(base: &std::path::Path, port: u16, enabled: bool) -> PathBuf {
    let path = base.join("shim").join("mcp.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, json!({ "schema": 1, "enabled": enabled, "port": port }).to_string()).unwrap();
    path
}

async fn add_client(state: &AppState, name: &str) -> String {
    let token = mcp::auth::new_token();
    let hash = mcp::auth::hash_token(&token);
    mcp::update(state, |c| {
        c.clients.push(mcp::StoredClient { name: name.into(), token_sha256: hash, created_at: "t".into() });
        Ok(())
    })
    .await
    .unwrap();
    token
}

/// Runs one message through the shim on a blocking thread (the server shares the runtime).
async fn through(shim: &Arc<Shim>, msg: Value) -> Outcome {
    let shim = shim.clone();
    tokio::task::spawn_blocking(move || shim.handle(&msg.to_string())).await.unwrap()
}

fn one(o: &Outcome) -> Value {
    assert_eq!(o.stdout.len(), 1, "{o:?}");
    assert!(!o.stdout[0].contains('\n'));
    serde_json::from_str(&o.stdout[0]).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_list_through_the_shim_and_revoked_token_is_401() {
    let (state, base) = mcp::testing::state("shim-e2e").await;
    let token = add_client(&state, "claude-code").await;
    let port = free_port();
    let cancel = mcp::server::start(state.clone(), port).await.unwrap();
    let config = write_config(&base, port, true);
    let shim = Arc::new(Shim::new(Some(config.clone()), Some(token.clone())));

    // revision 2025-11-25: initialize agrees on it, later requests carry it
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "stdio-client", "version": "1" } } });
    let v = one(&through(&shim, init).await);
    assert_eq!(v["result"]["protocolVersion"], "2025-11-25", "{v}");
    let o = through(&shim, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert!(o.stdout.is_empty(), "a notification has no answer: {o:?}");
    let v = one(&through(&shim, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await);
    let names: Vec<&str> = v["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"get_status") && names.contains(&"propose_dev_set_up"), "{names:?}");
    let call = json!({ "jsonrpc": "2.0", "id": "c3", "method": "tools/call", "params": { "name": "get_status", "arguments": {} } });
    let v = one(&through(&shim, call).await);
    assert_eq!(v["id"], "c3");
    assert!(v["result"]["structuredContent"]["hint"].as_str().unwrap_or_default().contains(":mcp"), "{v}");
    let prompt = json!({ "jsonrpc": "2.0", "id": 4, "method": "prompts/get", "params": { "name": "dev_config", "arguments": { "target": "web" } } });
    let v = one(&through(&shim, prompt).await);
    assert!(v["result"]["messages"][0]["content"]["text"].as_str().unwrap_or_default().contains("web"), "{v}");
    // a JSON-RPC error from the server passes through unchanged (policy off)
    let read = json!({ "jsonrpc": "2.0", "id": 5, "method": "resources/read", "params": { "uri": "kns://selection" } });
    let v = one(&through(&shim, read).await);
    assert!(v["error"].is_object() && v["error"]["data"]["kns"].is_null(), "{v}");
    // identity is the token's name, not clientInfo
    let rows = mcp::audit_tail(&state, 10).await.unwrap();
    assert!(rows.iter().any(|r| r.client == "claude-code" && r.tool == "get_status"), "{rows:?}");

    // revision 2026-07-28: no initialize; _meta and the Mcp-Method/Mcp-Name headers
    let meta = json!({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { "name": "x", "version": "1" } });
    let fresh = Arc::new(Shim::new(Some(config.clone()), Some(token.clone())));
    let v = one(&through(&fresh, json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list", "params": { "_meta": meta } })).await);
    assert!(v["result"]["tools"].as_array().is_some_and(|t| !t.is_empty()), "{v}");
    let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "get_status", "arguments": {}, "_meta": meta } });
    let v = one(&through(&fresh, call).await);
    assert!(v["result"]["structuredContent"].is_object(), "Mcp-Name matched the body: {v}");

    // a wrong token and a revoked token: 401 as a JSON-RPC error with the request id
    let wrong = Arc::new(Shim::new(Some(config.clone()), Some("not-a-token".into())));
    let v = one(&through(&wrong, json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/list" })).await);
    assert_eq!((v["id"].clone(), v["error"]["data"]["kns"].clone()), (json!(8), json!("Unauthorized")), "{v}");
    mcp::client_revoke(&state, "claude-code").await.unwrap();
    let o = through(&shim, json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/list" })).await;
    let v = one(&o);
    assert_eq!(v["id"], 9);
    assert_eq!(v["error"]["data"]["kns"], "Unauthorized", "{v}");
    assert!(v["error"]["message"].as_str().unwrap().contains("401"));
    assert!(!o.stdout[0].contains(&token) && !o.stderr.unwrap_or_default().contains(&token), "the token is never echoed");

    // the app stops: "kns is not running"; with the server switched off the hint says ":mcp on"
    cancel.cancel();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let v = one(&through(&shim, json!({ "jsonrpc": "2.0", "id": 10, "method": "tools/list" })).await);
    assert_eq!(v["error"]["data"]["kns"], "NotRunning", "{v}");
    assert!(v["error"]["message"].as_str().unwrap().contains(&format!("127.0.0.1:{port}")), "{v}");
    write_config(&base, port, false);
    let v = one(&through(&shim, json!({ "jsonrpc": "2.0", "id": 11, "method": "ping" })).await);
    assert!(v["error"]["message"].as_str().unwrap().contains(":mcp on"), "{v}");
    let _ = std::fs::remove_dir_all(base);
}

/// The CLI (`kns-mcp tools / help / call / resources / guide`) against the real server.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cli_commands_through_the_real_server() {
    use super::cli::command;
    let (state, base) = mcp::testing::state("cli-e2e").await;
    let token = add_client(&state, "kns-cli").await;
    let port = free_port();
    let cancel = mcp::server::start(state.clone(), port).await.unwrap();
    let config = write_config(&base, port, true);
    let shim = Arc::new(Shim::new(Some(config.clone()), Some(token)));
    let run = |cmd: &'static str, args: Vec<&'static str>| {
        let shim = shim.clone();
        tokio::task::spawn_blocking(move || {
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            command(&shim, cmd, &args, &mut std::io::empty())
        })
    };

    let tools = run("tools", vec![]).await.unwrap().unwrap();
    assert!(tools.contains("get_status") && tools.contains("propose_scale"), "{tools}");
    assert!(tools.lines().any(|l| l.starts_with("get_status") && l.contains(" read ")), "{tools}");
    let json: Value = serde_json::from_str(&run("tools", vec!["--json"]).await.unwrap().unwrap()).unwrap();
    assert!(json.as_array().is_some_and(|t| t.len() > 20));

    let help = run("help", vec!["get_logs"]).await.unwrap().unwrap();
    assert!(help.contains("ref.kind *") && help.contains("tail") && help.contains("Example: kns-mcp call get_logs"), "{help}");
    let e = run("help", vec!["get_stat"]).await.unwrap().unwrap_err();
    assert!(e.code == 2 && e.message.contains("get_status"), "{e:?}");

    let status: Value = serde_json::from_str(&run("call", vec!["get_status"]).await.unwrap().unwrap()).unwrap();
    assert!(status["hint"].as_str().unwrap_or_default().contains(":mcp"), "{status}");
    // typed arguments reach the server; a policy-off context is a tool error (exit 1)
    let e = run("call", vec!["list_resources", "kind=pods", "limit=5", "context=nope"]).await.unwrap().unwrap_err();
    assert_eq!(e.code, 1, "{e:?}");
    // an unknown argument is the server's own error, not a crash
    let e = run("call", vec!["get_status", "bogus:=1"]).await.unwrap().unwrap_err();
    assert_eq!(e.code, 1, "{e:?}");

    let guide = run("guide", vec![]).await.unwrap().unwrap();
    assert!(guide.contains("get_status") && guide.contains("kns-mcp help"), "{guide}");
    assert!(run("resources", vec![]).await.unwrap().is_ok());

    // kns gone: exit 3
    cancel.cancel();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let e = run("call", vec!["get_status"]).await.unwrap().unwrap_err();
    assert_eq!(e.code, 3, "{e:?}");
    let _ = std::fs::remove_dir_all(base);
}
