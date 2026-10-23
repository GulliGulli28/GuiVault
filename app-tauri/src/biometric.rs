//! Le déverrouillage biométrique d'Android (`docs/ANDROID.md`) : la user key
//! sous une clé du Keystore, libérée par une empreinte ou le visage. Tout est
//! en Kotlin (`gen/android/.../BiometricPlugin.kt`) ; ici, seulement
//! l'inscription du plugin, dont l'interface appelle les commandes
//! (`plugin:biometric|unlock`…), autorisées par `build.rs` et
//! `capabilities/mobile.json`.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("biometric")
        .setup(|_app, api| {
            api.register_android_plugin("dev.guivault.client", "BiometricPlugin")?;
            Ok(())
        })
        .build()
}
