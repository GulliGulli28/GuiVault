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
    let vault = blocking(move || LocalVault::create(path, new).map_err(error)).await?;
    state.set(Some(vault));
    Ok(())
}

#[tauri::command]
async fn local_open(state: State<'_, Coffre>, path: String) -> Result<(), Value> {
    let vault = blocking(move || LocalVault::open(path).map_err(error)).await?;
    state.set(Some(vault));
    Ok(())
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(Coffre::default())
        .manage(Hotkey::default())
        .invoke_handler(tauri::generate_handler![
            local_create,
            local_open,
            local_close,
            local_call,
            autotype_available,
            autotype_set_hotkey,
            autotype_type,
            autotype_self_target
        ])
        .run(tauri::generate_context!())
        .expect("échec du lancement de GuiVault");
}
