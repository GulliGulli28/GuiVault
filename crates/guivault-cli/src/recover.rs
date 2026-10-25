//! `gv recover` : tout ressortir en clair avec le seul mot de passe, sans
//! serveur ni réseau — d'un coffre local, d'une sauvegarde du serveur
//! (`guivault backup`) ou d'un export chiffré. C'est la réponse à « et si le
//! serveur, ou le projet, disparaît ? » : les formats sont décrits dans
//! `docs/FORMATS.md`, et ce module les lit sans rien d'autre que
//! `guivault-crypto`.
//!
//! Le résultat est un dossier : un export GuiVault en clair par vault
//! (`<vault>.json`, réimportable par Outils › Importer) et les pièces
//! jointes déchiffrées à côté. Rien n'est envoyé nulle part.
use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Utc};
use guivault_crypto as gc;
use guivault_protocol::{Item, KdfParams, Role, Vault, VaultKind, VaultManifest, b64};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::store::{Cache, VaultItems};
use crate::vault;

/// Ce qu'on sait ouvrir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// Un dossier de coffre local (`coffre.json`).
    Local(PathBuf),
    /// L'archive `.zip` d'un coffre local (« Exporter le coffre » de
    /// l'application Android).
    Archive(PathBuf),
    /// Une sauvegarde du serveur (`guivault-….jsonl.gz`) : il faut l'e-mail
    /// du compte.
    Backup(PathBuf),
    /// Un export JSON, chiffré par mot de passe ou en clair.
    Export(PathBuf),
}

impl Source {
    /// Reconnaît la source à son contenu, pas à son nom.
    pub fn detect(path: &Path) -> Result<Source> {
        if path.is_dir() {
            if path.join("coffre.json").is_file() {
                return Ok(Source::Local(path.into()));
            }
            bail!("{} : pas de coffre.json dans ce dossier", path.display());
        }
        if path.file_name().is_some_and(|n| n == "coffre.json") {
            return Ok(Source::Local(path.parent().unwrap_or(Path::new(".")).into()));
        }
        let mut head = [0u8; 2];
        let mut f = std::fs::File::open(path).with_context(|| format!("lecture de {}", path.display()))?;
        let n = f.read(&mut head)?;
        if n == 2 && head == [0x1f, 0x8b] {
            return Ok(Source::Backup(path.into()));
        }
        if n == 2 && head == *b"PK" {
            return Ok(Source::Archive(path.into()));
        }
        if n >= 1 && head[0] == b'{' {
            return Ok(Source::Export(path.into()));
        }
        bail!(
            "{} : ni un coffre local (dossier ou .zip), ni une sauvegarde du serveur (.jsonl.gz), ni un export JSON",
            path.display()
        )
    }

    /// Ce qu'il faut demander : le mot de passe de quoi.
    pub fn password_prompt(&self, email: Option<&str>) -> String {
        match self {
            Source::Local(_) | Source::Archive(_) => "Mot de passe maître du coffre : ".into(),
            Source::Backup(_) => format!("Mot de passe maître de {} : ", email.unwrap_or("ce compte")),
            Source::Export(_) => "Mot de passe de l'export : ".into(),
        }
    }
}

pub struct Recovered {
    pub vaults: Vec<RecoveredVault>,
    /// Ce qui ne s'est pas ouvert, et les écarts aux manifestes : la
    /// récupération continue, elle dit seulement ce qui manque.
    pub warnings: Vec<String>,
}

pub struct RecoveredVault {
    pub id: Uuid,
    pub name: String,
    /// Le JSON en clair de chaque élément (`{ "kind": …, … }`), pièces
    /// jointes comprises (leur description) ; dossiers compris.
    pub items: Vec<Value>,
    pub files: Vec<RecoveredFile>,
}

pub struct RecoveredFile {
    /// Le nom de l'élément qui la porte.
    pub item: String,
    pub name: String,
    pub data: Vec<u8>,
}

impl Recovered {
    pub fn item_count(&self) -> usize {
        self.vaults
            .iter()
            .map(|v| v.items.iter().filter(|i| i["kind"] != "group").count())
            .sum()
    }

    pub fn file_count(&self) -> usize {
        self.vaults.iter().map(|v| v.files.len()).sum()
    }
}

// ─── Le compte ──────────────────────────────────────────────────────────────

/// Le compte enveloppé, tel que le gardent le serveur et le coffre local.
struct Wrapped {
    kdf: KdfParams,
    kdf_salt: Vec<u8>,
    protected_user_key: Vec<u8>,
    protected_private_key: Vec<u8>,
}

impl Wrapped {
    fn unlock(&self, password: &str) -> Result<gc::UnlockedAccount> {
        // `prepare_login` refuse des paramètres hors bornes : un fichier
        // trafiqué ne fait pas dériver une clé au rabais.
        let login = gc::prepare_login(password, &self.kdf_salt, self.kdf)?;
        gc::unlock_account(
            &login.stretched_key,
            &self.protected_user_key,
            &self.protected_private_key,
        )
        .map_err(|_| anyhow!("mot de passe incorrect (ou fichier altéré)"))
    }
}

/// Déchiffre ce que le serveur (ou le coffre) garde : les vaults par
/// `vault::open` — le même code que `gv get`, manifestes vérifiés —, puis
/// les pièces jointes que `chunk` sait retrouver.
fn decrypt(
    account: &gc::UnlockedAccount,
    cache: &Cache,
    chunk: impl Fn(Uuid, Uuid, u32) -> Option<Vec<u8>>,
) -> Recovered {
    let opened = vault::open(account, cache);
    let mut warnings = opened.warnings.clone();
    let mut vaults = Vec::new();
    for (index, v) in opened.vaults.iter().enumerate() {
        let mut items = Vec::new();
        let mut files = Vec::new();
        for e in opened.entries.iter().filter(|e| e.vault == index) {
            for a in crate::attachments(e) {
                match open_attachment(v.id, &a, &chunk) {
                    Ok(data) => files.push(RecoveredFile {
                        item: e.name.clone(),
                        name: a.name.clone(),
                        data,
                    }),
                    Err(err) => warnings.push(format!(
                        "vault « {} », « {} » : pièce jointe « {} » non récupérée : {err}",
                        v.name, e.name, a.name
                    )),
                }
            }
            items.push(e.payload.clone());
        }
        vaults.push(RecoveredVault {
            id: v.id,
            name: v.name.clone(),
            items,
            files,
        });
    }
    Recovered { vaults, warnings }
}

fn open_attachment(
    vault_id: Uuid,
    a: &crate::AttachmentRef,
    chunk: &impl Fn(Uuid, Uuid, u32) -> Option<Vec<u8>>,
) -> Result<Vec<u8>> {
    let key = STANDARD
        .decode(&a.key)
        .ok()
        .and_then(|k| gc::SymmetricKey::from_slice(&k).ok())
        .ok_or_else(|| anyhow!("clé illisible"))?;
    let count = gc::attachment_chunk_count(a.size);
    let mut out = Vec::with_capacity(a.size as usize);
    for i in 0..count {
        let sealed = chunk(vault_id, a.id, i).ok_or_else(|| anyhow!("morceau {} absent", i + 1))?;
        let plain = gc::open_attachment_chunk(&key, &a.id.to_string(), i, i + 1 == count, &sealed)
            .map_err(|_| anyhow!("le morceau {} ne s'ouvre pas", i + 1))?;
        out.extend(plain);
    }
    if out.len() as u64 != a.size {
        bail!("{} octets au lieu de {}", out.len(), a.size);
    }
    Ok(out)
}

// ─── Coffre local ───────────────────────────────────────────────────────────
//
// `coffre.json` (`docs/FORMATS.md`, « Coffre local ») lu par ses seuls champs
// utiles, sans dépendre de `guivault-local` : la description suffit.

#[derive(Deserialize)]
struct CoffreFile {
    format: u32,
    account: LocalAccountFile,
    #[serde(default)]
    vaults: Vec<LocalVaultFile>,
}

#[derive(Deserialize)]
struct LocalAccountFile {
    kdf: KdfParams,
    #[serde(with = "b64")]
    kdf_salt: Vec<u8>,
    #[serde(with = "b64")]
    protected_user_key: Vec<u8>,
    #[serde(with = "b64")]
    protected_private_key: Vec<u8>,
}

#[derive(Deserialize)]
struct LocalVaultFile {
    id: Uuid,
    kind: VaultKind,
    #[serde(with = "b64")]
    name_enc: Vec<u8>,
    #[serde(with = "b64")]
    wrapped_vault_key: Vec<u8>,
    revision: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    #[serde(default, with = "b64::option")]
    manifest: Option<Vec<u8>>,
    #[serde(default)]
    manifest_revision: i64,
    #[serde(default)]
    items: Vec<LocalItemFile>,
}

#[derive(Deserialize)]
struct LocalItemFile {
    id: Uuid,
    item_type: String,
    revision: i64,
    #[serde(with = "b64")]
    ciphertext: Vec<u8>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    #[serde(default)]
    deleted_at: Option<DateTime<Utc>>,
}

/// Le format de `coffre.json` que ce module connaît.
const LOCAL_FORMAT: u32 = 1;

pub fn from_local(dir: &Path, password: &str) -> Result<Recovered> {
    let path = dir.join("coffre.json");
    let text = std::fs::read_to_string(&path).with_context(|| format!("lecture de {}", path.display()))?;
    let coffre: CoffreFile = serde_json::from_str(&text).with_context(|| format!("{} illisible", path.display()))?;
    if coffre.format > LOCAL_FORMAT {
        bail!(
            "{} : format {} plus récent que ce gv (format {LOCAL_FORMAT}) — mettez gv à jour",
            path.display(),
            coffre.format
        );
    }
    let account = Wrapped {
        kdf: coffre.account.kdf,
        kdf_salt: coffre.account.kdf_salt,
        protected_user_key: coffre.account.protected_user_key,
        protected_private_key: coffre.account.protected_private_key,
    }
    .unlock(password)?;
    let mut cache = Cache::default();
    for v in coffre.vaults {
        let items = v
            .items
            .into_iter()
            .map(|i| Item {
                id: i.id,
                vault_id: v.id,
                item_type: i.item_type,
                revision: i.revision,
                ciphertext: i.ciphertext,
                deleted: i.deleted_at.is_some(),
                created_at: i.created_at,
                updated_at: i.updated_at,
            })
            .collect();
        cache.items.insert(
            v.id,
            VaultItems {
                revision: v.revision,
                items,
                manifest: v.manifest.map(|ciphertext| VaultManifest {
                    ciphertext,
                    revision: v.manifest_revision,
                }),
            },
        );
        cache.vaults.push(Vault {
            id: v.id,
            kind: v.kind,
            name_enc: v.name_enc,
            role: Role::Owner,
            wrapped_vault_key: v.wrapped_vault_key,
            revision: v.revision,
            created_at: v.created_at,
            updated_at: v.updated_at,
        });
    }
    Ok(decrypt(&account, &cache, |vault, att, i| {
        std::fs::read(
            dir.join("attachments")
                .join(vault.to_string())
                .join(att.to_string())
                .join(format!("{i}.bin")),
        )
        .ok()
    }))
}

/// L'archive d'un coffre (`docs/FORMATS.md`, « Coffre local exporté ») :
/// décompressée dans un dossier temporaire privé — des fichiers ordinaires
/// seulement, aucun nom qui sorte du dossier —, lue comme un coffre local,
/// puis effacée. Le coffre est à la racine de l'archive ou dans son seul
/// dossier.
pub fn from_archive(file: &Path, password: &str) -> Result<Recovered> {
    let f = std::fs::File::open(file).with_context(|| format!("lecture de {}", file.display()))?;
    let mut zip = zip::ZipArchive::new(f).with_context(|| format!("{} : archive illisible", file.display()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let tmp = std::env::temp_dir().join(format!("gv-recover-{}-{nanos}", std::process::id()));
    private_dir(&tmp)?;
    let result = (|| {
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let Some(name) = entry.enclosed_name() else {
                bail!("archive refusée : « {} » sort de son dossier", entry.name());
            };
            let target = tmp.join(name);
            if entry.is_dir() {
                private_dir(&target)?;
            } else if entry.is_file() {
                if let Some(parent) = target.parent() {
                    private_dir(parent)?;
                }
                let mut out = std::fs::File::create(&target)?;
                std::io::copy(&mut entry, &mut out)?;
            }
        }
        let root = if tmp.join("coffre.json").is_file() {
            tmp.clone()
        } else {
            let dirs: Vec<PathBuf> = std::fs::read_dir(&tmp)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.join("coffre.json").is_file())
                .collect();
            match dirs.as_slice() {
                [one] => one.clone(),
                _ => bail!("{} : pas de coffre (coffre.json) dans cette archive", file.display()),
            }
        };
        from_local(&root, password)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

// ─── Sauvegarde du serveur ──────────────────────────────────────────────────
//
// Un gzip de lignes `table\tJSON` (`row_to_json` de PostgreSQL), tables dans
// l'ordre des clés étrangères : `users` d'abord, puis `vaults`,
// `vault_members`, `items`… On garde au passage ce qui concerne le compte.

/// Un `bytea` tel que `row_to_json` l'écrit : `\x` puis l'hexadécimal.
fn bytea(v: &Value) -> Result<Vec<u8>> {
    let s = v.as_str().ok_or_else(|| anyhow!("bytea attendu"))?;
    let hex = s.strip_prefix("\\x").ok_or_else(|| anyhow!("bytea sans \\x"))?;
    if !hex.len().is_multiple_of(2) {
        bail!("bytea de longueur impaire");
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| anyhow!("bytea illisible")))
        .collect()
}

fn uuid_of(row: &Value, col: &str) -> Result<Uuid> {
    row[col]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow!("colonne {col} illisible"))
}

fn time_of(row: &Value, col: &str) -> DateTime<Utc> {
    serde_json::from_value(row[col].clone()).unwrap_or_default()
}

fn int_of(row: &Value, col: &str) -> Result<i64> {
    row[col].as_i64().ok_or_else(|| anyhow!("colonne {col} illisible"))
}

pub fn from_backup(file: &Path, email: &str, password: &str) -> Result<Recovered> {
    let f = std::fs::File::open(file).with_context(|| format!("lecture de {}", file.display()))?;
    let reader = BufReader::new(flate2::read::GzDecoder::new(f));
    let email = email.trim().to_lowercase();
    let mut user: Option<(Uuid, Wrapped)> = None;
    let mut vaults: HashMap<Uuid, Value> = HashMap::new();
    let mut members: HashMap<Uuid, Vec<u8>> = HashMap::new();
    let mut items: HashMap<Uuid, Vec<Item>> = HashMap::new();
    let mut chunks: HashMap<(Uuid, Uuid, u32), Vec<u8>> = HashMap::new();
    let mut ended = false;
    for (n, line) in reader.lines().enumerate() {
        let line = line.with_context(|| format!("{} : fichier tronqué ou altéré", file.display()))?;
        let (table, json) = line
            .split_once('\t')
            .ok_or_else(|| anyhow!("ligne {} illisible", n + 1))?;
        if n == 0 {
            if table != "GUIVAULT-BACKUP" {
                bail!("{} : pas une sauvegarde GuiVault", file.display());
            }
            continue;
        }
        if table == "END" {
            ended = true;
            break;
        }
        let wanted = matches!(
            table,
            "users" | "vaults" | "vault_members" | "items" | "attachment_chunks"
        );
        if !wanted {
            continue;
        }
        let row: Value = serde_json::from_str(json).with_context(|| format!("ligne {} illisible", n + 1))?;
        match table {
            "users" if row["email"].as_str().is_some_and(|e| e.to_lowercase() == email) => {
                user = Some((
                    uuid_of(&row, "id")?,
                    Wrapped {
                        kdf: KdfParams {
                            m_cost: int_of(&row, "kdf_m_cost")? as u32,
                            t_cost: int_of(&row, "kdf_t_cost")? as u32,
                            p_cost: int_of(&row, "kdf_p_cost")? as u32,
                        },
                        kdf_salt: bytea(&row["kdf_salt"])?,
                        protected_user_key: bytea(&row["protected_user_key"])?,
                        protected_private_key: bytea(&row["protected_private_key"])?,
                    },
                ));
            }
            "vaults" => {
                vaults.insert(uuid_of(&row, "id")?, row);
            }
            "vault_members" => {
                if user
                    .as_ref()
                    .is_some_and(|(id, _)| uuid_of(&row, "user_id").ok() == Some(*id))
                {
                    members.insert(uuid_of(&row, "vault_id")?, bytea(&row["wrapped_vault_key"])?);
                }
            }
            "items" => {
                let vault_id = uuid_of(&row, "vault_id")?;
                if members.contains_key(&vault_id) {
                    items.entry(vault_id).or_default().push(Item {
                        id: uuid_of(&row, "id")?,
                        vault_id,
                        item_type: row["item_type"].as_str().unwrap_or_default().to_string(),
                        revision: int_of(&row, "revision")?,
                        ciphertext: bytea(&row["ciphertext"])?,
                        deleted: !row["deleted_at"].is_null(),
                        created_at: time_of(&row, "created_at"),
                        updated_at: time_of(&row, "updated_at"),
                    });
                }
            }
            "attachment_chunks" => {
                let vault_id = uuid_of(&row, "vault_id")?;
                if members.contains_key(&vault_id) {
                    chunks.insert(
                        (vault_id, uuid_of(&row, "attachment_id")?, int_of(&row, "idx")? as u32),
                        bytea(&row["ciphertext"])?,
                    );
                }
            }
            _ => {}
        }
    }
    if !ended {
        bail!("{} : sauvegarde incomplète (pas de ligne END)", file.display());
    }
    let Some((_, wrapped)) = user else {
        bail!("aucun compte {email} dans cette sauvegarde");
    };
    let account = wrapped.unlock(password)?;
    let mut cache = Cache::default();
    for (vault_id, wrapped_vault_key) in members {
        let Some(row) = vaults.get(&vault_id) else { continue };
        let kind = match row["kind"].as_str() {
            Some("personal") => VaultKind::Personal,
            _ => VaultKind::Shared,
        };
        let revision = int_of(row, "revision").unwrap_or(0);
        let manifest = match &row["manifest"] {
            Value::Null => None,
            m => Some(VaultManifest {
                ciphertext: bytea(m)?,
                revision: int_of(row, "manifest_revision").unwrap_or(0),
            }),
        };
        cache.items.insert(
            vault_id,
            VaultItems {
                revision,
                items: items.remove(&vault_id).unwrap_or_default(),
                manifest,
            },
        );
        cache.vaults.push(Vault {
            id: vault_id,
            kind,
            name_enc: bytea(&row["name_enc"])?,
            role: Role::Reader,
            wrapped_vault_key,
            revision,
            created_at: time_of(row, "created_at"),
            updated_at: time_of(row, "updated_at"),
        });
    }
    Ok(decrypt(&account, &cache, |vault, att, i| {
        chunks.get(&(vault, att, i)).cloned()
    }))
}

// ─── Export ─────────────────────────────────────────────────────────────────

pub fn from_export(file: &Path, password: Option<&str>) -> Result<Recovered> {
    let text = std::fs::read_to_string(file).with_context(|| format!("lecture de {}", file.display()))?;
    let doc: Value = serde_json::from_str(&text).with_context(|| format!("{} : JSON illisible", file.display()))?;
    let doc = match doc["format"].as_str() {
        Some("guivault-export") => doc,
        Some("guivault-export-encrypted") => {
            let password = password.ok_or_else(|| anyhow!("export chiffré : il faut son mot de passe"))?;
            let b64 = |k: &str| {
                doc[k]
                    .as_str()
                    .and_then(|s| STANDARD.decode(s).ok())
                    .ok_or_else(|| anyhow!("export : champ {k} illisible"))
            };
            let kdf: KdfParams = serde_json::from_value(doc["kdf"].clone()).context("export : kdf illisible")?;
            let key = gc::export_key(password, &b64("kdf_salt")?, kdf)?;
            let plain = gc::open(&key, &b64("blob")?, gc::AAD_EXPORT)
                .map_err(|_| anyhow!("mot de passe incorrect (ou fichier altéré)"))?;
            serde_json::from_slice(&plain).context("export : contenu illisible")?
        }
        _ => bail!("{} : ni un export GuiVault, ni un export chiffré", file.display()),
    };
    let vault = &doc["vault"];
    Ok(Recovered {
        vaults: vec![RecoveredVault {
            id: vault["id"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(Uuid::nil),
            name: vault["name"].as_str().unwrap_or("Export").to_string(),
            items: doc["items"].as_array().cloned().unwrap_or_default(),
            files: vec![],
        }],
        warnings: vec![],
    })
}

// ─── Écrire ─────────────────────────────────────────────────────────────────

/// Un nom de fichier sûr sur tous les systèmes.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .take(100)
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() { "_".into() } else { trimmed.into() }
}

/// `name`, ou `name (2)`, `name (3)`… s'il est déjà pris (sans tenir compte
/// de la casse : Windows et macOS n'en tiennent pas compte non plus).
fn unique(taken: &mut HashSet<String>, name: String, ext: &str) -> String {
    let mut candidate = format!("{name}{ext}");
    let mut n = 2;
    while !taken.insert(candidate.to_lowercase()) {
        candidate = format!("{name} ({n}){ext}");
        n += 1;
    }
    candidate
}

fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("création de {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_file(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .with_context(|| format!("écriture de {}", path.display()))?;
    f.write_all(data)?;
    Ok(())
}

/// Sans ses pièces jointes, comme l'export de l'interface : leur clé
/// n'ouvre rien sans le fichier, et un import pointerait vers des fichiers
/// absents. Les fichiers, eux, sont écrits à côté.
fn without_attachments(item: &Value) -> Value {
    let mut copy = item.clone();
    if let Some(obj) = copy.as_object_mut() {
        for v in obj.values_mut() {
            if let Some(entity) = v.as_object_mut() {
                entity.remove("attachments");
            }
        }
    }
    copy
}

/// Écrit `rec` dans `out` (créé ; refusé s'il existe et n'est pas vide) :
/// `<vault>.json` par vault, au format d'export de l'interface, et
/// `<vault>/<élément>/<fichier>` pour les pièces jointes. Tout en `0600`
/// dans des dossiers en `0700`. Rend les chemins écrits.
pub fn write(rec: &Recovered, out: &Path) -> Result<Vec<PathBuf>> {
    if out.exists() && std::fs::read_dir(out)?.next().is_some() {
        bail!(
            "{} existe et n'est pas vide : choisissez un autre dossier (--out)",
            out.display()
        );
    }
    private_dir(out)?;
    let mut written = Vec::new();
    let mut taken = HashSet::new();
    for v in &rec.vaults {
        let base = safe_name(&v.name);
        let json_name = unique(&mut taken, base.clone(), ".json");
        let groups: Vec<&Value> = v
            .items
            .iter()
            .filter(|i| i["kind"] == "group")
            .filter_map(|i| i.get("group"))
            .collect();
        let doc = json!({
            "format": "guivault-export",
            "version": 1,
            "exportedAt": Utc::now().to_rfc3339(),
            "vault": { "id": v.id, "name": v.name },
            "groups": groups,
            "items": v.items.iter().map(without_attachments).collect::<Vec<_>>(),
        });
        let path = out.join(&json_name);
        private_file(&path, serde_json::to_string_pretty(&doc)?.as_bytes())?;
        written.push(path);
        if v.files.is_empty() {
            continue;
        }
        let dir_name = unique(&mut taken, base, "");
        let mut per_item: HashMap<String, HashSet<String>> = HashMap::new();
        for f in &v.files {
            let item_dir = out.join(&dir_name).join(safe_name(&f.item));
            private_dir(&item_dir)?;
            let name = unique(per_item.entry(f.item.clone()).or_default(), safe_name(&f.name), "");
            let path = item_dir.join(name);
            private_file(&path, &f.data)?;
            written.push(path);
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytea_and_names() {
        assert_eq!(bytea(&json!("\\x00ff10")).unwrap(), vec![0, 255, 16]);
        assert!(bytea(&json!("00ff")).is_err());
        assert!(bytea(&json!("\\x0")).is_err());
        assert_eq!(safe_name("a/b:c"), "a_b_c");
        assert_eq!(safe_name(" .. "), "_");
        let mut taken = HashSet::new();
        assert_eq!(unique(&mut taken, "Perso".into(), ".json"), "Perso.json");
        assert_eq!(unique(&mut taken, "perso".into(), ".json"), "perso (2).json");
    }
}
