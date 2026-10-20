//! La saisie automatique, à la KeePass (`web/src/lib/autotype.ts` dit quoi
//! taper, ici on le tape) : Windows d'abord, par `SendInput` en Unicode — la
//! disposition du clavier n'y change rien.
//!
//! Le texte arrive en clair de l'interface (c'est l'application elle-même,
//! sur ce poste : la règle n°1 tient, rien ne part ailleurs) et il est
//! effacé de la mémoire une fois tapé. Trois garde-fous :
//!
//! - on attend que Ctrl, Alt, Maj et Windows soient relâchés — sinon le
//!   `a` d'un mot de passe tapé pendant qu'on tient encore Ctrl+Alt (le
//!   raccourci) deviendrait Ctrl+Alt+A ;
//! - avant **chaque** caractère, la fenêtre cible doit être au premier plan :
//!   un clic ailleurs pendant la saisie l'arrête net (`autotype_focus_lost`)
//!   — un mot de passe n'est jamais tapé ailleurs que là où il a été demandé ;
//! - sans cible (« Saisie automatique » sur une fiche), on ne tape ni dans
//!   GuiVault, ni sur le bureau ou la barre des tâches.
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

// Hors Windows, rien ne tape : les champs ne sont lus que par `win`.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Action {
    Text { text: String },
    Key { key: Key },
    Delay { ms: u64 },
}

/// Les touches que `lib/autotype.ts` sait nommer (`AutoTypeKey`).
#[derive(Debug, Clone, Copy, Deserialize)]
pub enum Key {
    Tab,
    Enter,
    Space,
    Backspace,
    Delete,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
}

/// Efface le texte des actions — appelé quoi qu'il arrive à la saisie.
pub fn wipe(actions: &mut [Action]) {
    for a in actions {
        if let Action::Text { text } = a {
            text.zeroize();
        }
    }
}

/// Une erreur pour l'interface : un code stable, un message humain.
#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Une fenêtre au premier plan : son handle (opaque pour l'interface) et son
/// titre.
#[derive(Debug, Clone, Serialize)]
pub struct Foreground {
    pub target: String,
    pub title: String,
}

#[cfg(windows)]
pub use win::{foreground, type_actions};

#[cfg(not(windows))]
pub fn foreground() -> Option<Foreground> {
    None
}

#[cfg(not(windows))]
pub fn type_actions(
    _target: Option<&str>,
    _own: Option<isize>,
    _minimize: &dyn Fn(),
    _actions: &[Action],
) -> Result<(), Error> {
    Err(Error::new(
        "autotype_unsupported",
        "La saisie automatique n'existe encore que sous Windows.",
    ))
}

#[cfg(windows)]
mod win {
    use super::{Action, Error, Foreground, Key};
    use std::thread::sleep;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, SendInput, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME,
        VK_INSERT, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_RWIN, VK_SHIFT, VK_SPACE,
        VK_TAB, VK_UP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowTextW, IsWindow, SetForegroundWindow,
    };

    /// Entre deux frappes : certaines applications perdent des caractères
    /// envoyés trop vite (même réglage par défaut que KeePass, 10 ms).
    const KEY_DELAY: Duration = Duration::from_millis(10);

    fn hwnd_of(target: &str) -> Option<HWND> {
        target.parse::<isize>().ok().filter(|v| *v != 0).map(|v| v as HWND)
    }

    fn title_of(h: HWND) -> String {
        let mut buf = [0u16; 512];
        // SAFETY: tampon valide de la taille annoncée.
        let n = unsafe { GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 256];
        // SAFETY: idem.
        let n = unsafe { GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn fg() -> HWND {
        // SAFETY: sans argument, ne fait que lire.
        unsafe { GetForegroundWindow() }
    }

    pub fn foreground() -> Option<Foreground> {
        let h = fg();
        if h.is_null() {
            return None;
        }
        Some(Foreground {
            target: (h as isize).to_string(),
            title: title_of(h),
        })
    }

    /// Le bureau et la barre des tâches : jamais une cible.
    fn is_shell(h: HWND) -> bool {
        matches!(
            class_of(h).as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        )
    }

    fn wait_until(timeout: Duration, mut ok: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        loop {
            if ok() {
                return true;
            }
            if start.elapsed() > timeout {
                return false;
            }
            sleep(Duration::from_millis(25));
        }
    }

    fn modifiers_released() -> bool {
        [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
            .iter()
            // SAFETY: lecture de l'état d'une touche.
            .all(|vk| unsafe { GetAsyncKeyState(*vk as i32) } as u16 & 0x8000 == 0)
    }

    fn input(vk: VIRTUAL_KEY, scan: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send(inputs: &[INPUT]) -> Result<(), Error> {
        // SAFETY: tableau valide d'INPUT, taille d'une structure exacte.
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if sent as usize != inputs.len() {
            return Err(Error::new(
                "autotype_blocked",
                "Windows a refusé la saisie (fenêtre d'une application lancée en administrateur ?).",
            ));
        }
        Ok(())
    }

    fn press(vk: VIRTUAL_KEY) -> Result<(), Error> {
        let ext = if matches!(
            vk,
            VK_UP | VK_DOWN | VK_LEFT | VK_RIGHT | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_INSERT | VK_DELETE
        ) {
            KEYEVENTF_EXTENDEDKEY
        } else {
            0
        };
        send(&[input(vk, 0, ext), input(vk, 0, ext | KEYEVENTF_KEYUP)])
    }

    fn vk(key: Key) -> VIRTUAL_KEY {
        match key {
            Key::Tab => VK_TAB,
            Key::Enter => VK_RETURN,
            Key::Space => VK_SPACE,
            Key::Backspace => VK_BACK,
            Key::Delete => VK_DELETE,
            Key::Escape => VK_ESCAPE,
            Key::Up => VK_UP,
            Key::Down => VK_DOWN,
            Key::Left => VK_LEFT,
            Key::Right => VK_RIGHT,
            Key::Home => VK_HOME,
            Key::End => VK_END,
            Key::PageUp => VK_PRIOR,
            Key::PageDown => VK_NEXT,
            Key::Insert => VK_INSERT,
        }
    }

    /// Un caractère : les sauts de ligne et tabulations deviennent des
    /// touches (une note sur plusieurs lignes), le reste de l'Unicode tel
    /// quel — une paire de substitution, c'est deux unités envoyées ensemble.
    fn type_char(c: char) -> Result<(), Error> {
        match c {
            '\r' => Ok(()),
            '\n' => press(VK_RETURN),
            '\t' => press(VK_TAB),
            _ => {
                let mut units = [0u16; 2];
                let mut inputs = Vec::with_capacity(4);
                for u in c.encode_utf16(&mut units).iter() {
                    inputs.push(input(0, *u, KEYEVENTF_UNICODE));
                    inputs.push(input(0, *u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
                let r = send(&inputs);
                units.fill(0);
                r
            }
        }
    }

    /// Tape `actions` dans `target` (un handle rendu par [`foreground`]) ou,
    /// sans cible, dans la fenêtre qui reprend le premier plan une fois
    /// GuiVault (`own`) réduit par `minimize`.
    pub fn type_actions(
        target: Option<&str>,
        own: Option<isize>,
        minimize: &dyn Fn(),
        actions: &[Action],
    ) -> Result<(), Error> {
        let own = own.map(|v| v as HWND);
        let target = match target {
            Some(t) => {
                let h = hwnd_of(t).ok_or_else(|| Error::new("autotype_target_gone", "Fenêtre cible invalide."))?;
                // SAFETY: ne fait que vérifier le handle.
                if unsafe { IsWindow(h) } == 0 {
                    return Err(Error::new("autotype_target_gone", "La fenêtre cible a été fermée."));
                }
                if fg() != h {
                    // GuiVault est au premier plan (on vient d'y choisir un
                    // identifiant) : il a le droit de le rendre.
                    // SAFETY: handle vérifié ci-dessus.
                    unsafe { SetForegroundWindow(h) };
                    if own.is_some_and(|o| o != h) {
                        minimize();
                    }
                }
                h
            }
            None => {
                minimize();
                let ok = wait_until(Duration::from_millis(1500), || {
                    let f = fg();
                    !f.is_null() && Some(f) != own
                });
                let f = fg();
                if !ok || f.is_null() || is_shell(f) || Some(f) == own {
                    return Err(Error::new(
                        "autotype_no_target",
                        "Aucune fenêtre où taper : ouvrez d'abord celle du formulaire, puis revenez à GuiVault.",
                    ));
                }
                f
            }
        };
        if !wait_until(Duration::from_millis(1500), || fg() == target) {
            return Err(Error::new(
                "autotype_focus_lost",
                "La fenêtre cible n'a pas pris le focus : rien n'a été tapé.",
            ));
        }
        if !wait_until(Duration::from_secs(5), modifiers_released) {
            return Err(Error::new(
                "autotype_modifiers",
                "Ctrl, Alt, Maj ou Windows est resté enfoncé : rien n'a été tapé.",
            ));
        }
        let lost = || {
            Error::new(
                "autotype_focus_lost",
                "La fenêtre a perdu le focus : saisie interrompue.",
            )
        };
        for a in actions {
            match a {
                Action::Text { text } => {
                    for c in text.chars() {
                        if fg() != target {
                            return Err(lost());
                        }
                        type_char(c)?;
                        sleep(KEY_DELAY);
                    }
                }
                Action::Key { key } => {
                    if fg() != target {
                        return Err(lost());
                    }
                    press(vk(*key))?;
                    sleep(KEY_DELAY);
                }
                Action::Delay { ms } => sleep(Duration::from_millis((*ms).min(10_000))),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_read_the_json_of_autotype_ts() {
        let mut actions: Vec<Action> = serde_json::from_str(
            r#"[{"kind":"text","text":"alice"},{"kind":"key","key":"Tab"},{"kind":"key","key":"PageDown"},{"kind":"delay","ms":250}]"#,
        )
        .unwrap();
        assert!(matches!(&actions[0], Action::Text { text } if text == "alice"));
        assert!(matches!(actions[2], Action::Key { key: Key::PageDown }));
        assert!(matches!(actions[3], Action::Delay { ms: 250 }));
        wipe(&mut actions);
        assert!(matches!(&actions[0], Action::Text { text } if text.is_empty()));
        // Une touche que l'interface ne sait pas nommer est refusée.
        assert!(serde_json::from_str::<Vec<Action>>(r#"[{"kind":"key","key":"F13"}]"#).is_err());
    }
}
