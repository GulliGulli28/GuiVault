//! Le coffre local de GuiVault (`docs/APP.md`) : un dossier qui garde
//! **exactement ce que garde le serveur** — le compte enveloppé, les vaults
//! (nom chiffré, clé enveloppée, révision, manifeste), les items chiffrés,
//! leur historique, la corbeille et les pièces jointes. Seul le transport
//! change : un dossier au lieu de HTTP.
//!
//! Comme le serveur, ce crate **ne chiffre ni ne déchiffre rien et ne possède
//! aucune clé** : la crypto reste chez les clients (`guivault-crypto`,
//! `web/src/lib/crypto.ts`), qui lisent et écrivent ici les mêmes blobs
//! qu'ils enverraient au serveur. D'où les mêmes requêtes et réponses
//! (`guivault-protocol`), les mêmes règles (verrou optimiste par révision,
//! manifeste obligatoire une fois créé, historique, corbeille) et les mêmes
//! codes d'erreur ([`Error`]).
//!
//! Ce qui n'a pas de sens sans serveur n'existe pas ici : membres,
//! invitations, accès d'urgence, liens de partage, sessions, second facteur,
//! quotas, rotation de clé (elle sert à évincer un membre parti).
//!
//! ```text
//! Mon coffre.guivault/
//!   coffre.json                       tout, sauf les pièces jointes
//!   attachments/<vault>/<id>/<n>.bin  morceaux chiffrés
//!   backups/coffre-<date>.json        sauvegardes (`backup.rs`)
//!   .lock                             verrou partagé (lire) / exclusif (écrire)
//! ```
mod backup;
mod error;
mod format;
pub mod rpc;
mod validate;

pub use backup::{BackupInfo, backups, restore_backup};
pub use error::{Error, Result};
pub use format::{FILE_NAME, FORMAT, LocalAccount};

use chrono::{DateTime, Duration, Utc};
use format::{Coffre, StoredAttachment, StoredItem, StoredVault, StoredVersion};
use guivault_crypto::{ATTACHMENT_CHUNK, ATTACHMENT_CHUNK_OVERHEAD, RekeyMaterial, attachment_chunk_count};
use guivault_protocol::{
    Attachment, CreateAttachmentRequest, CreateVaultRequest, DeleteItemRequest, IMPORT_BATCH, ImportItemsRequest,
    ImportItemsResponse, Item, ItemVersion, ItemsPage, KdfParams, ManifestWrite, MoveAttachmentRequest, PutItemRequest,
    PutManifestRequest, PutUserSettingsRequest, RenameVaultRequest, TrashedItem, UserProfile, UserSettings, Vault,
    VaultKind, VaultManifest,
};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Les réglages de rétention et de taille. Les valeurs par défaut sont celles
/// du serveur : un coffre local doit pouvoir être poussé vers un compte sans
/// qu'un item y soit refusé.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Versions précédentes gardées par item (`GUIVAULT_ITEM_HISTORY`).
    pub item_history: usize,
    /// Jours dans la corbeille (`GUIVAULT_TRASH_DAYS`).
    pub trash_days: u32,
    pub max_item_bytes: usize,
    pub max_attachment_bytes: u64,
    /// Sauvegardes de `coffre.json` gardées (`backup.rs`) ; 0 : aucune.
    pub backups: usize,
    /// Une sauvegarde avant une écriture si la dernière est plus vieille.
    pub backup_interval: std::time::Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            item_history: 20,
            trash_days: 30,
            max_item_bytes: 1024 * 1024,
            max_attachment_bytes: 100 * 1024 * 1024,
            backups: 10,
            backup_interval: std::time::Duration::from_secs(3600),
        }
    }
}

/// Ce que le client prépare pour créer un coffre : le compte
/// (`create_account`, sans la clé d'auth) et le vault personnel (id, nom
/// chiffré, clé enveloppée pour soi-même).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct NewCoffre {
    pub account: LocalAccount,
    pub personal: CreateVaultRequest,
}

/// Un nouveau mot de passe maître : seule l'enveloppe de la user key change
/// (`rekey_account`).
#[derive(Debug, Clone)]
pub struct PasswordChange {
    pub kdf: KdfParams,
    pub kdf_salt: Vec<u8>,
    pub protected_user_key: Vec<u8>,
}

impl From<&RekeyMaterial> for PasswordChange {
    fn from(r: &RekeyMaterial) -> Self {
        Self {
            kdf: r.kdf,
            kdf_salt: r.kdf_salt.clone(),
            protected_user_key: r.protected_user_key.clone(),
        }
    }
}

/// Un coffre local ouvert. Ne garde que son chemin : chaque opération relit
/// le fichier sous verrou, si bien que plusieurs processus (l'app, `gv`)
/// peuvent travailler sur le même coffre — le second écrivain reçoit un
/// `revision_mismatch`, comme avec le serveur.
#[derive(Debug, Clone)]
pub struct LocalVault {
    dir: PathBuf,
    options: Options,
}

/// Ce qu'une écriture fait sur le disque en dehors de `coffre.json`.
#[derive(Default)]
struct Effects {
    /// Dossiers de pièces jointes à effacer une fois l'écriture validée.
    remove_after: Vec<PathBuf>,
    /// Renommages déjà faits, à défaire si l'écriture échoue.
    undo: Vec<(PathBuf, PathBuf)>,
}

impl LocalVault {
    /// Crée un coffre dans `dir` (créé s'il n'existe pas). Refusé s'il y en a
    /// déjà un (`local_exists`).
    pub fn create(dir: impl Into<PathBuf>, new: NewCoffre) -> Result<Self> {
        Self::create_with(dir, new, Options::default())
    }

    pub fn create_with(dir: impl Into<PathBuf>, new: NewCoffre, options: Options) -> Result<Self> {
        let dir = dir.into();
        let a = &new.account;
        validate::kdf(&a.kdf, &a.kdf_salt)?;
        validate::key_blob("user key", &a.protected_user_key)?;
        validate::public_key(&a.public_key)?;
        validate::key_blob("clé privée", &a.protected_private_key)?;
        validate::name_enc(&new.personal.name_enc)?;
        validate::wrapped_vault_key(&new.personal.wrapped_vault_key)?;

        format::ensure_dir(&dir)?;
        let _lock = format::lock(&dir, true)?;
        if format::coffre_path(&dir).exists() {
            return Err(Error::conflict(
                "local_exists",
                format!("il y a déjà un coffre dans {}", dir.display()),
            ));
        }
        let now = Utc::now();
        let coffre = Coffre {
            format: FORMAT,
            id: Uuid::new_v4(),
            created_at: now,
            account: new.account,
            settings: None,
            vaults: vec![new_vault(new.personal, VaultKind::Personal, now)],
            extra: Default::default(),
        };
        format::save(&dir, &coffre)?;
        Ok(Self { dir, options })
    }

    /// Ouvre le coffre de `dir` : vérifie qu'il est là et lisible par cette
    /// version. Ne demande pas le mot de passe — il ne sert qu'au client,
    /// pour ouvrir la user key (`account`).
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self> {
        Self::open_with(dir, Options::default())
    }

    pub fn open_with(dir: impl Into<PathBuf>, options: Options) -> Result<Self> {
        let vault = Self {
            dir: dir.into(),
            options,
        };
        vault.read(|_| Ok(()))?;
        Ok(vault)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn options(&self) -> Options {
        self.options
    }

    /// L'identifiant du coffre, fixé à sa création.
    pub fn id(&self) -> Result<Uuid> {
        self.read(|c| Ok(c.id))
    }

    /// Le « compte » tel que l'interface l'attend de `/users/me` : l'id du
    /// coffre, sa clé publique, sa date de création. Pas d'e-mail — un coffre
    /// local n'en a pas.
    pub fn profile(&self) -> Result<UserProfile> {
        self.read(|c| {
            Ok(UserProfile {
                id: c.id,
                email: String::new(),
                public_key: c.account.public_key.clone(),
                created_at: c.created_at,
                is_admin: false,
            })
        })
    }

    /// De quoi déverrouiller : paramètres Argon2id, sel, enveloppes. Le client
    /// vérifie `KdfParams::is_sane` avant de dériver, comme au prelogin.
    pub fn account(&self) -> Result<LocalAccount> {
        self.read(|c| Ok(c.account.clone()))
    }

    pub fn change_password(&self, change: PasswordChange) -> Result<()> {
        validate::kdf(&change.kdf, &change.kdf_salt)?;
        validate::key_blob("user key", &change.protected_user_key)?;
        self.write(|c, _, _| {
            c.account.kdf = change.kdf;
            c.account.kdf_salt = change.kdf_salt;
            c.account.protected_user_key = change.protected_user_key;
            Ok(())
        })
    }

    // ─── Réglages synchronisés ──────────────────────────────────────────────

    pub fn settings(&self) -> Result<Option<UserSettings>> {
        self.read(|c| Ok(c.settings.clone()))
    }

    pub fn put_settings(&self, req: PutUserSettingsRequest) -> Result<UserSettings> {
        validate::settings_blob(&req.blob)?;
        self.write(|c, _, now| {
            if c.settings.as_ref().map(|s| s.revision) != req.base_revision {
                return Err(Error::conflict(
                    "revision_mismatch",
                    "les réglages ont été modifiés depuis votre dernière lecture",
                )
                .with_extra(serde_json::json!({ "current": c.settings })));
            }
            let settings = UserSettings {
                blob: req.blob,
                revision: c.settings.as_ref().map_or(1, |s| s.revision + 1),
                updated_at: now,
            };
            c.settings = Some(settings.clone());
            Ok(settings)
        })
    }

    // ─── Vaults ─────────────────────────────────────────────────────────────

    pub fn vaults(&self) -> Result<Vec<Vault>> {
        self.read(|c| Ok(c.vaults.iter().map(StoredVault::to_proto).collect()))
    }

    pub fn vault(&self, id: Uuid) -> Result<Vault> {
        self.read(|c| Ok(c.vault(id)?.to_proto()))
    }

    pub fn create_vault(&self, req: CreateVaultRequest) -> Result<Vault> {
        validate::name_enc(&req.name_enc)?;
        validate::wrapped_vault_key(&req.wrapped_vault_key)?;
        self.write(|c, _, now| {
            if c.vaults.iter().any(|v| v.id == req.id) {
                return Err(Error::conflict(
                    "vault_id_taken",
                    "cet identifiant de vault existe déjà",
                ));
            }
            let vault = new_vault(req, VaultKind::Shared, now);
            let proto = vault.to_proto();
            c.vaults.push(vault);
            Ok(proto)
        })
    }

    pub fn rename_vault(&self, id: Uuid, req: RenameVaultRequest) -> Result<Vault> {
        validate::name_enc(&req.name_enc)?;
        self.write(|c, _, now| {
            let v = c.vault_mut(id)?;
            v.name_enc = req.name_enc;
            v.updated_at = now;
            Ok(v.to_proto())
        })
    }

    /// Suppression définitive, pièces jointes comprises. Le vault personnel
    /// ne se supprime pas.
    pub fn delete_vault(&self, id: Uuid) -> Result<()> {
        let dir = self.dir.clone();
        self.write(|c, fx, _| {
            if c.vault(id)?.kind == VaultKind::Personal {
                return Err(Error::forbidden("le vault personnel ne peut pas être supprimé"));
            }
            c.vaults.retain(|v| v.id != id);
            fx.remove_after.push(format::attachments_dir(&dir, id));
            Ok(())
        })
    }

    // ─── Items ──────────────────────────────────────────────────────────────

    /// Les items d'un vault. `since` : seulement ceux modifiés après cette
    /// révision, pierres tombales comprises ; sinon tous les vivants.
    pub fn items(&self, vault_id: Uuid, since: Option<i64>) -> Result<ItemsPage> {
        self.read(|c| {
            let v = c.vault(vault_id)?;
            let mut items: Vec<&StoredItem> = v
                .items
                .iter()
                .filter(|i| match since {
                    Some(since) => i.revision > since,
                    None => i.deleted_at.is_none(),
                })
                .collect();
            items.sort_by_key(|i| i.revision);
            Ok(ItemsPage {
                items: items.into_iter().map(|i| i.to_proto(vault_id)).collect(),
                revision: v.revision,
                manifest: v.manifest_proto(),
            })
        })
    }

    pub fn item(&self, vault_id: Uuid, item_id: Uuid) -> Result<Item> {
        self.read(|c| {
            c.vault(vault_id)?
                .live_item(item_id)
                .map(|i| i.to_proto(vault_id))
                .ok_or_else(|| Error::not_found("item"))
        })
    }

    /// Création ou mise à jour, avec les règles de `PUT /vaults/{id}/items/{item}` :
    /// `base_revision` doit être la révision courante (`None` = l'item ne doit
    /// pas exister), sinon `revision_mismatch` avec l'item courant ; le type
    /// ne change pas ; la version remplacée va dans l'historique. Rend l'item
    /// écrit, et `true` s'il vient d'être créé.
    pub fn put_item(&self, vault_id: Uuid, item_id: Uuid, req: PutItemRequest) -> Result<(Item, bool)> {
        validate::item(&req.item_type, &req.ciphertext, self.options.max_item_bytes)?;
        let opts = self.options;
        self.write(|c, _, now| {
            let v = c.vault_mut(vault_id)?;
            let manifest = next_manifest(v, req.manifest.as_ref(), opts.max_item_bytes)?;
            let current = v.item(item_id).cloned();
            let live = current.as_ref().filter(|i| i.deleted_at.is_none());
            if live.map(|i| i.revision) != req.base_revision {
                return Err(Error::conflict(
                    "revision_mismatch",
                    "l'item a été modifié depuis votre dernière lecture",
                )
                .with_extra(serde_json::json!({ "current": current.map(|i| i.to_proto(vault_id)) })));
            }
            if let Some(l) = live
                && l.item_type != req.item_type
            {
                // Le type est dans l'AAD : en changer sans re-chiffrer
                // casserait le déchiffrement.
                return Err(Error::bad_request(
                    "item_type_changed",
                    "le type d'un item ne peut pas changer",
                ));
            }
            let created = live.is_none();
            if let Some(l) = live {
                keep_version(v, l, now, opts.item_history);
            }
            let rev = v.bump(now);
            let item = StoredItem {
                id: item_id,
                item_type: req.item_type,
                revision: rev,
                ciphertext: req.ciphertext,
                created_at: current.as_ref().map_or(now, |i| i.created_at),
                updated_at: now,
                deleted_at: None,
            };
            let proto = item.to_proto(vault_id);
            match v.items.iter_mut().find(|i| i.id == item_id) {
                Some(slot) => *slot = item,
                None => v.items.push(item),
            }
            store_manifest(v, manifest);
            Ok((proto, created))
        })
    }

    /// Suppression = pierre tombale ; la dernière version va dans la
    /// corbeille, sauf pour un déplacement vers un autre vault (`moved`).
    pub fn delete_item(&self, vault_id: Uuid, item_id: Uuid, moved: bool, req: DeleteItemRequest) -> Result<()> {
        let opts = self.options;
        self.write(|c, _, now| {
            let v = c.vault_mut(vault_id)?;
            let current = v.live_item(item_id).cloned().ok_or_else(|| Error::not_found("item"))?;
            let manifest = next_manifest(v, req.manifest.as_ref(), opts.max_item_bytes)?;
            store_manifest(v, manifest);
            if !moved {
                keep_version(v, &current, now, opts.item_history);
            }
            let rev = v.bump(now);
            if let Some(i) = v.items.iter_mut().find(|i| i.id == item_id) {
                i.deleted_at = Some(now);
                i.updated_at = now;
                i.revision = rev;
                i.ciphertext.clear();
            }
            Ok(())
        })
    }

    /// Copie d'un vault venu d'ailleurs, avec ses dates — les règles de
    /// `POST /vaults/{id}/import` : seulement des ids que le vault n'a jamais
    /// eus, au plus `GUIVAULT_ITEM_HISTORY` versions par item, et plus
    /// d'import une fois que le vault a un manifeste (celui de la source
    /// arrive avec le dernier lot).
    pub fn import_items(&self, vault_id: Uuid, req: ImportItemsRequest) -> Result<ImportItemsResponse> {
        let opts = self.options;
        if req.items.len() > IMPORT_BATCH {
            return Err(Error::bad_request(
                "import_too_large",
                format!("au plus {IMPORT_BATCH} items par lot"),
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for it in &req.items {
            if !ids.insert(it.id) {
                return Err(Error::bad_request(
                    "invalid_import",
                    "un item apparaît deux fois dans le lot",
                ));
            }
            if it.deleted_at.is_some() {
                let Some(last) = it.versions.last() else {
                    return Err(Error::bad_request(
                        "invalid_import",
                        "un item de la corbeille sans version",
                    ));
                };
                if !it.ciphertext.is_empty() || last.item_type != it.item_type {
                    return Err(Error::bad_request("invalid_import", "item de la corbeille incohérent"));
                }
            } else {
                validate::item(&it.item_type, &it.ciphertext, opts.max_item_bytes)?;
            }
            for v in &it.versions {
                validate::item(&v.item_type, &v.ciphertext, opts.max_item_bytes)?;
            }
        }
        if let Some(m) = &req.manifest {
            validate::manifest(&m.ciphertext, opts.max_item_bytes)?;
            if m.revision < 1 {
                return Err(Error::bad_request("invalid_manifest", "révision de manifeste invalide"));
            }
        }
        self.write(|c, _, now| {
            let v = c.vault_mut(vault_id)?;
            if v.manifest.is_some() {
                return Err(Error::conflict(
                    "import_closed",
                    "ce vault a un manifeste : on n'y importe plus",
                ));
            }
            let existing: Vec<Uuid> = req
                .items
                .iter()
                .map(|it| it.id)
                .filter(|id| v.item(*id).is_some())
                .collect();
            if !existing.is_empty() {
                return Err(
                    Error::conflict("item_exists", "des items du lot existent déjà dans ce vault")
                        .with_extra(serde_json::json!({ "items": existing })),
                );
            }
            let keep = opts.item_history;
            let mut imported = 0;
            for it in req.items {
                if it.deleted_at.is_some() && keep == 0 {
                    continue;
                }
                let skip = it.versions.len().saturating_sub(keep);
                for ver in it.versions.into_iter().skip(skip) {
                    let revision = v.bump(now);
                    v.versions.push(StoredVersion {
                        item_id: it.id,
                        revision,
                        item_type: ver.item_type,
                        ciphertext: ver.ciphertext,
                        written_at: ver.written_at,
                        replaced_at: ver.replaced_at,
                    });
                }
                let revision = v.bump(now);
                v.items.push(StoredItem {
                    id: it.id,
                    item_type: it.item_type,
                    revision,
                    ciphertext: it.ciphertext,
                    created_at: it.created_at,
                    updated_at: it.updated_at,
                    deleted_at: it.deleted_at,
                });
                imported += 1;
            }
            store_manifest(v, req.manifest.map(|m| (m.ciphertext, m.revision)));
            Ok(ImportItemsResponse {
                revision: v.revision,
                imported,
            })
        })
    }

    // ─── Manifeste ──────────────────────────────────────────────────────────

    pub fn manifest(&self, vault_id: Uuid) -> Result<Option<VaultManifest>> {
        self.read(|c| Ok(c.vault(vault_id)?.manifest_proto()))
    }

    /// Crée le manifeste d'un vault qui n'en a pas, ou le réécrit (prise
    /// d'acte après un écart) — `PUT /vaults/{id}/manifest`.
    pub fn put_manifest(&self, vault_id: Uuid, req: PutManifestRequest) -> Result<VaultManifest> {
        validate::manifest(&req.ciphertext, self.options.max_item_bytes)?;
        self.write(|c, _, now| {
            let v = c.vault_mut(vault_id)?;
            if v.revision != req.vault_revision {
                return Err(Error::conflict(
                    "revision_mismatch",
                    "le vault a changé depuis votre lecture : relire, puis recommencer",
                )
                .with_extra(serde_json::json!({ "current": v.revision })));
            }
            if req.base_revision != v.manifest_revision {
                return Err(manifest_conflict(v));
            }
            let next = v.manifest_revision + 1;
            store_manifest(v, Some((req.ciphertext.clone(), next)));
            v.bump(now);
            Ok(VaultManifest {
                ciphertext: req.ciphertext,
                revision: next,
            })
        })
    }

    // ─── Historique et corbeille ────────────────────────────────────────────

    /// L'historique d'un item, du plus récent au plus ancien.
    pub fn item_versions(&self, vault_id: Uuid, item_id: Uuid) -> Result<Vec<ItemVersion>> {
        self.read(|c| {
            let mut versions: Vec<&StoredVersion> = c
                .vault(vault_id)?
                .versions
                .iter()
                .filter(|v| v.item_id == item_id)
                .collect();
            versions.sort_by_key(|v| std::cmp::Reverse(v.revision));
            Ok(versions.into_iter().map(StoredVersion::to_proto).collect())
        })
    }

    /// Toutes les versions d'un vault, par item puis par révision.
    pub fn vault_versions(&self, vault_id: Uuid) -> Result<Vec<ItemVersion>> {
        self.read(|c| {
            let mut versions: Vec<&StoredVersion> = c.vault(vault_id)?.versions.iter().collect();
            versions.sort_by_key(|v| (v.item_id, v.revision));
            Ok(versions.into_iter().map(StoredVersion::to_proto).collect())
        })
    }

    /// La corbeille : les items supprimés depuis moins de `trash_days` jours
    /// (et pas recréés), chacun avec sa dernière version, le plus récent
    /// d'abord.
    pub fn trash(&self, vault_id: Uuid) -> Result<Vec<TrashedItem>> {
        let limit = Utc::now() - Duration::days(i64::from(self.options.trash_days));
        let days = Duration::days(i64::from(self.options.trash_days));
        self.read(|c| {
            let v = c.vault(vault_id)?;
            let mut trash: Vec<TrashedItem> = v
                .items
                .iter()
                .filter_map(|i| {
                    let deleted_at = i.deleted_at.filter(|d| *d > limit)?;
                    let last = v
                        .versions
                        .iter()
                        .filter(|ver| ver.item_id == i.id)
                        .max_by_key(|ver| ver.revision)?;
                    Some(TrashedItem {
                        item_id: i.id,
                        item_type: last.item_type.clone(),
                        revision: last.revision,
                        ciphertext: last.ciphertext.clone(),
                        deleted_at,
                        deleted_by: None,
                        expires_at: deleted_at + days,
                    })
                })
                .collect();
            trash.sort_by_key(|t| std::cmp::Reverse(t.deleted_at));
            Ok(trash)
        })
    }

    /// Supprime définitivement un item de la corbeille (ses versions et ses
    /// pièces jointes). Un item vivant n'y est pas : `not_found`.
    pub fn purge(&self, vault_id: Uuid, item_id: Uuid) -> Result<()> {
        let dir = self.dir.clone();
        self.write(|c, fx, _| {
            let v = c.vault_mut(vault_id)?;
            let deleted = v.item(item_id).is_some_and(|i| i.deleted_at.is_some());
            let before = v.versions.len();
            if deleted {
                v.versions.retain(|ver| ver.item_id != item_id);
            }
            if v.versions.len() == before {
                return Err(Error::not_found("item"));
            }
            drop_attachments(v, &dir, fx, |a| a.item_id == item_id);
            Ok(())
        })
    }

    /// Vide la corbeille du vault.
    pub fn empty_trash(&self, vault_id: Uuid) -> Result<()> {
        let dir = self.dir.clone();
        self.write(|c, fx, _| {
            let v = c.vault_mut(vault_id)?;
            let deleted: std::collections::HashSet<Uuid> = v
                .items
                .iter()
                .filter(|i| i.deleted_at.is_some())
                .map(|i| i.id)
                .collect();
            v.versions.retain(|ver| !deleted.contains(&ver.item_id));
            drop_attachments(v, &dir, fx, |a| deleted.contains(&a.item_id));
            Ok(())
        })
    }

    // ─── Pièces jointes ─────────────────────────────────────────────────────

    /// Les pièces jointes d'un vault, ou d'un de ses items.
    pub fn attachments(&self, vault_id: Uuid, item_id: Option<Uuid>) -> Result<Vec<Attachment>> {
        self.read(|c| {
            Ok(c.vault(vault_id)?
                .attachments
                .iter()
                .filter(|a| item_id.is_none_or(|i| a.item_id == i))
                .map(|a| a.to_proto(vault_id))
                .collect())
        })
    }

    /// Annoncer une pièce jointe avant d'en écrire les morceaux.
    pub fn create_attachment(&self, vault_id: Uuid, req: CreateAttachmentRequest) -> Result<Attachment> {
        let max = self.options.max_attachment_bytes;
        if req.size < 0 || req.size as u64 > max {
            return Err(Error::new(
                413,
                "attachment_too_large",
                format!("une pièce jointe ne peut dépasser {} Mio", max / (1024 * 1024)),
            ));
        }
        let overhead = i64::from(req.chunks) * ATTACHMENT_CHUNK_OVERHEAD as i64;
        let plain = req.size - overhead;
        if req.chunks < 1 || plain < 0 || attachment_chunk_count(plain as u64) as i64 != i64::from(req.chunks) {
            return Err(Error::bad_request(
                "invalid_attachment",
                "taille et nombre de morceaux incohérents",
            ));
        }
        self.write(|c, _, now| {
            let v = c.vault_mut(vault_id)?;
            v.live_item(req.item_id).ok_or_else(|| Error::not_found("item"))?;
            if v.attachments.iter().any(|a| a.id == req.id) {
                return Err(Error::conflict("attachment_exists", "cette pièce jointe existe déjà"));
            }
            let a = StoredAttachment {
                id: req.id,
                item_id: req.item_id,
                size: req.size,
                chunks: req.chunks,
                complete: false,
                created_at: now,
            };
            let proto = a.to_proto(vault_id);
            v.attachments.push(a);
            Ok(proto)
        })
    }

    /// Un morceau. Le réécrire le remplace (reprise), tant que la pièce
    /// jointe n'est pas terminée.
    pub fn put_chunk(&self, vault_id: Uuid, id: Uuid, index: i32, bytes: &[u8]) -> Result<()> {
        let _lock = format::lock(&self.dir, true)?;
        let c = format::read(&self.dir)?;
        let a = c.vault(vault_id)?.attachment(id)?;
        if a.complete {
            return Err(Error::conflict(
                "attachment_complete",
                "cette pièce jointe est déjà complète",
            ));
        }
        if index < 0 || index >= a.chunks {
            return Err(Error::bad_request(
                "invalid_attachment",
                "morceau hors de la pièce jointe",
            ));
        }
        if bytes.len() < ATTACHMENT_CHUNK_OVERHEAD || bytes.len() > ATTACHMENT_CHUNK + ATTACHMENT_CHUNK_OVERHEAD {
            return Err(Error::bad_request("invalid_attachment", "taille de morceau invalide"));
        }
        format::ensure_dir(&format::attachment_dir(&self.dir, vault_id, id))?;
        format::write_atomic(&format::chunk_path(&self.dir, vault_id, id, index), bytes)
    }

    /// Tous les morceaux sont là, et leur taille totale est celle annoncée.
    pub fn complete_attachment(&self, vault_id: Uuid, id: Uuid) -> Result<Attachment> {
        let dir = self.dir.clone();
        self.write(|c, _, _| {
            let v = c.vault_mut(vault_id)?;
            let a = v.attachment(id)?;
            let (mut count, mut bytes) = (0i64, 0i64);
            for index in 0..a.chunks {
                if let Ok(m) = fs::metadata(format::chunk_path(&dir, vault_id, id, index)) {
                    count += 1;
                    bytes += m.len() as i64;
                }
            }
            if count != i64::from(a.chunks) || bytes != a.size {
                return Err(Error::conflict(
                    "attachment_incomplete",
                    format!("{count} morceau(x) sur {} reçus", a.chunks),
                ));
            }
            let a = v
                .attachments
                .iter_mut()
                .find(|a| a.id == id)
                .expect("trouvée juste au-dessus");
            a.complete = true;
            Ok(a.to_proto(vault_id))
        })
    }

    /// Les octets d'un morceau d'une pièce jointe complète.
    pub fn chunk(&self, vault_id: Uuid, id: Uuid, index: i32) -> Result<Vec<u8>> {
        self.read(|c| {
            if !c.vault(vault_id)?.attachment(id)?.complete {
                return Err(Error::not_found("attachment"));
            }
            let path = format::chunk_path(&self.dir, vault_id, id, index);
            match fs::read(&path) {
                Ok(b) => Ok(b),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(Error::not_found("chunk")),
                Err(e) => Err(Error::io(format!("lecture de {}", path.display()), e)),
            }
        })
    }

    pub fn delete_attachment(&self, vault_id: Uuid, id: Uuid) -> Result<()> {
        let dir = self.dir.clone();
        self.write(|c, fx, _| {
            let v = c.vault_mut(vault_id)?;
            v.attachment(id)?;
            drop_attachments(v, &dir, fx, |a| a.id == id);
            Ok(())
        })
    }

    /// Suivre un item déplacé vers un autre vault (même id), déjà arrivé de
    /// l'autre côté. Rien n'est re-chiffré : la clé voyage dans l'item.
    pub fn move_attachment(&self, vault_id: Uuid, id: Uuid, req: MoveAttachmentRequest) -> Result<Attachment> {
        let dir = self.dir.clone();
        self.write(|c, fx, _| {
            let a = c.vault(vault_id)?.attachment(id)?.clone();
            let target = c.vault_mut(req.vault_id)?;
            target.live_item(req.item_id).ok_or_else(|| Error::not_found("item"))?;
            if req.vault_id == vault_id {
                let a = target
                    .attachments
                    .iter_mut()
                    .find(|x| x.id == id)
                    .expect("même vault, trouvée juste au-dessus");
                a.item_id = req.item_id;
                return Ok(a.to_proto(vault_id));
            }
            if target.attachments.iter().any(|x| x.id == id) {
                return Err(Error::conflict(
                    "attachment_exists",
                    "cette pièce jointe existe déjà dans le vault de destination",
                ));
            }
            let moved = StoredAttachment {
                item_id: req.item_id,
                ..a
            };
            let proto = moved.to_proto(req.vault_id);
            target.attachments.push(moved);
            c.vault_mut(vault_id)?.attachments.retain(|x| x.id != id);
            // Les morceaux suivent, avant l'écriture du coffre (défait si
            // elle échoue) : jamais une fiche qui pointe sur un dossier vide.
            let from = format::attachment_dir(&dir, vault_id, id);
            if from.exists() {
                let to = format::attachment_dir(&dir, req.vault_id, id);
                format::ensure_dir(&format::attachments_dir(&dir, req.vault_id))?;
                fs::rename(&from, &to).map_err(|e| Error::io(format!("déplacement de {}", from.display()), e))?;
                fx.undo.push((to, from));
            }
            Ok(proto)
        })
    }

    // ─── Transactions ───────────────────────────────────────────────────────

    fn read<T>(&self, f: impl FnOnce(&Coffre) -> Result<T>) -> Result<T> {
        let _lock = format::lock(&self.dir, false)?;
        f(&format::read(&self.dir)?)
    }

    /// Une écriture : sous le verrou exclusif, relire, appliquer `f`, faire le
    /// ménage de rétention, réécrire le fichier d'un coup. Si `f` échoue, rien
    /// n'est écrit.
    fn write<T>(&self, f: impl FnOnce(&mut Coffre, &mut Effects, DateTime<Utc>) -> Result<T>) -> Result<T> {
        let _lock = format::lock(&self.dir, true)?;
        let mut coffre = format::read(&self.dir)?;
        let now = Utc::now();
        let mut fx = Effects::default();
        let res = f(&mut coffre, &mut fx, now).and_then(|out| {
            prune(&mut coffre, &self.dir, &mut fx, now, self.options);
            // Le coffre tel qu'il était, avant de le réécrire.
            backup::maybe_backup(&self.dir, now, self.options.backup_interval, self.options.backups);
            format::save(&self.dir, &coffre)?;
            Ok(out)
        });
        match res {
            Ok(out) => {
                // Après coup et sans échec possible : au pire, un dossier
                // orphelin, que plus rien ne référence.
                for path in fx.remove_after {
                    let _ = fs::remove_dir_all(path);
                }
                Ok(out)
            }
            Err(e) => {
                for (from, to) in fx.undo.into_iter().rev() {
                    let _ = fs::rename(from, to);
                }
                Err(e)
            }
        }
    }
}

fn new_vault(req: CreateVaultRequest, kind: VaultKind, now: DateTime<Utc>) -> StoredVault {
    StoredVault {
        id: req.id,
        kind,
        name_enc: req.name_enc,
        wrapped_vault_key: req.wrapped_vault_key,
        revision: 0,
        created_at: now,
        updated_at: now,
        manifest: None,
        manifest_revision: 0,
        items: Vec::new(),
        versions: Vec::new(),
        attachments: Vec::new(),
        extra: Default::default(),
    }
}

/// Le manifeste qu'une écriture d'item doit poser (`db::next_manifest`) :
/// obligatoire si le vault en a un, sur la révision courante.
fn next_manifest(v: &StoredVault, write: Option<&ManifestWrite>, max_item: usize) -> Result<Option<(Vec<u8>, i64)>> {
    let Some(write) = write else {
        if v.manifest.is_some() {
            return Err(Error::conflict(
                "manifest_required",
                "ce vault est protégé par un manifeste : mettez à jour ce client pour y écrire",
            ));
        }
        return Ok(None);
    };
    validate::manifest(&write.ciphertext, max_item)?;
    if write.base_revision != v.manifest_revision {
        return Err(manifest_conflict(v));
    }
    Ok(Some((write.ciphertext.clone(), v.manifest_revision + 1)))
}

fn manifest_conflict(v: &StoredVault) -> Error {
    Error::conflict(
        "manifest_conflict",
        "le manifeste du vault a changé depuis votre lecture",
    )
    .with_extra(serde_json::json!({ "current": v.manifest_proto() }))
}

fn store_manifest(v: &mut StoredVault, manifest: Option<(Vec<u8>, i64)>) {
    if let Some((blob, revision)) = manifest {
        v.manifest = Some(blob);
        v.manifest_revision = revision;
    }
}

/// Garde la version courante d'un item avant qu'elle soit remplacée ou
/// supprimée, puis n'en garde que les `keep` dernières (`db::keep_version`).
fn keep_version(v: &mut StoredVault, current: &StoredItem, now: DateTime<Utc>, keep: usize) {
    if keep == 0 {
        return;
    }
    if !v
        .versions
        .iter()
        .any(|ver| ver.item_id == current.id && ver.revision == current.revision)
    {
        v.versions.push(StoredVersion {
            item_id: current.id,
            revision: current.revision,
            item_type: current.item_type.clone(),
            ciphertext: current.ciphertext.clone(),
            written_at: current.updated_at,
            replaced_at: now,
        });
    }
    let mut revisions: Vec<i64> = v
        .versions
        .iter()
        .filter(|ver| ver.item_id == current.id)
        .map(|ver| ver.revision)
        .collect();
    if revisions.len() > keep {
        revisions.sort_unstable_by(|a, b| b.cmp(a));
        let oldest_kept = revisions[keep - 1];
        v.versions
            .retain(|ver| ver.item_id != current.id || ver.revision >= oldest_kept);
    }
}

/// Retire les pièces jointes choisies, et leurs morceaux une fois l'écriture
/// validée.
fn drop_attachments(v: &mut StoredVault, dir: &Path, fx: &mut Effects, which: impl Fn(&StoredAttachment) -> bool) {
    let vault_id = v.id;
    v.attachments.retain(|a| {
        if which(a) {
            fx.remove_after.push(format::attachment_dir(dir, vault_id, a.id));
            false
        } else {
            true
        }
    });
}

/// Le ménage horaire du serveur (`prune_trash`, `attachments::prune`), fait
/// ici à chaque écriture : la corbeille expirée perd ses versions ; une
/// pièce jointe de plus d'un jour part si elle est restée incomplète, ou si
/// son item n'existe plus ou a quitté la corbeille.
fn prune(c: &mut Coffre, dir: &Path, fx: &mut Effects, now: DateTime<Utc>, opts: Options) {
    let limit = now - Duration::days(i64::from(opts.trash_days));
    let day_ago = now - Duration::days(1);
    for v in &mut c.vaults {
        let expired: std::collections::HashSet<Uuid> = v
            .items
            .iter()
            .filter(|i| i.deleted_at.is_some_and(|d| d < limit))
            .map(|i| i.id)
            .collect();
        v.versions.retain(|ver| !expired.contains(&ver.item_id));
        let restorable: std::collections::HashSet<Uuid> = v
            .items
            .iter()
            .filter(|i| i.deleted_at.is_none_or(|d| d > limit))
            .map(|i| i.id)
            .collect();
        drop_attachments(v, dir, fx, |a| {
            a.created_at < day_ago && (!a.complete || !restorable.contains(&a.item_id))
        });
    }
}
