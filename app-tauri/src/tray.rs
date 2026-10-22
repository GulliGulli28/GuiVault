//! La zone de notification (Windows) : GuiVault y vit quand sa fenêtre est
//! fermée — le raccourci de saisie automatique reste actif. Menu : ouvrir,
//! verrouiller, quitter. Ailleurs (Linux : il y faut une bibliothèque
//! d'indicateurs souvent absente), pas d'icône, et fermer la fenêtre quitte —
//! sans icône, une fenêtre cachée ne se retrouverait plus.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

/// Fermer la fenêtre la range dans la zone de notification (réglage de
/// l'interface, `app_set_close_to_tray`) plutôt que de quitter.
pub struct CloseToTray(pub AtomicBool);

impl Default for CloseToTray {
    fn default() -> Self {
        Self(AtomicBool::new(true))
    }
}

impl CloseToTray {
    pub fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Ramène la fenêtre principale (le bureau : l'instance unique, la zone de
/// notification).
#[cfg(desktop)]
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(windows)]
pub fn available() -> bool {
    true
}

#[cfg(not(windows))]
pub fn available() -> bool {
    false
}

/// L'icône et son menu. Une erreur ici ne doit pas empêcher l'application
/// de s'ouvrir : elle est dite, et l'on quitte en fermant la fenêtre.
#[cfg(windows)]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    use tauri::Emitter;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Ouvrir GuiVault", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", "Verrouiller", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &lock, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("GuiVault")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "lock" => {
                let _ = app.emit_to("main", crate::system::LOCK_EVENT, "menu");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(not(windows))]
pub fn install(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}
