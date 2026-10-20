//! Les sauvegardes du coffre (comme KeePass) : avant une écriture, si la
//! dernière a plus de `Options::backup_interval`, une copie de `coffre.json`
//! dans `backups/coffre-<date UTC>.json` ; les `Options::backups` plus
//! récentes sont gardées. Ce sont des fichiers comme le coffre : chiffrés,
//! illisibles sans le mot de passe maître (celui **de leur date**, s'il a
//! changé depuis).
//!
//! Restaurer n'écrase rien : une sauvegarde devient un **nouveau coffre**
//! dans un autre dossier (`restore_backup`), avec un nouvel identifiant —
//! sinon il hériterait de ce que l'interface a retenu de l'original
//! (révisions vues, manifestes), et signalerait un retour en arrière. Ça
//! marche aussi pour un coffre qui ne s'ouvre plus (`local_corrupt`).
//!
//! Les pièces jointes ne sont pas dans les sauvegardes : la copie reprend le
//! dossier `attachments/` du coffre tel qu'il est (un fichier joint après la
//! sauvegarde y est en trop, un fichier purgé depuis y manque).
use crate::error::{Error, Result};
use crate::format;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const DIR: &str = "backups";
const PREFIX: &str = "coffre-";
const SUFFIX: &str = ".json";
const STAMP: &str = "%Y%m%d-%H%M%S";

/// Une sauvegarde, telle que la liste la montre.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupInfo {
    /// Le nom du fichier, à repasser à [`restore_backup`].
    pub name: String,
    pub taken_at: DateTime<Utc>,
    pub size: u64,
}

fn dir_of(coffre: &Path) -> PathBuf {
    coffre.join(DIR)
}

/// La date d'une sauvegarde, et son rang dans la seconde : `…-140000` (1),
/// `…-140000-2` (2) — deux dans la même seconde, l'ordre alphabétique les
/// rangerait à l'envers.
fn parse_name(name: &str) -> Option<(DateTime<Utc>, u32)> {
    let stamp = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    let (stamp, rank) = match stamp.rsplit_once('-') {
        Some((head, n)) if head.len() == 15 && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => {
            (head, n.parse().ok()?)
        }
        _ => (stamp, 1),
    };
    let at = NaiveDateTime::parse_from_str(stamp, STAMP).ok()?.and_utc();
    Some((at, rank))
}

/// Les sauvegardes d'un coffre, la plus récente d'abord. Ne demande pas que
/// le coffre s'ouvre.
pub fn backups(coffre: &Path) -> Result<Vec<BackupInfo>> {
    let dir = dir_of(coffre);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(format!("lecture de {}", dir.display()), e)),
    };
    let mut out: Vec<(u32, BackupInfo)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let (taken_at, rank) = parse_name(&name)?;
            let size = e.metadata().ok()?.len();
            Some((rank, BackupInfo { name, taken_at, size }))
        })
        .collect();
    out.sort_by(|(ra, a), (rb, b)| b.taken_at.cmp(&a.taken_at).then(rb.cmp(ra)));
    Ok(out.into_iter().map(|(_, b)| b).collect())
}

/// À appeler sous le verrou exclusif, avant d'écrire : copie le coffre tel
/// qu'il est si la dernière sauvegarde est assez vieille, puis ne garde que
/// les `keep` plus récentes. Une sauvegarde ratée n'empêche pas d'écrire
/// (l'écriture est atomique de toute façon) : elle rend `false`.
pub(crate) fn maybe_backup(coffre: &Path, now: DateTime<Utc>, every: Duration, keep: usize) -> bool {
    if keep == 0 {
        return true;
    }
    let existing = backups(coffre).unwrap_or_default();
    let due = existing
        .first()
        .is_none_or(|last| (now - last.taken_at).to_std().unwrap_or(Duration::ZERO) >= every);
    if !due {
        return true;
    }
    let dir = dir_of(coffre);
    if format::ensure_dir(&dir).is_err() {
        return false;
    }
    let mut name = format!("{PREFIX}{}{SUFFIX}", now.format(STAMP));
    // Deux sauvegardes dans la même seconde (intervalle nul) : un suffixe.
    let mut n = 1;
    while dir.join(&name).exists() {
        n += 1;
        name = format!("{PREFIX}{}-{n}{SUFFIX}", now.format(STAMP));
    }
    let ok = match fs::read(format::coffre_path(coffre)) {
        Ok(bytes) => format::write_atomic(&dir.join(&name), &bytes).is_ok(),
        Err(_) => false,
    };
    // Les plus vieilles partent.
    if let Ok(all) = backups(coffre) {
        for old in all.iter().skip(keep) {
            let _ = fs::remove_file(dir.join(&old.name));
        }
    }
    ok
}

/// Fait de la sauvegarde `name` du coffre `coffre` un nouveau coffre dans
/// `dest` (créé ; refusé s'il contient déjà un coffre), avec un nouvel
/// identifiant et une copie des pièces jointes.
pub fn restore_backup(coffre: &Path, name: &str, dest: &Path) -> Result<()> {
    if parse_name(name).is_none() || name.contains(['/', '\\']) {
        return Err(Error::bad_request(
            "invalid_backup",
            format!("« {name} » n'est pas une sauvegarde"),
        ));
    }
    let src = dir_of(coffre).join(name);
    let bytes = fs::read(&src).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::not_found("sauvegarde"),
        _ => Error::io(format!("lecture de {}", src.display()), e),
    })?;
    let mut json: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| Error::new(500, "local_corrupt", format!("sauvegarde illisible : {e}")))?;
    if json
        .get("format")
        .and_then(|f| f.as_u64())
        .is_none_or(|f| f > u64::from(format::FORMAT))
    {
        return Err(Error::new(
            409,
            "local_format_unsupported",
            "cette sauvegarde est d'un format que cette version ne lit pas",
        ));
    }
    json["id"] = serde_json::Value::String(Uuid::new_v4().to_string());

    format::ensure_dir(dest)?;
    let _lock = format::lock(dest, true)?;
    if format::coffre_path(dest).exists() {
        return Err(Error::conflict(
            "local_exists",
            format!("il y a déjà un coffre dans {}", dest.display()),
        ));
    }
    let attachments = coffre.join("attachments");
    if attachments.is_dir() {
        copy_dir(&attachments, &dest.join("attachments"))?;
    }
    let out = serde_json::to_vec(&json).map_err(|e| Error::new(500, "local_io", e.to_string()))?;
    format::write_atomic(&format::coffre_path(dest), &out)
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    format::ensure_dir(to)?;
    let entries = fs::read_dir(from).map_err(|e| Error::io(format!("lecture de {}", from.display()), e))?;
    for e in entries {
        let e = e.map_err(|e| Error::io(format!("lecture de {}", from.display()), e))?;
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &target)?;
        } else {
            fs::copy(e.path(), &target).map_err(|err| Error::io(format!("copie de {}", e.path().display()), err))?;
        }
    }
    Ok(())
}
