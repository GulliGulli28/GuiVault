//! Ce que `gv` garde sur le disque, dans son dossier (`GV_HOME`, sinon
//! `$XDG_CONFIG_HOME/guivault-cli`, `~/.config/guivault-cli`,
//! `%APPDATA%\guivault-cli`), en `0700`/`0600` :
//!
//! - `account.json` : le serveur, l'e-mail, le compte **enveloppé** tel que
//!   le serveur le garde (paramètres Argon2id, user key et clé privée
//!   scellées) et les jetons de session ;
//! - `session.json` : la user key et la clé privée, scellées sous une clé de
//!   session aléatoire que `gv unlock` donne à la seule coquille
//!   (`GUIVAULT_SESSION`) — sans elle, ce fichier est illisible ;
//! - `cache.json` : les vaults et leurs items, chiffrés comme sur le
//!   serveur — ce qui permet de lire un secret sans lui ;
//! - `sync.lock` : pendant une synchronisation, pour que deux `gv` lancés en
//!   même temps ne fassent pas tourner le même jeton de rafraîchissement
//!   (le serveur y verrait un rejeu et révoquerait la session).
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use guivault_crypto::KdfParams;
use guivault_protocol::{Item, Vault};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct Home(pub PathBuf);

impl Home {
    pub fn default_dir() -> Result<Self> {
        if let Ok(dir) = std::env::var("GV_HOME")
            && !dir.is_empty()
        {
            return Ok(Self(dir.into()));
        }
        let base = if cfg!(windows) {
            std::env::var("APPDATA").map(PathBuf::from)
        } else if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME")
            && !xdg.is_empty()
        {
            Ok(PathBuf::from(xdg))
        } else {
            std::env::var("HOME").map(|h| PathBuf::from(h).join(".config"))
        }
        .context("impossible de trouver le dossier de configuration (HOME, XDG_CONFIG_HOME ou APPDATA)")?;
        Ok(Self(base.join("guivault-cli")))
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.0).with_context(|| format!("création de {}", self.0.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    fn read<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Result<Option<T>> {
        let path = self.path(name);
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(
                serde_json::from_slice(&bytes).with_context(|| format!("{} illisible", path.display()))?,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("lecture de {}", path.display())),
        }
    }

    /// Écrit à côté puis renomme : un `gv` interrompu ne laisse pas un
    /// fichier à moitié écrit. `0600` avant d'y mettre quoi que ce soit.
    fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        self.ensure()?;
        let tmp = self.path(&format!("{name}.tmp"));
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(value)?)?;
        f.sync_all()?;
        fs::rename(&tmp, self.path(name))?;
        Ok(())
    }

    fn remove(&self, name: &str) {
        let _ = fs::remove_file(self.path(name));
    }

    pub fn account(&self) -> Result<Option<Account>> {
        self.read("account.json")
    }

    pub fn save_account(&self, a: &Account) -> Result<()> {
        self.write("account.json", a)
    }

    pub fn session(&self) -> Result<Option<SessionFile>> {
        self.read("session.json")
    }

    pub fn save_session(&self, s: &SessionFile) -> Result<()> {
        self.write("session.json", s)
    }

    pub fn cache(&self) -> Result<Option<Cache>> {
        self.read("cache.json")
    }

    pub fn save_cache(&self, c: &Cache) -> Result<()> {
        self.write("cache.json", c)
    }

    pub fn lock(&self) {
        self.remove("session.json");
    }

    /// Tout, compte compris : `gv logout`.
    pub fn forget(&self) {
        for f in ["session.json", "cache.json", "account.json", "sync.lock"] {
            self.remove(f);
        }
    }

    /// Le verrou de synchronisation. `None` : un autre `gv` synchronise en ce
    /// moment (un verrou de moins d'une minute) — l'appelant se contente du
    /// cache. Un verrou plus vieux est celui d'un `gv` mort : repris.
    pub fn try_sync_lock(&self) -> Result<Option<SyncLock>> {
        self.ensure()?;
        let path = self.path("sync.lock");
        for _ in 0..2 {
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Some(SyncLock(path))),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let age = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok());
                    if age.is_some_and(|a| a.as_secs() < 60) {
                        return Ok(None);
                    }
                    let _ = fs::remove_file(&path);
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(None)
    }
}

pub struct SyncLock(PathBuf);

impl Drop for SyncLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub access_expires_at: DateTime<Utc>,
}

/// Le compte tel que le serveur le garde : illisible sans le mot de passe
/// maître. De quoi déverrouiller sans le serveur (`gv unlock`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub server: String,
    pub email: String,
    pub user_id: Uuid,
    pub kdf: KdfParams,
    #[serde(with = "guivault_protocol::b64")]
    pub kdf_salt: Vec<u8>,
    #[serde(with = "guivault_protocol::b64")]
    pub protected_user_key: Vec<u8>,
    #[serde(with = "guivault_protocol::b64")]
    pub protected_private_key: Vec<u8>,
    pub tokens: Tokens,
}

/// La user key et la clé privée, scellées sous la clé de session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionFile {
    #[serde(with = "guivault_protocol::b64")]
    pub blob: Vec<u8>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Cache {
    pub vaults: Vec<Vault>,
    pub items: HashMap<Uuid, VaultItems>,
    pub synced_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultItems {
    pub revision: i64,
    pub items: Vec<Item>,
}
