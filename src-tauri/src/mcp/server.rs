//! The loopback HTTP listener (docs/plan-features.md §5.2).
//!
//! - `127.0.0.1:<port>` only (exclusive bind; a taken port fails loudly), path `/mcp`, 1 MiB body.
//! - Our own layer runs first, in this order: `Origin` present → 403 (Claude Code is not a browser
//!   and sends none; DNS rebinding and drive-by pages do); `Host` not `127.0.0.1:<port>` or
//!   `localhost:<port>` → 403; bearer token unknown or revoked → 401 without detail; rate limit
//!   → 429. The client name of the token goes into the request extensions; tools read identity
//!   from there only.
//! - rmcp's Streamable HTTP service behind it repeats the Host/Origin checks
//!   (`with_allowed_hosts`, `enforce_origin_validation`) and serves the protocol **statelessly**
//!   (`legacy_session_mode(false)`, `json_response(true)`): no `Mcp-Session-Id`, no GET stream,
//!   for 2026-07-28 as well as 2025-11-25 (H1 spike; tested below).
//! - Supported revisions: 2026-07-28 and 2025-11-25. An `initialize` asking for an older one is
//!   answered with 2025-11-25 (rmcp's negotiation), which a client that cannot speak it refuses.
use std::{borrow::Cow, sync::Arc, time::Instant};

use axum::{
    Router,
    extract::{Request, State},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use http::{HeaderValue, StatusCode, header};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, GetPromptRequestParams, GetPromptResponse, GetPromptResult, Implementation, InitializeResult, ListPromptsResult,
        ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams,
        ReadResourceResponse, ReadResourceResult, ResourceContents, ServerCapabilities, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService, session::never::NeverSessionManager},
};
use tokio_util::sync::CancellationToken;

use super::{auth::ClientName, describe, instructions::INSTRUCTIONS};
use crate::{
    ipc::{BackendError, Result},
    state::{AppState, lock},
};

pub const PATH: &str = "/mcp";
pub const MAX_BODY: usize = 1024 * 1024;
pub static VERSIONS: &[ProtocolVersion] = &[ProtocolVersion::V_2025_11_25, ProtocolVersion::V_2026_07_28];

/// One per request (the service factory); all state is in `AppState`.
#[derive(Clone)]
pub struct KnsServer {
    pub state: AppState,
}

impl ServerHandler for KnsServer {
    fn get_info(&self) -> InitializeResult {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().enable_resources().enable_prompts().build())
            .with_server_info(Implementation::new("kns", env!("CARGO_PKG_VERSION")).with_title("kns"))
            .with_instructions(INSTRUCTIONS)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(VERSIONS)
    }

    async fn list_tools(&self, _request: Option<PaginatedRequestParams>, _context: RequestContext<RoleServer>) -> std::result::Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tool_list()))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        tool_list().into_iter().find(|t| t.name == name)
    }

    async fn call_tool(&self, request: CallToolRequestParams, context: RequestContext<RoleServer>) -> std::result::Result<CallToolResponse, ErrorData> {
        let client = client_of(&context)?;
        let args = serde_json::Value::Object(request.arguments.unwrap_or_default());
        Ok(super::tools::call(&self.state, &client, &request.name, args).await.into())
    }

    async fn list_resources(&self, _request: Option<PaginatedRequestParams>, context: RequestContext<RoleServer>) -> std::result::Result<ListResourcesResult, ErrorData> {
        let client = client_of(&context)?;
        Ok(ListResourcesResult::with_all_items(super::resources::list(&self.state, &client).await))
    }

    async fn list_resource_templates(&self, _request: Option<PaginatedRequestParams>, context: RequestContext<RoleServer>) -> std::result::Result<ListResourceTemplatesResult, ErrorData> {
        client_of(&context)?;
        Ok(ListResourceTemplatesResult::with_all_items(super::resources::templates()))
    }

    async fn read_resource(&self, request: ReadResourceRequestParams, context: RequestContext<RoleServer>) -> std::result::Result<ReadResourceResponse, ErrorData> {
        let client = client_of(&context)?;
        match super::resources::read(&self.state, &client, &request.uri).await {
            Ok(text) => Ok(ReadResourceResult::new(vec![ResourceContents::text(text, request.uri.clone()).with_mime_type("application/json")]).into()),
            Err(e) => Err(mcp_error(e)),
        }
    }

    async fn list_prompts(&self, _request: Option<PaginatedRequestParams>, context: RequestContext<RoleServer>) -> std::result::Result<ListPromptsResult, ErrorData> {
        client_of(&context)?;
        Ok(ListPromptsResult::with_all_items(super::prompts::list()))
    }

    async fn get_prompt(&self, request: GetPromptRequestParams, context: RequestContext<RoleServer>) -> std::result::Result<GetPromptResponse, ErrorData> {
        client_of(&context)?;
        let (description, messages) = super::prompts::get(&request.name, request.arguments.as_ref()).map_err(mcp_error)?;
        Ok(GetPromptResult::new(messages).with_description(description).into())
    }
}

/// The token's client name (auth layer), never the session or `clientInfo`.
fn client_of(context: &RequestContext<RoleServer>) -> std::result::Result<String, ErrorData> {
    context
        .extensions
        .get::<http::request::Parts>()
        .and_then(|p| p.extensions.get::<ClientName>())
        .map(|c| c.0.clone())
        .ok_or_else(|| ErrorData::internal_error("unauthenticated request reached the server", None))
}

/// An agent error as a JSON-RPC error (resources and prompts have no tool-error form).
fn mcp_error(e: super::McpError) -> ErrorData {
    let data = serde_json::to_value(&e).ok();
    if e.code == "NotFound" { ErrorData::resource_not_found(e.message, data) } else { ErrorData::invalid_request(e.message, data) }
}

/// The tool list as MCP `Tool`s (the same table the hub and the docs read).
pub fn tool_list() -> Vec<Tool> {
    describe::TOOLS
        .iter()
        .map(|t| {
            let mut tool = Tool::new(t.name, t.description, (t.schema)()).with_title(t.title);
            tool.annotations = Some(
                rmcp::model::ToolAnnotations::with_title(t.title)
                    .read_only(t.need == super::policy::Need::Read)
                    .destructive(false)
                    .open_world(false),
            );
            tool
        })
        .collect()
}

/// The authorities a request may name in `Host`.
pub fn allowed_hosts(port: u16) -> Vec<String> {
    vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")]
}

#[derive(Clone)]
struct Gate {
    state: AppState,
    hosts: Arc<Vec<String>>,
}

fn status(code: StatusCode, body: &'static str) -> Response {
    (code, body).into_response()
}

async fn gate(State(g): State<Gate>, mut req: Request, next: Next) -> Response {
    if req.headers().contains_key(header::ORIGIN) {
        return status(StatusCode::FORBIDDEN, "Forbidden: Origin not allowed");
    }
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or_default().to_ascii_lowercase();
    if !g.hosts.contains(&host) {
        return status(StatusCode::FORBIDDEN, "Forbidden: Host not allowed");
    }
    let token = super::auth::bearer(req.headers().get(header::AUTHORIZATION).and_then(|h| h.to_str().ok()));
    let Some(client) = token.and_then(|t| super::client_for_token(&g.state, t)) else {
        let mut r = status(StatusCode::UNAUTHORIZED, "Unauthorized");
        r.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return r;
    };
    let mcp = g.state.ext::<super::McpState>();
    let limited = lock(&mcp.limiter).acquire(&client, Instant::now());
    if limited.is_err() {
        let after = lock(&mcp.limiter).retry_after(&client).as_secs().max(1);
        let mut r = status(StatusCode::TOO_MANY_REQUESTS, "Too Many Requests");
        if let Ok(v) = HeaderValue::from_str(&after.to_string()) {
            r.headers_mut().insert(header::RETRY_AFTER, v);
        }
        return r;
    }
    // released on drop: a client that disconnects mid-call (axum drops this future) must not
    // leak an in-flight slot, or four aborted `wait_proposal`s would lock it out until restart
    let _slot = InFlight { mcp: mcp.clone(), client: client.clone() };
    super::touch(&g.state, &client);
    req.extensions_mut().insert(ClientName(client));
    next.run(req).await
}

struct InFlight {
    mcp: Arc<super::McpState>,
    client: String,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        lock(&self.mcp.limiter).done(&self.client);
    }
}

/// The router: our gate in front of rmcp's service at `/mcp`.
pub fn router(state: AppState, port: u16, cancel: CancellationToken) -> Router {
    let hosts = allowed_hosts(port);
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts(hosts.clone())
        .enforce_origin_validation()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        .with_sse_retry(None)
        .with_max_request_body_bytes(MAX_BODY)
        .with_cancellation_token(cancel.child_token());
    let factory_state = state.clone();
    let service = StreamableHttpService::new(move || Ok(KnsServer { state: factory_state.clone() }), Arc::new(NeverSessionManager::default()), config);
    Router::new()
        .route_service(PATH, service)
        .layer(middleware::from_fn_with_state(Gate { state, hosts: Arc::new(hosts) }, gate))
}

/// Binds `127.0.0.1:<port>` (exclusively) and serves until the returned token is cancelled.
pub async fn start(state: AppState, port: u16) -> Result<CancellationToken> {
    let std_listener = crate::forward::choose_listener(std::net::Ipv4Addr::LOCALHOST.into(), Some(port), true).map_err(|e| {
        if e.reason == "AddrInUse" {
            BackendError::new(0, "AddrInUse", format!("port {port} is in use by another program; pick another with \":mcp port <n>\""))
        } else {
            e
        }
    })?;
    std_listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(std_listener)?;
    let cancel = CancellationToken::new();
    let app = router(state, port, cancel.clone());
    let stop = cancel.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(stop.cancelled_owned()).await;
    });
    Ok(cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ipc::McpPolicy, mcp};
    use http_body_util::BodyExt;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    const PORT: u16 = 7099;

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

    fn post(token: Option<&str>, body: Value, extra: &[(&str, &str)]) -> Request {
        let mut b = http::Request::post(PATH)
            .header(header::HOST, format!("127.0.0.1:{PORT}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream");
        if let Some(t) = token {
            b = b.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        b.body(axum::body::Body::from(body.to_string())).unwrap()
    }

    async fn send(state: &AppState, req: Request) -> (StatusCode, Value) {
        let app = router(state.clone(), PORT, CancellationToken::new());
        let res = app.oneshot(req).await.unwrap();
        let code = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).to_string();
        // json_response: plain JSON; fall back to the first SSE data line
        let v = serde_json::from_str(&text).unwrap_or_else(|_| {
            text.lines().find_map(|l| l.strip_prefix("data:")).and_then(|d| serde_json::from_str(d.trim()).ok()).unwrap_or(Value::String(text))
        });
        (code, v)
    }

    fn initialize(version: &str) -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": version, "capabilities": {}, "clientInfo": { "name": "evil-name", "version": "1" } } })
    }

    #[tokio::test]
    async fn auth_origin_host() {
        let (state, base) = mcp::testing::state("srv-auth").await;
        let token = add_client(&state, "claude-code").await;
        // missing and bad tokens → 401
        assert_eq!(send(&state, post(None, initialize("2025-11-25"), &[])).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(send(&state, post(Some("bad"), initialize("2025-11-25"), &[])).await.0, StatusCode::UNAUTHORIZED);
        // Origin present → 403, even with a valid token
        let (code, _) = send(&state, post(Some(&token), initialize("2025-11-25"), &[("origin", "http://evil.example")])).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        // bad Host → 403
        let mut req = post(Some(&token), initialize("2025-11-25"), &[]);
        req.headers_mut().insert(header::HOST, HeaderValue::from_static("evil.example"));
        assert_eq!(send(&state, req).await.0, StatusCode::FORBIDDEN);
        let mut req = post(Some(&token), initialize("2025-11-25"), &[]);
        req.headers_mut().insert(header::HOST, HeaderValue::from_static("127.0.0.1:8080"));
        assert_eq!(send(&state, req).await.0, StatusCode::FORBIDDEN);
        // ok
        let (code, v) = send(&state, post(Some(&token), initialize("2025-11-25"), &[])).await;
        assert_eq!(code, StatusCode::OK, "{v}");
        // revoked → 401
        mcp::client_revoke(&state, "claude-code").await.unwrap();
        assert_eq!(send(&state, post(Some(&token), initialize("2025-11-25"), &[])).await.0, StatusCode::UNAUTHORIZED);
        let _ = std::fs::remove_dir_all(base);
    }

    /// Integration (wave 2): over real HTTP, every H2 tool that can lead to a side effect is refused
    /// at policy `read`, and the Origin / Host / token gate also guards resources and prompts.
    #[tokio::test]
    async fn wave2_tools_refuse_at_read_and_gate_holds() {
        let (state, base) = mcp::testing::state("srv-wave2").await;
        let token = add_client(&state, "claude-code").await;
        crate::uistate::publish(&state, crate::ipc::UiState { context: Some("default".into()), connected: vec!["default".into()], ..Default::default() });
        mcp::policy_set(&state, "default", McpPolicy::Read, None).await.unwrap();
        // a saved set, so the id tools get past the lookup and meet the policy check; the store file
        // is written directly (`devset::save` checks the namespaces in a cluster)
        let set = crate::ipc::DevSet {
            id: "ds-web".into(),
            name: "web-dev".into(),
            context: "default".into(),
            forwards: vec![crate::ipc::DevForward {
                key: "web".into(),
                target: crate::ipc::ForwardTarget::Service { namespace: "kns-spike".into(), name: "web".into() },
                remote_port: crate::ipc::PortRef::Number(80),
                local_port: 18080,
                pin: true,
                label: None,
            }],
            rewrites: vec![],
            env: None,
            auto_start: false,
            conn_secrets: None,
            origin: crate::ipc::DevSetOrigin::Agent { client: "claude-code".into(), at: "t".into() },
            hash: "h".into(),
            approved_hash: None,
            approved_snapshot: None,
            updated_at: "t".into(),
        };
        let id = set.id.clone();
        std::fs::create_dir_all(base.join("devsets")).unwrap();
        std::fs::write(base.join("devsets").join("devsets.json"), json!({ "schema": 1, "sets": [set] }).to_string()).unwrap();
        crate::devset::use_dir(&state, base.join("devsets"));
        assert!(crate::devset::get(&state, &id).await.unwrap().is_some());
        let hdr = [("mcp-protocol-version", "2025-11-25")];
        let r = json!({ "context": "default", "kind": "deployments", "namespace": "kns-spike", "name": "web" });
        let calls = [
            ("propose_forward", json!({ "context": "default", "target": { "kind": "service", "namespace": "kns-spike", "name": "web" }, "remotePort": 80 })),
            ("propose_scale", json!({ "ref": r, "replicas": 3 })),
            ("propose_restart", json!({ "ref": r })),
            ("propose_delete", json!({ "ref": r })),
            ("propose_reconcile", json!({ "ref": r })),
            ("propose_apply", json!({ "context": "default", "yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x, namespace: kns-spike}\n" })),
            ("propose_env_export", json!({ "ref": r })),
            ("propose_dev_set_up", json!({ "id": id })),
            ("save_dev_set", json!({ "set": { "name": "x", "forwards": [], "rewrites": [] } })),
            ("delete_dev_set", json!({ "id": id })),
            ("stop_dev_set", json!({ "id": id })),
            ("draft_dev_set_from_workload", json!({ "ref": r, "name": "x" })),
        ];
        for (i, (tool, args)) in calls.iter().enumerate() {
            let body = json!({ "jsonrpc": "2.0", "id": 10 + i, "method": "tools/call", "params": { "name": tool, "arguments": args } });
            let (code, v) = send(&state, post(Some(&token), body, &hdr)).await;
            assert_eq!(code, StatusCode::OK, "{tool}: {v}");
            let text = v["result"]["content"][0]["text"].as_str().unwrap_or_default();
            assert_eq!(v["result"]["isError"], true, "{tool}: {v}");
            assert!(text.contains("PolicyDenied"), "{tool}: {text}");
        }
        assert!(crate::proposals::list(&state).is_empty(), "nothing was proposed");
        assert!(crate::devset::get(&state, &id).await.unwrap().is_some(), "the agent's own set was not deleted");
        // the gate in front of resources and prompts: Origin 403, no token 401, wrong Host 403
        let read = json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/read", "params": { "uri": "kns://selection" } });
        let prompt = json!({ "jsonrpc": "2.0", "id": 3, "method": "prompts/get", "params": { "name": "dev_config", "arguments": { "target": "web" } } });
        for body in [read, prompt] {
            assert_eq!(send(&state, post(Some(&token), body.clone(), &[("origin", "http://web.kns-spike.localhost:7080")])).await.0, StatusCode::FORBIDDEN);
            assert_eq!(send(&state, post(Some(&token), body.clone(), &[("origin", "null")])).await.0, StatusCode::FORBIDDEN);
            assert_eq!(send(&state, post(None, body.clone(), &hdr)).await.0, StatusCode::UNAUTHORIZED);
            let mut req = post(Some(&token), body, &hdr);
            req.headers_mut().insert(header::HOST, HeaderValue::from_static("web.kns-spike.localhost:7099"));
            assert_eq!(send(&state, req).await.0, StatusCode::FORBIDDEN);
        }
        let _ = std::fs::remove_dir_all(base);
    }

    /// The spike: a 2025-11-25 client runs initialize → tools/list → tools/call without a session,
    /// with and without the MCP-Protocol-Version header.
    #[tokio::test]
    async fn stateless_legacy_flow() {
        let (state, base) = mcp::testing::state("srv-flow").await;
        let token = add_client(&state, "claude-code").await;
        let (code, v) = send(&state, post(Some(&token), initialize("2025-11-25"), &[])).await;
        assert_eq!(code, StatusCode::OK, "{v}");
        assert_eq!(v["result"]["protocolVersion"], "2025-11-25", "{v}");
        assert!(v["result"]["instructions"].as_str().unwrap().contains("get_status"));
        // older revision requested → answered with a supported one
        let (_, v) = send(&state, post(Some(&token), initialize("2024-11-05"), &[])).await;
        assert_eq!(v["result"]["protocolVersion"], "2025-11-25", "{v}");

        let hdr = [("mcp-protocol-version", "2025-11-25")];
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let (code, _) = send(&state, post(Some(&token), initialized, &hdr)).await;
        assert!(code.is_success(), "{code}");

        let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let (code, v) = send(&state, post(Some(&token), list.clone(), &hdr)).await;
        assert_eq!(code, StatusCode::OK, "{v}");
        let names: Vec<&str> = v["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"get_status") && names.contains(&"explain_why"), "{names:?}");

        // without the header
        let (code, v) = send(&state, post(Some(&token), list, &[])).await;
        assert_eq!(code, StatusCode::OK, "a missing MCP-Protocol-Version header still works: {v}");
        assert!(v["result"]["tools"].is_array(), "{v}");

        let call = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "get_status", "arguments": {} } });
        let (code, v) = send(&state, post(Some(&token), call, &hdr)).await;
        assert_eq!(code, StatusCode::OK, "{v}");
        let sc = &v["result"]["structuredContent"];
        assert_eq!(sc["hiddenContexts"], 0, "{v}");
        assert!(sc["hint"].as_str().unwrap().contains(":mcp"), "{v}");
        // identity is the token's name in the audit, not clientInfo
        let rows = mcp::audit_tail(&state, 5).await.unwrap();
        assert_eq!(rows[0].client, "claude-code");
        assert_eq!(rows[0].tool, "get_status");

        mcp::policy_set(&state, "default", McpPolicy::Read, None).await.unwrap();
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn current_revision_is_served_statelessly() {
        let (state, base) = mcp::testing::state("srv-2026").await;
        let token = add_client(&state, "claude-code").await;
        let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": { "_meta": {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { "name": "x", "version": "1" } } } });
        let (code, v) = send(&state, post(Some(&token), list, &[("mcp-protocol-version", "2026-07-28"), ("mcp-method", "tools/list")])).await;
        assert_eq!(code, StatusCode::OK, "{v}");
        assert!(v["result"]["tools"].as_array().is_some_and(|t| !t.is_empty()), "{v}");
        assert!(v.get("error").is_none(), "{v}");
        let _ = std::fs::remove_dir_all(base);
    }

    /// H2: prompts and resources are served with the token's identity; the dev_config prompt
    /// expands, and resources/read goes through the policy check.
    #[tokio::test]
    async fn prompts_and_resources_over_http() {
        let (state, base) = mcp::testing::state("srv-h2").await;
        let token = add_client(&state, "claude-code").await;
        let hdr = [("mcp-protocol-version", "2025-11-25")];
        let (_, v) = send(&state, post(Some(&token), initialize("2025-11-25"), &[])).await;
        assert!(v["result"]["capabilities"]["prompts"].is_object() && v["result"]["capabilities"]["resources"].is_object(), "{v}");
        let (_, v) = send(&state, post(Some(&token), json!({ "jsonrpc": "2.0", "id": 2, "method": "prompts/list" }), &hdr)).await;
        assert_eq!(v["result"]["prompts"][0]["name"], "dev_config", "{v}");
        let get = json!({ "jsonrpc": "2.0", "id": 3, "method": "prompts/get", "params": { "name": "dev_config", "arguments": { "target": "orders", "mode": "run-locally" } } });
        let (_, v) = send(&state, post(Some(&token), get, &hdr)).await;
        let text = v["result"]["messages"][0]["content"]["text"].as_str().unwrap_or_default();
        assert!(text.contains("orders") && text.contains("propose_dev_set_up"), "{v}");
        let (_, v) = send(&state, post(Some(&token), json!({ "jsonrpc": "2.0", "id": 4, "method": "resources/list" }), &hdr)).await;
        assert!(v["result"]["resources"].as_array().unwrap().iter().any(|r| r["uri"] == "kns://selection"), "{v}");
        let read = json!({ "jsonrpc": "2.0", "id": 5, "method": "resources/read", "params": { "uri": "kns://selection" } });
        let (_, v) = send(&state, post(Some(&token), read, &hdr)).await;
        assert!(v["error"].is_object(), "policy off: denied: {v}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test]
    async fn rate_limited() {
        let (state, base) = mcp::testing::state("srv-rate").await;
        let token = add_client(&state, "claude-code").await;
        let mut last = StatusCode::OK;
        for _ in 0..40 {
            last = send(&state, post(Some(&token), initialize("2025-11-25"), &[])).await.0;
            if last == StatusCode::TOO_MANY_REQUESTS {
                break;
            }
        }
        assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
        let _ = std::fs::remove_dir_all(base);
    }
}
