//! Sortir un coffre de l'appareil, en faire entrer un (`docs/ANDROID.md`) :
//! sur Android, les coffres vivent dans le dossier privé de l'app, que la
//! désinstallation efface. L'app en tire une archive (`export_coffre`, puis
//! un zip écrit là où l'utilisateur le range) et adopte celle qu'on lui donne
//! (`import_coffre`, une fois décompressée). Le format est celui du dossier
//! (`docs/FORMATS.md`, « Coffre local ») : l'archive décompressée s'ouvre
//! telle quelle au bureau, ou par `gv recover`.
//!
//! Rien n'est déchiffré : ce sont les mêmes blobs, copiés.
use crate::error::{Error, Result};
use crate::format;
use std::fs;
use std::path::Path;
use uuid::Uuid;

/// Copie cohérente du coffre de `dir` dans `dest` (qui ne doit pas déjà
/// contenir de coffre) : `coffre.json` et les pièces jointes, lus sous le
/// verrou partagé — une écriture concurrente attend. **Sans les
/// sauvegardes** : elles s'ouvrent avec le mot de passe maître de leur date,
/// peut-être un ancien déjà compromis, et n'ont rien à faire hors de
/// l'appareil.
pub fn export_coffre(dir: &Path, dest: &Path) -> Result<()> {
    let _lock = format::lock(dir, false)?;
    // Lisible par cette version, sinon on n'exporte pas un fichier abîmé.
    format::read(dir)?;
    let bytes = fs::read(format::coffre_path(dir))
        .map_err(|e| Error::io(format!("lecture de {}", format::coffre_path(dir).display()), e))?;
    write_new(dest, &bytes, &dir.join("attachments"))?;
    // Le verrou de la copie n'a rien à faire dans l'archive.
    let _ = fs::remove_file(dest.join(format::LOCK_NAME));
    Ok(())
}

/// Fait de `src` (un dossier de coffre venu d'ailleurs : une archive
/// décompressée) un coffre de `dest`, par copie. Refusé si `src` n'est pas un
/// coffre que cette version sait lire (`local_corrupt`,
/// `local_format_unsupported`) ou si `dest` en contient déjà un
/// (`local_exists`). `new_id` : un autre identifiant — quand l'appareil a
/// déjà ce coffre, la copie ne doit pas hériter de ce que l'interface a
/// retenu de lui (révisions vues, manifestes), comme une sauvegarde
/// restaurée (`backup.rs`). Ce qui n'est ni `coffre.json` ni dans
/// `attachments/` (sauvegardes, verrou, autres fichiers) n'est pas repris.
pub fn import_coffre(src: &Path, dest: &Path, new_id: bool) -> Result<()> {
    format::read(src)?;
    let path = format::coffre_path(src);
    let bytes = fs::read(&path).map_err(|e| Error::io(format!("lecture de {}", path.display()), e))?;
    let bytes = if new_id {
        let mut json: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| Error::new(500, "local_corrupt", e.to_string()))?;
        json["id"] = serde_json::Value::String(Uuid::new_v4().to_string());
        serde_json::to_vec(&json).map_err(|e| Error::new(500, "local_io", e.to_string()))?
    } else {
        bytes
    };
    write_new(dest, &bytes, &src.join("attachments"))
}

/// L'identifiant du coffre de `dir`, sans l'ouvrir pour de bon.
pub fn coffre_id(dir: &Path) -> Result<Uuid> {
    Ok(format::read(dir)?.id)
}

fn write_new(dest: &Path, coffre: &[u8], attachments: &Path) -> Result<()> {
    format::ensure_dir(dest)?;
    let _lock = format::lock(dest, true)?;
    if format::coffre_path(dest).exists() {
        return Err(Error::conflict(
            "local_exists",
            format!("il y a déjà un coffre dans {}", dest.display()),
        ));
    }
    if attachments.is_dir() {
        copy_files(attachments, &dest.join("attachments"))?;
    }
    // `coffre.json` en dernier : tant qu'il manque, le dossier n'est pas un
    // coffre (une copie interrompue ne s'ouvre pas à moitié).
    format::write_atomic(&format::coffre_path(dest), coffre)
}

/// Copie récursive des seuls dossiers et fichiers ordinaires : un lien
/// symbolique (une archive piégée) est ignoré, jamais suivi.
fn copy_files(from: &Path, to: &Path) -> Result<()> {
    format::ensure_dir(to)?;
    let entries = fs::read_dir(from).map_err(|e| Error::io(format!("lecture de {}", from.display()), e))?;
    for e in entries {
        let e = e.map_err(|e| Error::io(format!("lecture de {}", from.display()), e))?;
        let kind = e
            .file_type()
            .map_err(|err| Error::io(format!("lecture de {}", e.path().display()), err))?;
        let target = to.join(e.file_name());
        if kind.is_dir() {
            copy_files(&e.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(e.path(), &target).map_err(|err| Error::io(format!("copie de {}", e.path().display()), err))?;
        }
    }
    Ok(())
}
