//! La bulle flottante d'Android (`docs/ANDROID.md`) : GuiVault réduit à une
//! bulle par-dessus les autres applications, comme les « chat heads » de
//! Messenger. Tout est en Kotlin (`gen/android/.../BubblePlugin.kt`,
//! `BubbleService.kt`) ; ici, seulement l'inscription du plugin. L'interface
//! appelle ses commandes directement (`plugin:bubble|show`…), autorisées par
//! `build.rs` et `capabilities/mobile.json`.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bubble")
        .setup(|_app, api| {
            api.register_android_plugin("dev.guivault.client", "BubblePlugin")?;
            Ok(())
        })
        .build()
}
