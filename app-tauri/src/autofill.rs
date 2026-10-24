//! Le remplissage automatique d'Android (`docs/REMPLISSAGE.md`) : le service
//! de remplissage, son index chiffré et l'écran qui choisit un identifiant
//! sont en Kotlin (`gen/android/.../GuiVaultAutofillService.kt`,
//! `AutofillIndex.kt`, `AutofillActivity.kt`) ; ici, seulement l'inscription
//! du plugin que l'interface appelle (`plugin:autofill|update`…), autorisé
//! par `build.rs` et `capabilities/mobile.json`.

use tauri::Runtime;
use tauri::plugin::{Builder, TauriPlugin};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("autofill")
        .setup(|_app, api| {
            api.register_android_plugin("dev.guivault.client", "AutofillPlugin")?;
            Ok(())
        })
        .build()
}
