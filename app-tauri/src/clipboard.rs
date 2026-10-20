//! Le presse-papiers des secrets, sous Windows (`web/src/lib/clipboard.ts`
//! s'en sert quand l'application l'offre) — ce que fait KeePass :
//!
//! - le texte part avec les formats qui l'excluent de l'**historique**
//!   (Win+V) et du **presse-papiers cloud** :
//!   `ExcludeClipboardContentFromMonitorProcessing`,
//!   `CanIncludeInClipboardHistory` = 0, `CanUploadToCloudClipboard` = 0 ;
//! - l'effacement est fait ici, à l'échéance, **seulement si personne n'a
//!   copié autre chose depuis** : le numéro de séquence du presse-papiers
//!   (`GetClipboardSequenceNumber`) le dit sans relire le secret, et sans
//!   que la fenêtre ait le focus (réduite, cachée dans la zone de
//!   notification).
#[cfg(windows)]
pub use win::copy_secret;

#[cfg(not(windows))]
pub fn copy_secret(_owner: isize, _text: &str, _clear_after_ms: u64) -> Result<(), String> {
    Err("presse-papiers natif : Windows seulement".into())
}

#[cfg(windows)]
mod win {
    use std::thread::{sleep, spawn};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW,
        SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    /// Le presse-papiers est à une seule application à la fois : une autre
    /// peut le tenir un instant, on réessaie.
    fn open(owner: HWND) -> Result<(), String> {
        for _ in 0..20 {
            // SAFETY: `owner` est la fenêtre de l'application (ou nul).
            if unsafe { OpenClipboard(owner) } != 0 {
                return Ok(());
            }
            sleep(Duration::from_millis(25));
        }
        Err("le presse-papiers est occupé par une autre application".into())
    }

    struct Opened;
    impl Drop for Opened {
        fn drop(&mut self) {
            // SAFETY: ouvert par `open`.
            unsafe { CloseClipboard() };
        }
    }

    fn format(name: &str) -> u32 {
        let w: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        // SAFETY: chaîne terminée par zéro.
        unsafe { RegisterClipboardFormatW(w.as_ptr()) }
    }

    /// Des octets dans un bloc global, remis au presse-papiers (qui en
    /// devient propriétaire si `SetClipboardData` réussit).
    fn set(fmt: u32, bytes: &[u8]) -> Result<(), String> {
        // SAFETY: allocation, copie dans les bornes, libération en cas
        // d'échec seulement (sinon le bloc appartient au presse-papiers).
        unsafe {
            let h: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
            if h.is_null() {
                return Err("mémoire insuffisante".into());
            }
            let p = GlobalLock(h) as *mut u8;
            if p.is_null() {
                GlobalFree(h);
                return Err("mémoire inaccessible".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            GlobalUnlock(h);
            if SetClipboardData(fmt, h as HANDLE).is_null() {
                GlobalFree(h);
                return Err("le presse-papiers a refusé la donnée".into());
            }
        }
        Ok(())
    }

    /// Copie `text` hors de l'historique et du cloud ; l'efface au bout de
    /// `clear_after_ms` (0 : jamais) s'il est encore là.
    pub fn copy_secret(owner: isize, text: &str, clear_after_ms: u64) -> Result<(), String> {
        let owner = owner as HWND;
        let mut utf16: Vec<u8> = text.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect();
        let seq = {
            open(owner)?;
            let _guard = Opened;
            // SAFETY: presse-papiers ouvert par nous.
            unsafe { EmptyClipboard() };
            let r = set(CF_UNICODETEXT as u32, &utf16);
            utf16.fill(0);
            r?;
            let zero = 0u32.to_le_bytes();
            set(format("ExcludeClipboardContentFromMonitorProcessing"), &zero)?;
            set(format("CanIncludeInClipboardHistory"), &zero)?;
            set(format("CanUploadToCloudClipboard"), &zero)?;
            drop(_guard);
            // SAFETY: lecture d'un compteur.
            unsafe { GetClipboardSequenceNumber() }
        };
        if clear_after_ms > 0 {
            let owner = owner as isize;
            spawn(move || {
                sleep(Duration::from_millis(clear_after_ms));
                // SAFETY: lecture d'un compteur.
                if unsafe { GetClipboardSequenceNumber() } != seq {
                    return; // quelqu'un a copié autre chose : plus à nous d'y toucher
                }
                if open(owner as HWND).is_ok() {
                    let _guard = Opened;
                    // SAFETY: presse-papiers ouvert par nous.
                    unsafe { EmptyClipboard() };
                }
            });
        }
        Ok(())
    }
}
