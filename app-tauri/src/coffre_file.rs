//! Sortir un coffre de l'appareil, en faire entrer un (`docs/ANDROID.md`).
//! Le sélecteur de documents et le zip sont en Kotlin
//! (`gen/android/.../CoffreFilePlugin.kt`, commandes `plugin:coffrefile|save`
//! et `|pick`, autorisées par `build.rs` et `capabilities/mobile.json`) ; la
//! copie cohérente et l'adoption, dans `guivault_local` (`lib.rs` :
//! `local_export_snapshot`, `local_staging`, `local_import`).

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("coffrefile")
        .setup(|_app, api| {
            api.register_android_plugin("dev.guivault.client", "CoffreFilePlugin")?;
            Ok(())
        })
        .build()
}
