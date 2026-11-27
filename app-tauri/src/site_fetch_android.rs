//! Les icônes des sites sur Android : le pendant de `site_fetch.rs`, en
//! Kotlin (`gen/android/.../SiteFetchPlugin.kt`, la pile HTTPS du système) ;
//! ici, seulement l'inscription du plugin, dont l'interface appelle la
//! commande `plugin:sitefetch|fetch`, autorisée par `build.rs` et
//! `capabilities/mobile.json`.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sitefetch")
        .setup(|_app, api| {
            api.register_android_plugin("dev.guivault.client", "SiteFetchPlugin")?;
            Ok(())
        })
        .build()
}
