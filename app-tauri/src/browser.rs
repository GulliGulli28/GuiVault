//! Inscrire l'hôte natif (`native_host.rs`) auprès des navigateurs, ou l'en
//! retirer — un réglage explicite de l'application (Paramètres ›
//! Application), désactivé par défaut. Un manifeste JSON par famille de
//! navigateurs (`path` : cet exécutable ; les origines autorisées : notre
//! extension seulement) ;
//!
//! - Windows : dans `%LOCALAPPDATA%\dev.guivault.client\native-messaging\`,
//!   désigné par une clé de registre par navigateur (HKCU) ;
//! - Linux : copié dans le dossier `NativeMessagingHosts` de chaque
//!   navigateur installé (celui dont le dossier de configuration existe).
use crate::native_host::{CHROMIUM_ORIGIN, FIREFOX_EXTENSION, HOST_NAME};
use serde_json::json;
use std::path::PathBuf;

fn manifest(firefox: bool) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut m = json!({
        "name": HOST_NAME,
        "description": "GuiVault : les coffres locaux de l'application, pour l'extension",
        "path": exe,
        "type": "stdio",
    });
    if firefox {
        m["allowed_extensions"] = json!([FIREFOX_EXTENSION]);
    } else {
        m["allowed_origins"] = json!([CHROMIUM_ORIGIN]);
    }
    serde_json::to_string_pretty(&m).map_err(|e| e.to_string())
}

#[cfg(windows)]
mod imp {
    use super::{HOST_NAME, PathBuf, manifest};
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey, RegCreateKeyExW,
        RegDeleteTreeW, RegOpenKeyExW, RegSetValueExW,
    };

    /// Les navigateurs, et la clé où chacun cherche ses hôtes.
    const BROWSERS: &[(&str, bool)] = &[
        (r"Software\Google\Chrome\NativeMessagingHosts", false),
        (r"Software\Microsoft\Edge\NativeMessagingHosts", false),
        (r"Software\Chromium\NativeMessagingHosts", false),
        (r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts", false),
        (r"Software\Mozilla\NativeMessagingHosts", true),
    ];

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn dir() -> Result<PathBuf, String> {
        let base = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA introuvable")?;
        Ok(PathBuf::from(base).join(HOST_NAME).join("native-messaging"))
    }

    pub fn enable() -> Result<(), String> {
        let dir = dir()?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let chromium = dir.join("chromium.json");
        let firefox = dir.join("firefox.json");
        std::fs::write(&chromium, manifest(false)?).map_err(|e| e.to_string())?;
        std::fs::write(&firefox, manifest(true)?).map_err(|e| e.to_string())?;
        for (key, ff) in BROWSERS {
            let path = if *ff { &firefox } else { &chromium };
            let sub = wide(&format!(r"{key}\{HOST_NAME}"));
            let value = wide(&path.to_string_lossy());
            let mut h: HKEY = std::ptr::null_mut();
            // SAFETY: chaînes terminées par zéro, clé refermée.
            unsafe {
                let r = RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    sub.as_ptr(),
                    0,
                    std::ptr::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_WRITE,
                    std::ptr::null(),
                    &mut h,
                    std::ptr::null_mut(),
                );
                if r != ERROR_SUCCESS {
                    return Err(format!("registre : {key} ({r})"));
                }
                let r = RegSetValueExW(
                    h,
                    std::ptr::null(),
                    0,
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                );
                RegCloseKey(h);
                if r != ERROR_SUCCESS {
                    return Err(format!("registre : {key} ({r})"));
                }
            }
        }
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        for (key, _) in BROWSERS {
            let sub = wide(&format!(r"{key}\{HOST_NAME}"));
            // SAFETY: chaîne terminée par zéro ; une clé absente n'est pas
            // une erreur.
            unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, sub.as_ptr()) };
        }
        if let Ok(d) = dir() {
            let _ = std::fs::remove_dir_all(d);
        }
        Ok(())
    }

    pub fn enabled() -> bool {
        let sub = wide(&format!(r"{}\{HOST_NAME}", BROWSERS[0].0));
        let mut h: HKEY = std::ptr::null_mut();
        // SAFETY: idem.
        unsafe {
            let ok = RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_READ, &mut h) == ERROR_SUCCESS;
            if ok {
                RegCloseKey(h);
            }
            ok
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{HOST_NAME, PathBuf, manifest};

    /// Le dossier d'hôtes de chaque navigateur, sous son dossier de
    /// configuration — seulement s'il est installé (dossier présent).
    fn targets() -> Vec<(PathBuf, bool)> {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return Vec::new();
        };
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|x| !x.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        let mut out: Vec<(PathBuf, bool)> = [
            "google-chrome",
            "chromium",
            "microsoft-edge",
            "BraveSoftware/Brave-Browser",
        ]
        .iter()
        .map(|b| config.join(b))
        .filter(|d| d.is_dir())
        .map(|d| (d.join("NativeMessagingHosts"), false))
        .collect();
        if home.join(".mozilla").is_dir() {
            out.push((home.join(".mozilla").join("native-messaging-hosts"), true));
        }
        out
    }

    pub fn enable() -> Result<(), String> {
        for (dir, ff) in targets() {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(format!("{HOST_NAME}.json")), manifest(ff)?).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        for (dir, _) in targets() {
            let _ = std::fs::remove_file(dir.join(format!("{HOST_NAME}.json")));
        }
        Ok(())
    }

    pub fn enabled() -> bool {
        targets()
            .iter()
            .any(|(d, _)| d.join(format!("{HOST_NAME}.json")).exists())
    }
}

pub use imp::{disable, enable, enabled};
