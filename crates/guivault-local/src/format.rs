//! Le fichier `coffre.json` et ce qui l'entoure sur le disque : lecture,
//! écriture atomique, verrou.
//!
//! Tout le coffre (compte enveloppé, vaults, items, historique) tient dans
//! **un seul fichier**, réécrit en entier à chaque écriture : un `rename`
//! atomique fait de chaque opération une transaction, sans journal. Les
//! pièces jointes, elles, vivent à côté (`attachments/<vault>/<id>/<n>.bin`)
//! pour que ce fichier reste petit.
//!
//! Champs inconnus conservés (`extra`) en tête et sur chaque vault : un
//! coffre écrit par une version plus récente de l'app ne perd rien quand une
//! plus ancienne y écrit, tant que le `format` est le même.
use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
use guivault_crypto::AccountMaterial;
use guivault_protocol::{
    Attachment, Item, ItemVersion, KdfParams, Role, UserSettings, Vault, VaultKind, VaultManifest, b64,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Version du format de `coffre.json`. Un coffre d'un format plus récent est
/// refusé (`local_format_unsupported`) plutôt que réécrit à moitié compris.
pub const FORMAT: u32 = 1;
pub const FILE_NAME: &str = "coffre.json";
pub(crate) const LOCK_NAME: &str = ".lock";
const ATTACHMENTS_DIR: &str = "attachments";

/// Le compte du coffre, tel que le serveur le garderait — sans la clé
/// d'authentification : il n'y a personne à qui s'authentifier. Le mot de
/// passe maître se vérifie à l'ouverture de la user key (tag AEAD).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalAccount {
    pub kdf: KdfParams,
    #[serde(with = "b64")]
    pub kdf_salt: Vec<u8>,
    /// *user key* enveloppée sous la *stretched key*.
    #[serde(with = "b64")]
    pub protected_user_key: Vec<u8>,
    #[serde(with = "b64")]
    pub public_key: Vec<u8>,
    /// Clé privée X25519 enveloppée sous la *user key*.
    #[serde(with = "b64")]
    pub protected_private_key: Vec<u8>,
}

impl From<&AccountMaterial> for LocalAccount {
    fn from(m: &AccountMaterial) -> Self {
        Self {
            kdf: m.kdf,
            kdf_salt: m.kdf_salt.clone(),
            protected_user_key: m.protected_user_key.clone(),
            public_key: m.public_key.clone(),
            protected_private_key: m.protected_private_key.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Coffre {
    pub format: u32,
    /// Choisi à la création ; ne change jamais (renommer ou déplacer le
    /// dossier ne change pas le coffre).
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub account: LocalAccount,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<UserSettings>,
    pub vaults: Vec<StoredVault>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Coffre {
    pub fn vault(&self, id: Uuid) -> Result<&StoredVault> {
        self.vaults
            .iter()
            .find(|v| v.id == id)
            .ok_or_else(|| Error::not_found("vault"))
    }

    pub fn vault_mut(&mut self, id: Uuid) -> Result<&mut StoredVault> {
        self.vaults
            .iter_mut()
            .find(|v| v.id == id)
            .ok_or_else(|| Error::not_found("vault"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoredVault {
    pub id: Uuid,
    pub kind: VaultKind,
    #[serde(with = "b64")]
    pub name_enc: Vec<u8>,
    /// La clé du vault enveloppée pour la clé publique du compte.
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "b64::option")]
    pub manifest: Option<Vec<u8>>,
    /// Comme la colonne du serveur : 0 tant qu'il n'y a pas de manifeste.
    #[serde(default)]
    pub manifest_revision: i64,
    /// Pierres tombales comprises (`deleted_at`), comme côté serveur : un
    /// lecteur qui synchronise par `since` doit voir partir un item.
    #[serde(default)]
    pub items: Vec<StoredItem>,
    #[serde(default)]
    pub versions: Vec<StoredVersion>,
    #[serde(default)]
    pub attachments: Vec<StoredAttachment>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl StoredVault {
    pub fn to_proto(&self) -> Vault {
        Vault {
            id: self.id,
            kind: self.kind,
            name_enc: self.name_enc.clone(),
            // Un coffre local n'a qu'un utilisateur, propriétaire de tout.
            role: Role::Owner,
            wrapped_vault_key: self.wrapped_vault_key.clone(),
            revision: self.revision,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    pub fn manifest_proto(&self) -> Option<VaultManifest> {
        self.manifest.as_ref().map(|ciphertext| VaultManifest {
            ciphertext: ciphertext.clone(),
            revision: self.manifest_revision,
        })
    }

    pub fn item(&self, id: Uuid) -> Option<&StoredItem> {
        self.items.iter().find(|i| i.id == id)
    }

    pub fn live_item(&self, id: Uuid) -> Option<&StoredItem> {
        self.item(id).filter(|i| i.deleted_at.is_none())
    }

    pub fn attachment(&self, id: Uuid) -> Result<&StoredAttachment> {
        self.attachments
            .iter()
            .find(|a| a.id == id)
            .ok_or_else(|| Error::not_found("attachment"))
    }

    /// Avance la révision du vault et la rend (`db::bump_revision`).
    pub fn bump(&mut self, now: DateTime<Utc>) -> i64 {
        self.revision += 1;
        self.updated_at = now;
        self.revision
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoredItem {
    pub id: Uuid,
    pub item_type: String,
    pub revision: i64,
    /// Vide pour une pierre tombale.
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<DateTime<Utc>>,
}

impl StoredItem {
    pub fn to_proto(&self, vault_id: Uuid) -> Item {
        Item {
            id: self.id,
            vault_id,
            item_type: self.item_type.clone(),
            revision: self.revision,
            ciphertext: self.ciphertext.clone(),
            deleted: self.deleted_at.is_some(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoredVersion {
    pub item_id: Uuid,
    pub revision: i64,
    pub item_type: String,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
    pub written_at: DateTime<Utc>,
    pub replaced_at: DateTime<Utc>,
}

impl StoredVersion {
    pub fn to_proto(&self) -> ItemVersion {
        ItemVersion {
            item_id: self.item_id,
            revision: self.revision,
            item_type: self.item_type.clone(),
            ciphertext: self.ciphertext.clone(),
            written_at: self.written_at,
            replaced_at: self.replaced_at,
            // Personne d'autre que soi n'écrit dans un coffre local.
            replaced_by: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoredAttachment {
    pub id: Uuid,
    pub item_id: Uuid,
    /// Taille chiffrée totale, en octets.
    pub size: i64,
    pub chunks: i32,
    pub complete: bool,
    pub created_at: DateTime<Utc>,
}

impl StoredAttachment {
    pub fn to_proto(&self, vault_id: Uuid) -> Attachment {
        Attachment {
            id: self.id,
            vault_id,
            item_id: self.item_id,
            size: self.size,
            chunks: self.chunks,
            complete: self.complete,
            created_at: self.created_at,
        }
    }
}

// ─── Sur le disque ──────────────────────────────────────────────────────────

pub(crate) fn coffre_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

pub(crate) fn attachments_dir(dir: &Path, vault_id: Uuid) -> PathBuf {
    dir.join(ATTACHMENTS_DIR).join(vault_id.to_string())
}

pub(crate) fn attachment_dir(dir: &Path, vault_id: Uuid, id: Uuid) -> PathBuf {
    attachments_dir(dir, vault_id).join(id.to_string())
}

pub(crate) fn chunk_path(dir: &Path, vault_id: Uuid, id: Uuid, index: i32) -> PathBuf {
    attachment_dir(dir, vault_id, id).join(format!("{index}.bin"))
}

/// Le verrou du coffre, tenu le temps d'une opération : partagé pour lire,
/// exclusif pour écrire. Entre processus (l'app, `gv`, plus tard Guiterm)
/// comme entre fils d'un même processus — chaque opération ouvre son propre
/// descripteur. Relâché à la fermeture du fichier.
pub(crate) struct Lock(#[allow(dead_code)] File);

pub(crate) fn lock(dir: &Path, exclusive: bool) -> Result<Lock> {
    let path = dir.join(LOCK_NAME);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| Error::io(format!("verrou {}", path.display()), e))?;
    let res = if exclusive { file.lock() } else { file.lock_shared() };
    res.map_err(|e| Error::io(format!("verrou {}", path.display()), e))?;
    Ok(Lock(file))
}

pub(crate) fn read(dir: &Path) -> Result<Coffre> {
    let path = coffre_path(dir);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::new(
                404,
                "local_not_found",
                format!("aucun coffre dans {}", dir.display()),
            ));
        }
        Err(e) => return Err(Error::io(format!("lecture de {}", path.display()), e)),
    };
    // Le format d'abord, sans tout désérialiser : un coffre plus récent peut
    // avoir changé n'importe quel autre champ.
    let format = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.get("format").and_then(|f| f.as_u64()));
    match format {
        Some(f) if f > u64::from(FORMAT) => {
            return Err(Error::new(
                409,
                "local_format_unsupported",
                format!("ce coffre est au format {f}, cette version sait lire jusqu'au {FORMAT} : mettre l'app à jour"),
            ));
        }
        Some(_) => {}
        None => return Err(corrupt(&path, "format absent")),
    }
    serde_json::from_slice(&bytes).map_err(|e| corrupt(&path, e))
}

fn corrupt(path: &Path, why: impl std::fmt::Display) -> Error {
    Error::new(500, "local_corrupt", format!("{} illisible : {why}", path.display()))
}

/// Écrit à côté puis renomme : une écriture interrompue laisse l'ancien
/// fichier intact. `0600` avant d'y mettre quoi que ce soit.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let io = |e| Error::io(format!("écriture de {}", path.display()), e);
    let mut f = opts.open(&tmp).map_err(io)?;
    f.write_all(bytes).map_err(io)?;
    f.sync_all().map_err(io)?;
    drop(f);
    fs::rename(&tmp, path).map_err(io)?;
    // Le renommage lui-même doit survivre à une coupure.
    #[cfg(unix)]
    if let Some(parent) = path.parent()
        && let Ok(d) = File::open(parent)
    {
        let _ = d.sync_all();
    }
    Ok(())
}

pub(crate) fn save(dir: &Path, coffre: &Coffre) -> Result<()> {
    let bytes = serde_json::to_vec(coffre).map_err(|e| Error::new(500, "local_io", e.to_string()))?;
    write_atomic(&coffre_path(dir), &bytes)
}

/// Crée un dossier `0700` (et ses parents).
pub(crate) fn ensure_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| Error::io(format!("création de {}", dir.display()), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}
