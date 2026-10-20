//! L'application GuiVault (`docs/APP.md`) : l'interface web embarquée
//! (`web/app`, construite dans `web/dist-app`), et l'hôte du coffre local
//! qu'elle appelle (`web/app/src/tauriHost.ts`).
//!
//! L'hôte ne fait que passer les opérations à `guivault_local::rpc` : il ne
//! voit que des blobs, comme le serveur — la crypto est dans l'interface.
//! Le mode « serveur » de l'app n'a pas besoin de lui : l'interface parle
//! au serveur en HTTP, comme dans un navigateur (CORS ouvert sur l'API).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use guivault_local::{LocalVault, NewCoffre};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Coffre::default())
        .invoke_handler(tauri::generate_handler![
            local_create,
            local_open,
            local_close,
            local_call
        ])
        .run(tauri::generate_context!())
        .expect("échec du lancement de GuiVault");
}
