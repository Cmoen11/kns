use std::time::{Duration, Instant};
use futures::{AsyncBufReadExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{api::{Api, AttachParams, ListParams, LogParams}, Client};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TABLE: &str = "application/json;as=Table;g=meta.k8s.io;v=v1, application/json";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let t0 = Instant::now();
    let client = Client::try_default().await?;
    let v = client.apiserver_version().await?;
    println!("[auth] ok server={} in {:?}", v.git_version, t0.elapsed());

    // Table list
    let t = Instant::now();
    let req = http::Request::get("/api/v1/pods?limit=500&includeObject=Metadata").header("Accept", TABLE).body(vec![])?;
    let txt = client.request_text(req).await?;
    let j: serde_json::Value = serde_json::from_str(&txt)?;
    let cols: Vec<_> = j["columnDefinitions"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap().to_string()).collect();
    let rows = j["rows"].as_array().unwrap();
    let rv = j["metadata"]["resourceVersion"].as_str().unwrap().to_string();
    println!("[table-list] kind={} cols={:?} rows={} rv={} in {:?}", j["kind"], cols, rows.len(), rv, t.elapsed());
    println!("  row0 cells={} meta.name={}", rows[0]["cells"], rows[0]["object"]["metadata"]["name"]);

    // Table watch
    let req = http::Request::get(format!("/api/v1/pods?watch=1&resourceVersion={rv}&allowWatchBookmarks=true&timeoutSeconds=8&includeObject=Metadata")).header("Accept", TABLE).body(vec![])?;
    let stream = client.request_stream(req).await;
    match stream {
        Ok(s) => {
            let mut lines = s.lines();
            let mut n = 0;
            let w = Instant::now();
            while let Ok(Some(l)) = tokio::time::timeout(Duration::from_secs(10), lines.try_next()).await.unwrap_or(Ok(None)) {
                let e: serde_json::Value = serde_json::from_str(&l)?;
                n += 1;
                if n <= 3 { println!("  [watch ev] type={} objkind={} hasCols={} rows={}", e["type"], e["object"]["kind"], e["object"]["columnDefinitions"].as_array().map(|a| a.len()).unwrap_or(0), e["object"]["rows"].as_array().map(|a| a.len()).unwrap_or(0)); }
            }
            println!("[table-watch] events={} in {:?}", n, w.elapsed());
        }
        Err(e) => println!("[table-watch] ERR {e}"),
    }

    // CRD table (Flux)
    let req = http::Request::get("/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations?includeObject=Metadata").header("Accept", TABLE).body(vec![])?;
    match client.request_text(req).await { Ok(t) => { let j: serde_json::Value = serde_json::from_str(&t)?; println!("[crd-table] cols={:?} rows={}", j["columnDefinitions"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect::<Vec<_>>(), j["rows"].as_array().unwrap().len()); } Err(e) => println!("[crd-table] ERR {e}") }

    // discovery
    let t = Instant::now();
    let req = http::Request::get("/apis").header("Accept", "application/json;v=v2;g=apidiscovery.k8s.io;as=APIGroupDiscoveryList, application/json").body(vec![])?;
    let j: serde_json::Value = serde_json::from_str(&client.request_text(req).await?)?;
    println!("[discovery] kind={} groups={} in {:?}", j["kind"], j["items"].as_array().map(|a| a.len()).unwrap_or(0), t.elapsed());

    // spike pod streams (ns kns-spike, pod sh) if present
    let pods: Api<Pod> = Api::namespaced(client.clone(), "kns-spike");
    if pods.get_opt("sh").await?.is_some() {
        let mut logs = pods.log_stream("sh", &LogParams { follow: true, tail_lines: Some(2), timestamps: true, ..Default::default() }).await?.lines();
        for _ in 0..3 { if let Ok(Ok(Some(l))) = tokio::time::timeout(Duration::from_secs(5), logs.try_next()).await { println!("  [log] {l}"); } }
        println!("[logs] ok");

        let mut p = pods.exec("sh", vec!["sh"], &AttachParams::interactive_tty()).await?;
        let mut stdin = p.stdin().unwrap();
        let mut stdout = p.stdout().unwrap();
        let mut size = p.terminal_size().unwrap();
        use futures::SinkExt;
        size.send(kube::api::TerminalSize { width: 123, height: 45 }).await?;
        stdin.write_all(b"stty size; echo hello-$((6*7))\n").await?;
        let mut buf = vec![0u8; 4096]; let mut out = String::new();
        let end = Instant::now() + Duration::from_secs(4);
        while Instant::now() < end && !out.contains("hello-42") {
            if let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(500), stdout.read(&mut buf)).await { out.push_str(&String::from_utf8_lossy(&buf[..n])); }
        }
        println!("[exec] resize_ok={} echo_ok={} raw={:?}", out.contains("45 123"), out.contains("hello-42"), out);
        stdin.write_all(b"exit\n").await?; drop(stdin);
        let _ = tokio::time::timeout(Duration::from_secs(3), p.join()).await;

        let mut pf = pods.portforward("sh", &[8080]).await?;
        let mut s = pf.take_stream(8080).unwrap();
        s.write_all(b"GET / HTTP/1.0\r\n\r\n").await?;
        let mut resp = vec![0u8; 256];
        let n = tokio::time::timeout(Duration::from_secs(4), s.read(&mut resp)).await??;
        println!("[portforward] {:?}", String::from_utf8_lossy(&resp[..n]).lines().next());
    } else { println!("[streams] skipped: no kns-spike/sh pod"); }
    let _ = ListParams::default();
    Ok(())
}
