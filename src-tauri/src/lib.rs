// base
pub mod awslogin;
pub mod contract;
pub mod discovery;
pub mod exec;
pub mod forward;
pub mod ipc;
pub mod logs;
pub mod metrics;
pub mod mutate;
pub mod objects;
pub mod rbac;
pub mod session;
pub mod state;
pub mod store;
pub mod table;

// feature foundation (A1, docs/plan-features.md §2.1)
pub mod clip;
pub mod ctxflags;
pub mod events;
pub mod notify;
pub mod proposals;
pub mod redact;
pub mod rustfiles;
pub mod uistate;

// B-fwd
pub mod service;
// B-dev
pub mod addr;
pub mod devset;
pub mod env;
pub mod kafka;
// B2
pub mod proxy;
// C1 / C3
pub mod diagnose;
// C2
pub mod history;
pub mod journal;
pub mod timeline;
pub mod trap;
// C3
pub mod reach;
pub mod relations;
// D
pub mod ownership;
// E
pub mod logparse;
// F
pub mod debug;
// G
pub mod pack;
// H1 / H2 / H3
pub mod mcp;
// status colours: namespace health
pub mod nshealth;
// auto-update (docs/auto-update.md)
pub mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // kube-rs only hides the console window of exec credential plugins (aws, gke-gcloud-auth-plugin,
    // kubelogin ...) when asked to. Without it every token refresh flashes a console on Windows.
    // SAFETY: nothing else runs yet; no other thread can be reading the environment.
    #[cfg(windows)]
    unsafe {
        std::env::set_var("KUBE_RS_UNSTABLE_CREATE_NO_WINDOW", "1");
    }

    // A GUI app on macOS starts with a minimal PATH (no Homebrew), so kubeconfig exec plugins such as
    // `aws eks get-token` fail with "No such file or directory". Add the usual install directories.
    // SAFETY: nothing else runs yet; no other thread can be reading the environment.
    #[cfg(unix)]
    unsafe {
        let mut path: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/aws-cli"] {
            let extra = std::path::PathBuf::from(extra);
            if !path.contains(&extra) {
                path.push(extra);
            }
        }
        if let Ok(joined) = std::env::join_paths(path) {
            std::env::set_var("PATH", joined);
        }
    }

    let state = state::AppState::default();
    let streams = state.clone();
    let setup_state = state.clone();
    let result = tauri::Builder::default()
        // Used from Rust only: the window has no dialog/opener/notification/updater permission
        // (capabilities/default.json stays core-only).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        // A reload (F5, HMR, navigation) orphans the old page's channels without failing their sends.
        // The window starts hidden (tauri.conf.json) and is shown once the page has loaded, so the
        // first thing on screen is the themed UI, not an empty white webview.
        .on_page_load(move |webview, payload| match payload.event() {
            tauri::webview::PageLoadEvent::Started => {
                streams.stop_all_streams();
            }
            tauri::webview::PageLoadEvent::Finished => {
                let _ = webview.window().show();
                let _ = webview.window().set_focus();
            }
        })
        .setup(move |app| {
            use tauri::Manager;
            setup_state.set_app(app.handle().clone());
            // context flags for the proposal gate and MCP: denied until this has run (§5.4)
            if let Ok(dir) = app.path().app_config_dir() {
                let flags_state = setup_state.clone();
                tauri::async_runtime::spawn(async move {
                    let flags = ctxflags::load_from(&dir).await;
                    ctxflags::set(&flags_state, flags);
                });
            }
            // MCP config (and the server, when it was left on) without waiting for the UI
            let mcp_state = setup_state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mcp::ensure_loaded(&mcp_state).await {
                    eprintln!("kns: MCP config not loaded: {}", e.message);
                }
            });
            // auto-update: first status now, the check loop in release builds with an update key
            update::start(&setup_state);
            // never stay invisible if the page fails to load
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(w) = handle.get_webview_window("main")
                    && !w.is_visible().unwrap_or(true)
                {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // base
            session::cmd::list_contexts,
            session::cmd::connect,
            awslogin::cmd::aws_sso_login,
            discovery::cmd::discover,
            table::cmd::subscribe_table,
            state::cmd::stop_stream,
            objects::cmd::get_yaml,
            objects::cmd::get_json,
            objects::cmd::get_json_masked,
            objects::cmd::list_events,
            objects::cmd::pods_for,
            objects::cmd::decode_secret,
            mutate::cmd::apply_yaml,
            mutate::cmd::delete_object,
            mutate::cmd::patch_object,
            mutate::cmd::scale,
            mutate::cmd::restart,
            mutate::cmd::trigger_cron_job,
            metrics::cmd::pod_metrics,
            metrics::cmd::node_metrics,
            logs::cmd::stream_logs,
            exec::cmd::exec_start,
            exec::cmd::exec_write,
            exec::cmd::exec_resize,
            forward::cmd::start_forward,
            forward::cmd::list_forwards,
            forward::cmd::stop_forward,
            rbac::cmd::can_i,
            store::cmd::load_state,
            store::cmd::save_state,
            // A1
            redact::cmd::redact_preview,
            proposals::cmd::proposals_list,
            proposals::cmd::proposal_claim,
            proposals::cmd::proposal_unclaim,
            proposals::cmd::proposal_approve,
            proposals::cmd::proposal_resolve,
            uistate::cmd::publish_ui_state,
            // B-fwd
            forward::cmd::resolve_forward_target,
            forward::cmd::open_forward,
            service::cmd::service_info,
            // B-dev
            devset::cmd::dev_sets_list,
            devset::cmd::dev_set_save,
            devset::cmd::dev_set_delete,
            devset::cmd::dev_set_up,
            devset::cmd::dev_set_down,
            devset::cmd::dev_set_failures,
            env::cmd::env_resolve,
            env::cmd::env_reveal,
            env::cmd::env_export,
            // B2
            proxy::cmd::name_proxy_status,
            proxy::cmd::name_proxy_set,
            devset::cmd::conn_secrets_list,
            devset::cmd::forward_conn_info,
            devset::cmd::forward_conn_copy,
            env::cmd::volumes_list,
            env::cmd::volumes_export,
            // C1
            diagnose::cmd::diagnose,
            // C2
            timeline::cmd::timeline,
            journal::cmd::journal_set,
            journal::cmd::journal_status,
            trap::cmd::trap_arm,
            trap::cmd::trap_list,
            trap::cmd::trap_disarm,
            trap::cmd::bundle_get,
            history::cmd::pod_metrics_history,
            // C3
            reach::cmd::reach,
            reach::cmd::reach_probe,
            relations::cmd::relations,
            // D
            ownership::cmd::field_owners,
            ownership::cmd::revisions,
            // F
            debug::cmd::debug_container,
            debug::cmd::debug_copy,
            debug::cmd::debug_pods_list,
            debug::cmd::debug_pod_delete,
            debug::cmd::snippet_run,
            // G
            pack::cmd::context_pack,
            pack::cmd::pack_save,
            // H1
            mcp::cmd::mcp_status,
            mcp::cmd::mcp_set_enabled,
            mcp::cmd::mcp_set_port,
            mcp::cmd::mcp_client_add,
            mcp::cmd::mcp_client_revoke,
            mcp::cmd::mcp_policy_set,
            mcp::cmd::mcp_audit_tail,
            // status colours
            nshealth::cmd::subscribe_ns_health,
            // auto-update
            update::cmd::update_status,
            update::cmd::update_check,
            update::cmd::update_install,
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("kns failed to start: {e}");
        std::process::exit(1);
    }
}
