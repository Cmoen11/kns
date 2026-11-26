//! The command-line face of `kns-mcp`: the MCP server's tools as shell commands, for agents that
//! run commands but do not (or will not) register an MCP server.
//!
//! ```text
//! kns-mcp guide                         the server instructions an MCP client would show its model
//! kns-mcp tools [--json]                every tool and its one-line summary
//! kns-mcp help <tool>                   a tool's description and parameters, with an example
//! kns-mcp call <tool> [ARG...]          call a tool, print its result as JSON
//! kns-mcp resources [--json]            readable resources (`kns://selection`, dev sets …)
//! kns-mcp read <uri>                    read one resource
//! ```
//!
//! Every command is one MCP request through [`Shim::handle`], so it is exactly as much access as
//! the stdio shim: the same token (`KNS_MCP_TOKEN`, else `rust/cli-token`), port lookup, loopback-only connection,
//! policies, approvals and audit. It adds nothing of its own and never opens a cluster connection.
//!
//! Arguments of `call` are `path=value` (a string, made a number or boolean when the tool's schema
//! says so), `path:=json` (raw JSON), a JSON object, or `-` (a JSON object from stdin). A path is
//! dotted: `ref.kind=pod`, `refs.0.name=web`.
//!
//! Exit codes: 0 ok, 1 the tool or server answered with an error, 2 bad usage, 3 kns could not be
//! reached (not running, server off, no or revoked token).
//!
//! Compiled twice like `shim.rs` (into the lib for tests, into `src/bin/kns-mcp.rs` via `#[path]`),
//! so it reaches the shim as `super::shim` and uses std and `serde_json` only.
use std::io::Read;

use serde_json::{Map, Value, json};

use super::shim::{self, Shim};

/// The MCP revision the CLI speaks: no `initialize`, each request carries its `_meta`.
const REVISION: &str = "2026-07-28";

pub const USAGE: &str = "kns-mcp: the MCP server of the running kns app, as a stdio MCP server or as shell commands.

Usage: kns-mcp                        serve MCP over stdin/stdout (for MCP clients)
       kns-mcp guide                  how to use kns as an agent (read this first)
       kns-mcp tools [--json]         list the tools
       kns-mcp help <tool>            a tool's description and parameters
       kns-mcp call <tool> [ARG...]   call a tool; prints its result as JSON
       kns-mcp resources [--json]     list readable resources
       kns-mcp read <uri>             read a resource (e.g. kns://selection)
       kns-mcp --check                ask kns for its tool list once and report
       kns-mcp --help | --version

Arguments of call:
  path=value     a string; a number or boolean when the tool's schema says so
  path:=json     raw JSON (numbers, booleans, arrays, objects)
  '{...}'        a JSON object with the arguments
  -              a JSON object read from stdin
  A path is dotted: ref.kind=pod ref.name=web ref.namespace=shop, refs.0.name=web.
Options of call: --compact (one-line JSON), --raw (the whole MCP result).

Examples:
  kns-mcp call get_status
  kns-mcp call list_resources kind=pods namespace=shop limit=20
  kns-mcp call explain_why ref.kind=deploy ref.name=web ref.namespace=shop
  kns-mcp call get_logs ref.kind=pod ref.name=web-7d9f ref.namespace=shop tail=100 grep=error

Exit codes: 0 ok, 1 the tool answered with an error, 2 bad usage, 3 kns not reachable.
Token: KNS_MCP_TOKEN (the agent's token from \":mcp setup\" in kns), else the CLI token
       kns wrote when its agent skill was installed (\":mcp skill\").
Reads the port from the kns settings; never connects anywhere but 127.0.0.1.";

/// The subcommands this module handles; anything else goes to the shim.
pub fn is_command(arg: &str) -> bool {
    matches!(arg, "guide" | "tools" | "help" | "call" | "resources" | "read")
}

/// The program: CLI commands here, everything else (no argument, `--check`, …) in the shim.
pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("--help" | "-h") => {
            println!("{USAGE}");
            0
        }
        Some(cmd) if is_command(cmd) => {
            let shim = Shim::from_env();
            let mut stdin = std::io::stdin();
            match command(&shim, cmd, &args[1..], &mut stdin) {
                Ok(out) => {
                    if !out.is_empty() {
                        println!("{out}");
                    }
                    0
                }
                Err(e) => {
                    if let Some(out) = &e.stdout {
                        println!("{out}");
                    }
                    eprintln!("kns-mcp: {}", e.message);
                    e.code
                }
            }
        }
        _ => shim::run(args),
    }
}

/// A failed command: the message for stderr and the exit code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError {
    pub code: i32,
    pub message: String,
    /// what still goes to stdout (a tool error's JSON, so a script can read its code and hint)
    pub stdout: Option<String>,
}

impl CliError {
    fn usage(message: impl Into<String>) -> Self {
        Self { code: 2, message: message.into(), stdout: None }
    }
    fn tool(message: impl Into<String>) -> Self {
        Self { code: 1, message: message.into(), stdout: None }
    }
}

/// Runs one command; returns what goes to stdout.
pub fn command(shim: &Shim, cmd: &str, args: &[String], stdin: &mut dyn Read) -> Result<String, CliError> {
    let flag = |name: &str| args.iter().any(|a| a == name);
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    match cmd {
        "guide" => guide(shim),
        "tools" => {
            let tools = list(shim, "tools/list", "tools")?;
            if flag("--json") { Ok(pretty(&Value::Array(tools))) } else { Ok(tool_table(&tools)) }
        }
        "help" => {
            let name = positional.first().ok_or_else(|| CliError::usage("help needs a tool name: kns-mcp help <tool> (kns-mcp tools lists them)"))?;
            let tools = list(shim, "tools/list", "tools")?;
            let tool = find_tool(&tools, name)?;
            Ok(tool_help(tool))
        }
        "call" => call(shim, args, stdin),
        "resources" => {
            let mut all = list(shim, "resources/list", "resources")?;
            let templates = list(shim, "resources/templates/list", "resourceTemplates").unwrap_or_default();
            if flag("--json") {
                return Ok(pretty(&json!({ "resources": all, "resourceTemplates": templates })));
            }
            all.extend(templates);
            Ok(resource_table(&all))
        }
        "read" => {
            let uri = positional.first().ok_or_else(|| CliError::usage("read needs a resource URI: kns-mcp read kns://selection (kns-mcp resources lists them)"))?;
            let result = request(shim, "resources/read", json!({ "uri": uri }))?;
            let texts: Vec<String> = result.get("contents").and_then(Value::as_array).into_iter().flatten().filter_map(|c| c.get("text").and_then(Value::as_str)).map(pretty_text).collect();
            Ok(texts.join("\n"))
        }
        other => Err(CliError::usage(format!("unknown command \"{}\"", clean(other)))),
    }
}

/// `guide`: the server instructions (from `initialize`) and a pointer to the other commands.
fn guide(shim: &Shim) -> Result<String, CliError> {
    let params = json!({ "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "kns-mcp-cli", "version": env!("CARGO_PKG_VERSION") } });
    let result = request_raw(shim, "initialize", params)?;
    let instructions = result.get("instructions").and_then(Value::as_str).unwrap_or("(kns sent no instructions)");
    Ok(format!(
        "{instructions}\n\nWith this CLI: `kns-mcp tools` lists the tools, `kns-mcp help <tool>` shows a tool's parameters, `kns-mcp call <tool> key=value …` calls it."
    ))
}

/// `call`: build the arguments, call the tool, print the result.
fn call(shim: &Shim, args: &[String], stdin: &mut dyn Read) -> Result<String, CliError> {
    let mut rest = args.iter();
    let name = rest.next().filter(|n| !n.starts_with("--")).ok_or_else(|| CliError::usage("call needs a tool name: kns-mcp call <tool> [ARG...] (kns-mcp tools lists them)"))?;
    let (mut compact, mut raw) = (false, false);
    let mut items = Vec::new();
    for a in rest {
        match a.as_str() {
            "--compact" => compact = true,
            "--raw" => raw = true,
            s if s.starts_with("--") => return Err(CliError::usage(format!("unknown option \"{}\" for call", clean(s)))),
            _ => items.push(a.as_str()),
        }
    }
    // the schema is only needed to type `path=value` arguments
    let schema = if items.iter().any(|i| is_assignment(i) && !i.contains(":=")) {
        let tools = list(shim, "tools/list", "tools")?;
        Some(find_tool(&tools, name)?.get("inputSchema").cloned().unwrap_or(Value::Null))
    } else {
        None
    };
    let arguments = build_arguments(&items, schema.as_ref(), stdin)?;
    let result = request(shim, "tools/call", json!({ "name": name, "arguments": arguments }))?;
    let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let body = if raw {
        result.clone()
    } else if let Some(s) = result.get("structuredContent") {
        s.clone()
    } else {
        Value::String(content_text(&result))
    };
    let out = match &body {
        Value::String(s) => s.clone(),
        v if compact => v.to_string(),
        v => pretty(v),
    };
    if is_error {
        let e = result.pointer("/structuredContent/error");
        let code = e.and_then(|e| e.get("code")).and_then(Value::as_str).unwrap_or("Error");
        let msg = e.and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("the tool answered with an error");
        let hint = e.and_then(|e| e.get("hint")).and_then(Value::as_str).map(|h| format!(" (hint: {h})")).unwrap_or_default();
        return Err(CliError { stdout: Some(out), ..CliError::tool(format!("{name}: {code}: {msg}{hint}")) });
    }
    Ok(out)
}

fn is_assignment(item: &str) -> bool {
    !item.starts_with('{') && item != "-" && item.contains('=')
}

/// The tool's `arguments` object from the command line.
pub fn build_arguments(items: &[&str], schema: Option<&Value>, stdin: &mut dyn Read) -> Result<Value, CliError> {
    let mut args = Value::Object(Map::new());
    for item in items {
        if *item == "-" || item.starts_with('{') {
            let text = if *item == "-" {
                let mut s = String::new();
                stdin.read_to_string(&mut s).map_err(|e| CliError::usage(format!("reading stdin failed: {e}")))?;
                s
            } else {
                item.to_string()
            };
            let v: Value = serde_json::from_str(&text).map_err(|e| CliError::usage(format!("the arguments are not valid JSON: {e}")))?;
            let Value::Object(map) = v else { return Err(CliError::usage("the JSON arguments must be an object")) };
            for (k, v) in map {
                args[k] = v;
            }
            continue;
        }
        let (path, value) = if let Some((p, j)) = item.split_once(":=").filter(|(p, _)| !p.contains('=')) {
            let v: Value = serde_json::from_str(j).map_err(|e| CliError::usage(format!("{p}:= takes JSON ({e}); use {p}=… for a string")))?;
            (p, v)
        } else if let Some((p, s)) = item.split_once('=') {
            let sub = schema.and_then(|s| schema_at(s, s, p));
            (p, typed(s, sub.as_ref()))
        } else {
            return Err(CliError::usage(format!("\"{}\" is not an argument: use key=value, key:=json, a JSON object or -", clean(item))));
        };
        if path.is_empty() || path.split('.').any(str::is_empty) {
            return Err(CliError::usage(format!("\"{}\" has an empty key", clean(item))));
        }
        set_path(&mut args, path, value)?;
    }
    Ok(args)
}

/// A `path=value` string, as a number or boolean when the schema wants one (and it parses).
fn typed(s: &str, schema: Option<&Value>) -> Value {
    let types = schema.map(schema_types).unwrap_or_default();
    let wants = |t: &str| types.iter().any(|x| x == t);
    // a number where the schema allows one (a port is `8080` or `http`)
    if (wants("integer") || wants("number")) && let Ok(v @ Value::Number(_)) = serde_json::from_str::<Value>(s) {
        return v;
    }
    if !wants("string") {
        if wants("boolean") && matches!(s, "true" | "false") {
            return Value::Bool(s == "true");
        }
        if (wants("array") || wants("object")) && let Ok(v @ (Value::Array(_) | Value::Object(_))) = serde_json::from_str::<Value>(s) {
            return v;
        }
    }
    Value::String(s.to_string())
}

/// Every JSON type a schema allows (through `type`, `anyOf`/`oneOf` and `enum`).
fn schema_types(schema: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match schema.get("type") {
        Some(Value::String(t)) => out.push(t.clone()),
        Some(Value::Array(ts)) => out.extend(ts.iter().filter_map(Value::as_str).map(str::to_string)),
        _ => {}
    }
    for key in ["anyOf", "oneOf"] {
        for alt in schema.get(key).and_then(Value::as_array).into_iter().flatten() {
            out.extend(schema_types(alt));
        }
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        out.extend(values.iter().map(|v| match v {
            Value::String(_) => "string".to_string(),
            Value::Number(_) => "number".to_string(),
            Value::Bool(_) => "boolean".to_string(),
            _ => "null".to_string(),
        }));
    }
    out
}

/// Follows a local `$ref` (`#/$defs/X`) against the root schema.
fn resolve<'a>(root: &'a Value, schema: &'a Value) -> &'a Value {
    let mut cur = schema;
    for _ in 0..16 {
        match cur.get("$ref").and_then(Value::as_str).and_then(|r| r.strip_prefix('#')).and_then(|p| root.pointer(p)) {
            Some(next) => cur = next,
            None => break,
        }
    }
    cur
}

/// The schema of one dotted path, looking through `$ref`, nullable `anyOf`s and array items.
fn schema_at(root: &Value, schema: &Value, path: &str) -> Option<Value> {
    let mut cur = resolve(root, schema).clone();
    for seg in path.split('.') {
        cur = step(root, &cur, seg)?;
    }
    Some(cur)
}

fn step(root: &Value, schema: &Value, seg: &str) -> Option<Value> {
    let s = resolve(root, schema);
    if let Some(p) = s.pointer(&format!("/properties/{}", seg.replace('~', "~0").replace('/', "~1"))) {
        return Some(resolve(root, p).clone());
    }
    if seg.parse::<usize>().is_ok()
        && let Some(items) = s.get("items")
    {
        return Some(resolve(root, items).clone());
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        for alt in s.get(key).and_then(Value::as_array).into_iter().flatten() {
            if let Some(found) = step(root, alt, seg) {
                return Some(found);
            }
        }
    }
    None
}

/// Sets a dotted path, creating objects (or arrays for numeric segments) on the way.
fn set_path(target: &mut Value, path: &str, value: Value) -> Result<(), CliError> {
    let segs: Vec<&str> = path.split('.').collect();
    let mut cur = target;
    for (i, seg) in segs.iter().enumerate() {
        let last = i + 1 == segs.len();
        let next_is_index = segs.get(i + 1).is_some_and(|s| s.parse::<usize>().is_ok());
        let fresh = || if next_is_index { Value::Array(Vec::new()) } else { Value::Object(Map::new()) };
        cur = match cur {
            Value::Object(map) => {
                if last {
                    map.insert(seg.to_string(), value);
                    return Ok(());
                }
                map.entry(seg.to_string()).or_insert_with(fresh)
            }
            Value::Array(items) => {
                let idx: usize = seg.parse().map_err(|_| CliError::usage(format!("{path}: \"{seg}\" is not an index of a list")))?;
                if idx > items.len() || idx > 1000 {
                    return Err(CliError::usage(format!("{path}: give list items in order, starting at 0")));
                }
                if idx == items.len() {
                    items.push(if last { Value::Null } else { fresh() });
                }
                if last {
                    items[idx] = value;
                    return Ok(());
                }
                &mut items[idx]
            }
            _ => return Err(CliError::usage(format!("{path}: \"{seg}\" is set twice, once as a value and once as an object"))),
        };
    }
    Ok(())
}

/// One request; `_meta` carries the revision, so no `initialize` is needed.
fn request(shim: &Shim, method: &str, mut params: Value) -> Result<Value, CliError> {
    if let Value::Object(p) = &mut params {
        p.insert(
            "_meta".into(),
            json!({
                "io.modelcontextprotocol/protocolVersion": REVISION,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": { "name": "kns-mcp-cli", "version": env!("CARGO_PKG_VERSION") },
            }),
        );
    }
    request_raw(shim, method, params)
}

fn request_raw(shim: &Shim, method: &str, params: Value) -> Result<Value, CliError> {
    let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let o = shim.handle(&msg.to_string());
    let v: Value = o
        .stdout
        .first()
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or_else(|| CliError { code: 3, stdout: None, message: o.stderr.clone().map(|s| s.trim_start_matches("kns-mcp: ").to_string()).unwrap_or_else(|| "kns sent no answer".into()) })?;
    if let Some(e) = v.get("error") {
        let message = e.get("message").and_then(Value::as_str).unwrap_or("kns answered with an error").to_string();
        // errors made by the shim itself (data.kns) mean kns could not be reached or refused us
        let local = e.pointer("/data/kns").is_some_and(Value::is_string) && e.get("code").and_then(Value::as_i64) == Some(-32000);
        return Err(CliError { code: if local { 3 } else { 1 }, message, stdout: None });
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

/// Every item of a paginated list.
fn list(shim: &Shim, method: &str, key: &str) -> Result<Vec<Value>, CliError> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..50 {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let result = request(shim, method, params)?;
        out.extend(result.get(key).and_then(Value::as_array).cloned().unwrap_or_default());
        cursor = result.get("nextCursor").and_then(Value::as_str).map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok(out)
}

fn find_tool<'a>(tools: &'a [Value], name: &str) -> Result<&'a Value, CliError> {
    tools.iter().find(|t| t.get("name").and_then(Value::as_str) == Some(name)).ok_or_else(|| {
        let near: Vec<&str> = tools.iter().filter_map(|t| t.get("name").and_then(Value::as_str)).filter(|n| n.contains(name) || name.contains(n)).collect();
        let tip = if near.is_empty() { "kns-mcp tools lists them".to_string() } else { format!("did you mean {}?", near.join(", ")) };
        CliError::usage(format!("kns has no tool \"{}\" ({tip})", clean(name)))
    })
}

/// The first sentence of a description.
fn summary(desc: &str) -> String {
    let line = desc.lines().next().unwrap_or_default();
    match line.find(". ") {
        Some(i) => line[..=i].to_string(),
        None => line.to_string(),
    }
}

pub fn tool_table(tools: &[Value]) -> String {
    let width = tools.iter().filter_map(|t| t.get("name").and_then(Value::as_str)).map(str::len).max().unwrap_or(0);
    let mut out: Vec<String> = tools
        .iter()
        .map(|t| {
            let name = t.get("name").and_then(Value::as_str).unwrap_or_default();
            let read_only = t.pointer("/annotations/readOnlyHint").and_then(Value::as_bool).unwrap_or(false);
            let mark = if read_only { "read   " } else { "propose" };
            format!("{name:width$}  {mark}  {}", summary(t.get("description").and_then(Value::as_str).unwrap_or_default()))
        })
        .collect();
    out.push(String::new());
    out.push("`read` tools only look; `propose` tools draft or ask for changes the human approves in kns.".into());
    out.push("kns-mcp help <tool> shows a tool's parameters.".into());
    out.join("\n")
}

pub fn tool_help(tool: &Value) -> String {
    let name = tool.get("name").and_then(Value::as_str).unwrap_or_default();
    let mut out = vec![name.to_string()];
    if let Some(title) = tool.get("title").and_then(Value::as_str) {
        out[0] = format!("{name} — {title}");
    }
    out.push(String::new());
    out.push(tool.get("description").and_then(Value::as_str).unwrap_or_default().trim().to_string());
    let schema = tool.get("inputSchema").cloned().unwrap_or(Value::Null);
    let mut rows = Vec::new();
    params(&schema, &schema, "", true, 0, &mut rows);
    out.push(String::new());
    if rows.is_empty() {
        out.push("Parameters: none".into());
    } else {
        out.push("Parameters (path=value; * required):".into());
        let width = rows.iter().map(|r| r.0.len()).max().unwrap_or(0);
        let twidth = rows.iter().map(|r| r.1.len()).max().unwrap_or(0);
        for (path, ty, desc) in &rows {
            out.push(format!("  {path:width$}  {ty:twidth$}  {desc}"));
        }
    }
    out.push(String::new());
    out.push(format!("Example: {}", example(name, &schema)));
    out.join("\n")
}

/// Flattens a schema into (path, type, description) rows; nested objects get dotted paths.
fn params(root: &Value, schema: &Value, prefix: &str, required_chain: bool, depth: usize, rows: &mut Vec<(String, String, String)>) {
    let s = resolve(root, schema);
    let Some(props) = s.get("properties").and_then(Value::as_object) else { return };
    let required: Vec<&str> = s.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    for (key, prop) in props {
        let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        let req = required_chain && required.contains(&key.as_str());
        let p = resolve(root, prop);
        let desc = prop.get("description").or_else(|| p.get("description")).and_then(Value::as_str).unwrap_or_default().replace('\n', " ");
        let object = object_schema(root, p);
        let array_of = (p.get("type").and_then(Value::as_str) == Some("array")).then(|| p.get("items")).flatten().map(|i| resolve(root, i)).filter(|i| i.get("properties").is_some());
        let label = format!("{path}{}", if req { " *" } else { "" });
        if depth < 3
            && let Some(obj) = object
        {
            rows.push((label, "object".into(), desc));
            params(root, obj, &path, req, depth + 1, rows);
        } else if depth < 3
            && let Some(item) = array_of
        {
            rows.push((label, "list".into(), format!("{desc} (items as {path}.0.…, {path}.1.…, or {path}:='[…]')")));
            params(root, item, &format!("{path}.N"), false, depth + 1, rows);
        } else {
            rows.push((label, type_label(root, p), desc));
        }
    }
}

/// The object schema behind a property (directly, or the non-null branch of a nullable `anyOf`).
fn object_schema<'a>(root: &'a Value, s: &'a Value) -> Option<&'a Value> {
    if s.get("properties").is_some() {
        return Some(s);
    }
    let alts = s.get("anyOf").or_else(|| s.get("oneOf")).and_then(Value::as_array)?;
    let objects: Vec<&Value> = alts.iter().map(|a| resolve(root, a)).filter(|a| a.get("properties").is_some()).collect();
    let others = alts.iter().map(|a| resolve(root, a)).filter(|a| a.get("properties").is_none()).all(|a| a.get("type").and_then(Value::as_str) == Some("null"));
    (objects.len() == 1 && others).then(|| objects[0])
}

fn type_label(root: &Value, s: &Value) -> String {
    if let Some(values) = s.get("enum").and_then(Value::as_array) {
        return values.iter().map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).collect::<Vec<_>>().join("|");
    }
    let mut types: Vec<String> = Vec::new();
    for alt in s.get("anyOf").or_else(|| s.get("oneOf")).and_then(Value::as_array).into_iter().flatten() {
        types.push(type_label(root, resolve(root, alt)));
    }
    types.extend(schema_types(&json!({ "type": s.get("type").cloned().unwrap_or(Value::Null) })));
    types.retain(|t| t != "null" && !t.is_empty());
    types.dedup();
    let t = types.join("|");
    match t.as_str() {
        "array" => "list".into(),
        "" => "json".into(),
        _ => t,
    }
}

/// `kns-mcp call <tool> …` with every required leaf.
fn example(name: &str, schema: &Value) -> String {
    let mut rows = Vec::new();
    params(schema, schema, "", true, 0, &mut rows);
    let mut parts = vec![format!("kns-mcp call {name}")];
    for (label, ty, _) in rows.iter().filter(|r| r.0.ends_with(" *") && r.1 != "object" && r.1 != "list") {
        let path = label.trim_end_matches(" *");
        let leaf = path.rsplit('.').next().unwrap_or(path);
        let value = match (ty.as_str(), leaf) {
            ("integer" | "number", _) => "1".to_string(),
            ("boolean", _) => "true".to_string(),
            (t, _) if t.contains('|') && !t.contains("string") => t.split('|').next().unwrap_or("x").to_string(),
            (_, "kind") => "deploy".into(),
            (_, "namespace") => "default".into(),
            _ => format!("<{leaf}>"),
        };
        parts.push(format!("{path}={value}"));
    }
    for (label, ty, _) in rows.iter().filter(|r| r.0.ends_with(" *") && r.1 == "list") {
        let path = label.trim_end_matches(" *");
        if !rows.iter().any(|r| r.0.starts_with(&format!("{path}.N."))) {
            parts.push(format!("{path}:='[…]'"));
        } else {
            let _ = ty;
            for (sub, _, _) in rows.iter().filter(|r| r.0.starts_with(&format!("{path}.N.")) && r.0.ends_with(" *")) {
                let p = sub.trim_end_matches(" *").replacen(".N.", ".0.", 1);
                let leaf = p.rsplit('.').next().unwrap_or_default().to_string();
                parts.push(format!("{p}=<{leaf}>"));
            }
        }
    }
    parts.join(" ")
}

pub fn resource_table(items: &[Value]) -> String {
    if items.is_empty() {
        return "no resources (kns-mcp call get_status shows what this agent may see)".into();
    }
    let uri = |r: &Value| r.get("uri").or_else(|| r.get("uriTemplate")).and_then(Value::as_str).unwrap_or_default().to_string();
    let width = items.iter().map(|r| uri(r).len()).max().unwrap_or(0);
    items
        .iter()
        .map(|r| {
            let text = r.get("description").or_else(|| r.get("name")).and_then(Value::as_str).unwrap_or_default();
            format!("{:width$}  {}", uri(r), summary(text))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The text blocks of a tool result.
fn content_text(result: &Value) -> String {
    result.get("content").and_then(Value::as_array).into_iter().flatten().filter_map(|c| c.get("text").and_then(Value::as_str)).map(pretty_text).collect::<Vec<_>>().join("\n")
}

/// JSON text pretty-printed; anything else as is.
fn pretty_text(s: &str) -> String {
    serde_json::from_str::<Value>(s).map(|v| pretty(&v)).unwrap_or_else(|_| s.to_string())
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
}

/// A user-supplied word, safe to echo: no control characters, at most 60 characters.
fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(60).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "ref": { "$ref": "#/$defs/RefArg", "description": "The object." },
                "tail": { "type": ["integer", "null"], "format": "uint32" },
                "previous": { "type": ["boolean", "null"] },
                "format": { "$ref": "#/$defs/Format" },
                "grep": { "type": ["string", "null"] },
                "refs": { "type": "array", "items": { "$ref": "#/$defs/RefArg" } },
                "remotePort": { "anyOf": [{ "type": "integer" }, { "type": "string" }] },
                "opt": { "anyOf": [{ "$ref": "#/$defs/RefArg" }, { "type": "null" }] }
            },
            "required": ["ref"],
            "$defs": {
                "RefArg": { "type": "object", "properties": {
                    "kind": { "type": "string", "description": "Resource kind." },
                    "name": { "type": "string" },
                    "namespace": { "type": ["string", "null"] }
                }, "required": ["kind", "name"] },
                "Format": { "type": "string", "enum": ["yaml", "json"] }
            }
        })
    }

    fn build(items: &[&str]) -> Result<Value, CliError> {
        build_arguments(items, Some(&schema()), &mut std::io::empty())
    }

    #[test]
    fn assignments_follow_the_schema() {
        let v = build(&["ref.kind=pod", "ref.name=123", "tail=50", "previous=true", "grep=42", "format=json"]).unwrap();
        assert_eq!(v, json!({ "ref": { "kind": "pod", "name": "123" }, "tail": 50, "previous": true, "grep": "42", "format": "json" }));
        // a value that does not parse as the schema's type stays a string (the server says why)
        assert_eq!(build(&["tail=lots"]).unwrap(), json!({ "tail": "lots" }));
        // integer-or-string: a number when it parses
        assert_eq!(build(&["remotePort=8080", "opt.kind=svc"]).unwrap(), json!({ "remotePort": 8080, "opt": { "kind": "svc" } }));
        assert_eq!(build(&["remotePort=http"]).unwrap(), json!({ "remotePort": "http" }));
        // no schema: strings
        assert_eq!(build_arguments(&["tail=5"], None, &mut std::io::empty()).unwrap(), json!({ "tail": "5" }));
        // = inside a value
        assert_eq!(build(&["grep=a=b"]).unwrap(), json!({ "grep": "a=b" }));
    }

    #[test]
    fn lists_json_and_stdin() {
        let v = build(&["refs.0.kind=pod", "refs.0.name=a", "refs.1.kind=svc", "refs.1.name=b"]).unwrap();
        assert_eq!(v, json!({ "refs": [{ "kind": "pod", "name": "a" }, { "kind": "svc", "name": "b" }] }));
        assert!(build(&["refs.2.kind=pod"]).is_err(), "items in order");
        let v = build(&[r#"{"ref":{"kind":"pod","name":"x"}}"#, "tail:=10", "ref.namespace=shop"]).unwrap();
        assert_eq!(v, json!({ "ref": { "kind": "pod", "name": "x", "namespace": "shop" }, "tail": 10 }));
        let mut stdin = std::io::Cursor::new(br#"{"grep":"oops"}"#.to_vec());
        assert_eq!(build_arguments(&["-"], None, &mut stdin).unwrap(), json!({ "grep": "oops" }));
        assert_eq!(build(&["refs:=[]"]).unwrap(), json!({ "refs": [] }));
        assert_eq!(build(&["tail:=nope"]).unwrap_err().code, 2);
        assert_eq!(build(&["justaword"]).unwrap_err().code, 2);
        assert_eq!(build(&["[1]"]).unwrap_err().code, 2);
        assert_eq!(build(&["ref=x", "ref.kind=pod"]).unwrap_err().code, 2);
        assert_eq!(build(&["ref..kind=pod"]).unwrap_err().code, 2);
    }

    #[test]
    fn help_flattens_nested_parameters() {
        let tool = json!({ "name": "get_logs", "title": "Logs", "description": "Reads logs. More text.", "inputSchema": schema() });
        let h = tool_help(&tool);
        assert!(h.starts_with("get_logs — Logs"), "{h}");
        assert!(h.contains("ref.kind *"), "{h}");
        assert!(h.contains("ref.namespace "), "{h}");
        assert!(!h.contains("ref.namespace *"), "{h}");
        assert!(h.contains("yaml|json"), "{h}");
        assert!(h.contains("refs.N.kind"), "{h}");
        assert!(h.contains("opt.kind"), "a nullable object is flattened too: {h}");
        assert!(h.contains("integer|string"), "{h}");
        assert!(h.contains("Example: kns-mcp call get_logs ref.kind=deploy ref.name=<name>"), "{h}");
        let none = tool_help(&json!({ "name": "get_status", "description": "Status.", "inputSchema": { "type": "object", "properties": {} } }));
        assert!(none.contains("Parameters: none") && none.ends_with("Example: kns-mcp call get_status"), "{none}");
    }

    #[test]
    fn tables() {
        let tools = vec![
            json!({ "name": "get_status", "description": "What you may see. Second sentence.\nMore.", "annotations": { "readOnlyHint": true } }),
            json!({ "name": "propose_scale", "description": "Ask to scale." }),
        ];
        let t = tool_table(&tools);
        assert!(t.contains("get_status     read     What you may see."), "{t}");
        assert!(t.contains("propose_scale  propose  Ask to scale."), "{t}");
        assert!(!t.contains("Second sentence"));
        let r = resource_table(&[json!({ "uri": "kns://selection", "name": "selection" }), json!({ "uriTemplate": "kns://devset/{id}", "description": "A dev set." })]);
        assert!(r.contains("kns://selection    selection") && r.contains("kns://devset/{id}  A dev set."), "{r}");
    }

    #[test]
    fn unreachable_kns_is_exit_3_and_bad_usage_is_2() {
        let shim = Shim::new(None, None);
        let e = command(&shim, "tools", &[], &mut std::io::empty()).unwrap_err();
        assert_eq!(e.code, 3, "{e:?}");
        assert!(e.message.contains("KNS_MCP_TOKEN"), "{e:?}");
        assert_eq!(command(&shim, "help", &[], &mut std::io::empty()).unwrap_err().code, 2);
        assert_eq!(command(&shim, "call", &[], &mut std::io::empty()).unwrap_err().code, 2);
        assert_eq!(command(&shim, "read", &[], &mut std::io::empty()).unwrap_err().code, 2);
        // arguments that need no schema are checked before any request
        assert_eq!(command(&shim, "call", &["get_status".into(), "--bogus".into()], &mut std::io::empty()).unwrap_err().code, 2);
        assert!(is_command("call") && !is_command("--check") && !is_command("serve"));
    }
}
