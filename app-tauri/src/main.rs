//! L'application GuiVault (`docs/APP.md`) : l'interface web embarquée
//! (`web/app`, construite dans `web/dist-app`), et l'hôte du coffre local
//! qu'elle appelle (`web/app/src/tauriHost.ts`).
//!
//! L'hôte ne fait que passer les opérations à `guivault_local::rpc` : il ne
//! voit que des blobs, comme le serveur — la crypto est dans l'interface.
//! Le mode « serveur » de l'app n'a pas besoin de lui : l'interface parle
//! au serveur en HTTP, comme dans un navigateur (CORS ouvert sur l'API).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autotype;
mod browser;
mod clipboard;
mod native_host;
mod system;
mod tray;

use guivault_local::{LocalVault, NewCoffre};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Le coffre ouvert, un à la fois. `LocalVault` ne garde que son chemin :
/// on le clone pour travailler hors du verrou.
#[derive(Default)]
struct Coffre(Mutex<Option<LocalVault>>);

impl Coffre {
    fn set(&self, v: Option<LocalVault>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }

    fn get(&self) -> Result<LocalVault, Value> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| error(guivault_local::Error::new(409, "local_closed", "aucun coffre ouvert")))
    }
}

/// Une erreur comme le serveur la rendrait, avec son statut :
/// `localHost.ts` en refait une `ApiError`.
fn error(e: guivault_local::Error) -> Value {
    let mut body = e.body();
    body["status"] = e.status.into();
    body
}

/// Le disque, hors du fil de l'interface.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, Value> + Send + 'static) -> Result<T, Value> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| error(guivault_local::Error::new(500, "local_io", e.to_string())))?
}

#[tauri::command]
async fn local_create(state: State<'_, Coffre>, path: String, coffre: Value) -> Result<(), Value> {
    let new: NewCoffre = serde_json::from_value(coffre)
        .map_err(|e| error(guivault_local::Error::bad_request("invalid_request", e.to_string())))?;
    let known = path.clone();
    let vault = blocking(move || LocalVault::create(path, new).map_err(error)).await?;
    native_host::remember(&known);
    state.set(Some(vault));
    Ok(())
}

#[tauri::command]
async fn local_open(state: State<'_, Coffre>, path: String) -> Result<(), Value> {
    let known = path.clone();
    let vault = blocking(move || LocalVault::open(path).map_err(error)).await?;
    native_host::remember(&known);
    state.set(Some(vault));
    Ok(())
}

/// Les sauvegardes d'un coffre (`guivault_local::backups`) — sans
/// l'ouvrir : c'est aussi le recours d'un coffre devenu illisible.
#[tauri::command]
async fn local_backups(path: String) -> Result<Vec<guivault_local::BackupInfo>, Value> {
    blocking(move || guivault_local::backups(std::path::Path::new(&path)).map_err(error)).await
}

/// Une sauvegarde devient un nouveau coffre dans `dest` ; rien n'est écrasé.
#[tauri::command]
async fn local_restore_backup(path: String, name: String, dest: String) -> Result<(), Value> {
    blocking(move || {
        guivault_local::restore_backup(std::path::Path::new(&path), &name, std::path::Path::new(&dest)).map_err(error)
    })
    .await
}

#[tauri::command]
fn local_close(state: State<'_, Coffre>) {
    state.set(None);
}

#[tauri::command]
async fn local_call(state: State<'_, Coffre>, op: String, args: Value) -> Result<Value, Value> {
    let vault = state.get()?;
    blocking(move || guivault_local::rpc::call(&vault, &op, &args).map_err(error)).await
}

// ─── Saisie automatique (`src/autotype.rs`) ─────────────────────────────────

/// Le raccourci global en place, pour le rendre si le suivant est refusé.
#[derive(Default)]
struct Hotkey(Mutex<Option<String>>);

fn autotype_error(e: autotype::Error) -> Value {
    serde_json::to_value(e).unwrap_or(Value::Null)
}

/// Le handle de la fenêtre de GuiVault, pour ne jamais s'y taper soi-même.
fn own_handle(window: &WebviewWindow) -> Option<isize> {
    #[cfg(windows)]
    {
        window.hwnd().ok().map(|h| h.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

#[tauri::command]
fn autotype_available() -> bool {
    cfg!(windows)
}

/// Pose le raccourci global (`""` le retire). Pressé, il note la fenêtre au
/// premier plan **à cet instant** et la confie à l'interface
/// (`autotype-request`), qui choisit quoi y taper.
#[tauri::command]
fn autotype_set_hotkey(app: AppHandle, state: State<'_, Hotkey>, accelerator: String) -> Result<(), Value> {
    if !cfg!(windows) {
        return Err(autotype_error(autotype::Error::new(
            "autotype_unsupported",
            "La saisie automatique n'existe encore que sous Windows.",
        )));
    }
    let gs = app.global_shortcut();
    let mut current = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = current.take() {
        let _ = gs.unregister(old.as_str());
    }
    let accelerator = accelerator.trim().to_string();
    if accelerator.is_empty() {
        return Ok(());
    }
    let register = |accel: &str| {
        gs.on_shortcut(accel, |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let own = app.get_webview_window("main").and_then(|w| own_handle(&w));
            let Some(fg) = autotype::foreground() else { return };
            // Pressé dans GuiVault lui-même : rien à taper.
            if own.is_some_and(|o| o.to_string() == fg.target) {
                return;
            }
            let _ = app.emit_to("main", "autotype-request", fg);
        })
    };
    match register(&accelerator) {
        Ok(()) => {
            *current = Some(accelerator);
            Ok(())
        }
        Err(e) => Err(autotype_error(autotype::Error::new(
            "autotype_hotkey",
            format!("Raccourci « {accelerator} » refusé : {e}. Il est peut-être déjà pris par une autre application."),
        ))),
    }
}

/// Tape `actions` (résolues par `lib/autotype.ts`) dans `target`, ou dans
/// la fenêtre d'avant GuiVault. Le texte est effacé de la mémoire ensuite,
/// quoi qu'il arrive.
#[tauri::command]
async fn autotype_type(window: WebviewWindow, actions: Value, target: Option<String>) -> Result<(), Value> {
    let mut actions: Vec<autotype::Action> = serde_json::from_value(actions)
        .map_err(|e| autotype_error(autotype::Error::new("invalid_request", e.to_string())))?;
    let own = own_handle(&window);
    tauri::async_runtime::spawn_blocking(move || {
        let minimize = || {
            let _ = window.minimize();
        };
        let r = autotype::type_actions(target.as_deref(), own, &minimize, &actions);
        autotype::wipe(&mut actions);
        r.map_err(autotype_error)
    })
    .await
    .map_err(|e| autotype_error(autotype::Error::new("autotype_failed", e.to_string())))?
}

/// Le handle de la fenêtre de GuiVault : une cible pour les tests de bout en
/// bout (`web/app/e2e`), qui tapent dans l'application elle-même plutôt que
/// dans une fenêtre de la personne qui les lance.
#[tauri::command]
fn autotype_self_target(window: WebviewWindow) -> Option<String> {
    own_handle(&window).map(|h| h.to_string())
}

// ─── Presse-papiers (`src/clipboard.rs`) ────────────────────────────────────

#[tauri::command]
fn clipboard_native() -> bool {
    cfg!(windows)
}

/// Copie un secret hors de l'historique Windows et du presse-papiers cloud,
/// et l'efface à l'échéance s'il est encore là.
#[tauri::command]
async fn clipboard_copy_secret(window: WebviewWindow, mut text: String, clear_after_ms: u64) -> Result<(), String> {
    let owner = own_handle(&window).unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        let r = clipboard::copy_secret(owner, &text, clear_after_ms);
        zeroize::Zeroize::zeroize(&mut text);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Système (`src/system.rs`) ───────────────────────────────────────────────

/// L'inactivité de tout l'ordinateur, en millisecondes ; `null` hors Windows.
#[tauri::command]
fn system_idle_ms() -> Option<u64> {
    system::idle_ms()
}

// ─── Zone de notification (`src/tray.rs`) ────────────────────────────────────

/// Démarré par la session (démarrage automatique) : directement dans la zone
/// de notification, sans fenêtre.
const START_MINIMIZED: &str = "--minimized";

#[tauri::command]
fn app_tray_available() -> bool {
    tray::available()
}

#[tauri::command]
fn app_set_close_to_tray(state: State<'_, tray::CloseToTray>, enabled: bool) {
    state.0.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// Démarrer avec la session : `enabled` le pose ou le retire ; rend l'état.
#[tauri::command]
fn app_autostart(app: AppHandle, enabled: Option<bool>) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    match enabled {
        Some(true) => launcher.enable().map_err(|e| e.to_string())?,
        Some(false) => launcher.disable().map_err(|e| e.to_string())?,
        None => {}
    }
    launcher.is_enabled().map_err(|e| e.to_string())
}

// ─── Extension de navigateur (`src/native_host.rs`, `src/browser.rs`) ────────

/// Inscrire l'hôte natif auprès des navigateurs (`enabled`), ou l'en
/// retirer ; rend l'état.
#[tauri::command]
fn app_browser_integration(enabled: Option<bool>) -> Result<bool, String> {
    match enabled {
        Some(true) => browser::enable()?,
        Some(false) => browser::disable()?,
        None => {}
    }
    Ok(browser::enabled())
}

// ─── Mises à jour ───────────────────────────────────────────────────────────

/// La version qu'annonce la release (`latest.json`), quelle qu'elle soit —
/// pour dire « à jour » ou « GitHub annonce encore une version plus
/// ancienne ». Jamais proposée à l'installation : on ne lit que son numéro.
#[tauri::command]
async fn app_update_advertised(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater_builder()
        .version_comparator(|_current, _remote| true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(updater.check().await.map_err(|e| e.to_string())?.map(|u| u.version))
}

/// Les arguments que wry passe d'office à WebView2 (et qu'en remplacer
/// effacerait).
#[cfg(windows)]
const WEBVIEW2_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// La fenêtre principale, créée ici plutôt que d'office (`create: false`
/// dans `tauri.conf.json`) pour une seule raison : sous Windows, quand
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` est posée — c'est ainsi que
/// msedgedriver demande le port de débogage aux tests de bout en bout —,
/// elle est reprise dans les arguments passés à WebView2 par l'API.
/// WebView2 l'applique d'ordinaire de lui-même, mais pas dans un processus
/// administrateur (le runner Windows de GitHub) : la session WebDriver n'y
/// trouvait jamais son port. Sans la variable, rien ne change.
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main") else {
        return Ok(());
    };
    #[allow(unused_mut)]
    let mut config = config.clone();
    #[cfg(windows)]
    if let Some(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        config.additional_browser_args = Some(format!("{WEBVIEW2_DEFAULT_ARGS} {extra}"));
    }
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
    Ok(())
}

fn main() {
    // Lancé par un navigateur : l'hôte natif de l'extension, sans fenêtre ni
    // Tauri — et sans passer par l'instance unique.
    if native_host::invoked(&std::env::args().collect::<Vec<_>>()) {
        native_host::run();
        return;
    }
    tauri::Builder::default()
        // En premier : une seconde instance ne fait que ramener la fenêtre
        // de la première, et s'arrête.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![START_MINIMIZED]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Coffre::default())
        .manage(Hotkey::default())
        .manage(tray::CloseToTray::default())
        .invoke_handler(tauri::generate_handler![
            local_create,
            local_open,
            local_close,
            local_call,
            local_backups,
            local_restore_backup,
            autotype_available,
            autotype_set_hotkey,
            autotype_type,
            autotype_self_target,
            clipboard_native,
            clipboard_copy_secret,
            system_idle_ms,
            app_tray_available,
            app_set_close_to_tray,
            app_autostart,
            app_browser_integration,
            app_update_advertised
        ])
        .setup(|app| {
            if let Err(e) = tray::install(app.handle()) {
                eprintln!("zone de notification indisponible : {e}");
            }
            create_main_window(app)?;
            if let Some(w) = app.get_webview_window("main") {
                system::watch(app.handle(), &w);
                // La fenêtre part cachée (`tauri.conf.json`) : montrée ici,
                // sauf au démarrage de session.
                if !std::env::args().any(|a| a == START_MINIMIZED) || !tray::available() {
                    let _ = w.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fermer la fenêtre la range dans la zone de notification, si on
            // l'a voulu et qu'il y en a une ; l'interface le sait (« zone »)
            // pour verrouiller si on l'a demandé à la réduction.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
                && tray::available()
                && window.state::<tray::CloseToTray>().get()
            {
                api.prevent_close();
                let _ = window.hide();
                let _ = window.emit_to("main", system::LOCK_EVENT, "zone");
            }
        })
        .run(tauri::generate_context!())
        .expect("échec du lancement de GuiVault");
}
