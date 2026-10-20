//! Ce que le système dit à l'application (Windows) : la session verrouillée
//! (Win+L), la mise en veille — GuiVault se verrouille alors (`App.tsx`,
//! événement `system-lock`) — et l'inactivité de tout l'ordinateur, pour qui
//! préfère la compter ainsi (saisie automatique depuis d'autres fenêtres).
#[cfg(not(windows))]
use tauri::{AppHandle, WebviewWindow};

/// L'événement envoyé à l'interface, avec la raison (`session`, `veille`).
#[cfg_attr(not(windows), allow(dead_code))]
pub const LOCK_EVENT: &str = "system-lock";

#[cfg(windows)]
pub use win::{idle_ms, watch};

#[cfg(not(windows))]
pub fn watch(_app: &AppHandle, _window: &WebviewWindow) {}

#[cfg(not(windows))]
pub fn idle_ms() -> Option<u64> {
    None
}

#[cfg(windows)]
mod win {
    use super::LOCK_EVENT;
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter, WebviewWindow};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::RemoteDesktop::{NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();

    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        let reason = match msg {
            WM_WTSSESSION_CHANGE if wparam as u32 == WTS_SESSION_LOCK => Some("session"),
            WM_POWERBROADCAST if wparam as u32 == PBT_APMSUSPEND => Some("veille"),
            _ => None,
        };
        if let (Some(reason), Some(app)) = (reason, APP.get()) {
            let _ = app.emit_to("main", LOCK_EVENT, reason);
        }
        // SAFETY: on rend la main à la procédure d'origine, mêmes arguments.
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    /// Branche la fenêtre principale sur les avis de session et de veille.
    pub fn watch(app: &AppHandle, window: &WebviewWindow) {
        let _ = APP.set(app.clone());
        let Ok(h) = window.hwnd() else { return };
        let hwnd = h.0 as HWND;
        // SAFETY: fenêtre de l'application, vivante ; la procédure ne garde
        // rien d'elle, et l'id 1 n'est posé qu'une fois.
        unsafe {
            SetWindowSubclass(hwnd, Some(proc), 1, 0);
            WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        }
    }

    /// Depuis combien de millisecondes personne n'a touché ni clavier ni
    /// souris, sur tout l'ordinateur.
    pub fn idle_ms() -> Option<u64> {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: structure initialisée, taille annoncée.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        // SAFETY: lecture d'un compteur ; les deux bouclent ensemble sur
        // 49 jours, d'où la soustraction modulaire.
        Some(u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dwTime)))
    }
}
