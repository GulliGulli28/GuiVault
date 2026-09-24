//! `gv`, le coffre GuiVault en ligne de commande. La cryptographie est celle
//! de Guiterm et de l'interface web (`guivault-crypto`) : le serveur ne voit
//! que la clé d'auth et des blobs.
//!
//! Le modèle est celui de la CLI de Bitwarden : `gv login` une fois, puis
//! `eval "$(gv unlock)"` — la clé de session vit dans la coquille
//! (`GUIVAULT_SESSION`), les clés du compte sur le disque, scellées sous
//! elle. Les vaults sont gardés chiffrés en cache et resynchronisés quand
//! il a plus de cinq minutes — ou pas, si le serveur ne répond pas : un
//! secret se lit alors depuis le cache.
pub mod api;
pub mod store;
pub mod vault;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use guivault_crypto as gc;
use guivault_protocol::LoginRequest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::api::{Api, LoginStep};
use crate::store::{Account, Cache, Home, SessionFile, VaultItems};
use crate::vault::Opened;

/// Au-delà, `gv` resynchronise avant de lire (s'il peut).
pub const CACHE_MAX_AGE: chrono::Duration = chrono::Duration::minutes(5);

/// Ce qu'on demande à l'utilisateur : le terminal pour `gv`, des valeurs
/// fixes pour les tests.
pub trait Prompt {
    fn password(&self, prompt: &str) -> Result<String>;
    fn code(&self, prompt: &str) -> Result<String>;
}

// ─── Connexion et session ───────────────────────────────────────────────────

/// Se connecte, garde le compte enveloppé et les jetons, synchronise, et
/// rend une clé de session (`GUIVAULT_SESSION`).
pub fn login(home: &Home, server: &str, email: &str, device: &str, prompt: &dyn Prompt) -> Result<String> {
    let server = server.trim().trim_end_matches('/').to_string();
    let email = email.trim().to_lowercase();
    let api = Api::new(&server)?;
    let pre = api.prelogin(&email)?;
    // Paramètres épinglés : ceux de la connexion précédente, sur ce poste.
    if let Some(prev) = home.account()?
        && prev.server == server
        && prev.email == email
        && pre.kdf.weaker_than(&prev.kdf)
    {
        bail!(
            "le serveur demande une dérivation plus faible que la dernière fois (Argon2id m={} Kio, t={} au lieu de m={} Kio, t={}) : \
             connexion refusée, rien n'a été envoyé. Le serveur est peut-être compromis.",
            pre.kdf.m_cost,
            pre.kdf.t_cost,
            prev.kdf.m_cost,
            prev.kdf.t_cost
        );
    }
    let password = prompt.password("Mot de passe maître : ")?;
    let lm = gc::prepare_login(&password, &pre.kdf_salt, pre.kdf)?;
    let resp = match api.login(&LoginRequest {
        email: email.clone(),
        auth_key: lm.auth_key.as_bytes().to_vec(),
        device_name: Some(device.to_string()),
    })? {
        LoginStep::Done(r) => *r,
        LoginStep::Totp(token) => api.totp_verify(&token, prompt.code("Code du second facteur : ")?.trim())?,
    };
    let unlocked = gc::unlock_account(&lm.stretched_key, &resp.protected_user_key, &resp.protected_private_key)
        .map_err(|_| anyhow!("le serveur a accepté la connexion mais les clés ne s'ouvrent pas"))?;
    let previous = home.account()?;
    if previous
        .as_ref()
        .is_some_and(|p| p.user_id != resp.user.id || p.server != server)
    {
        // Un autre compte : son cache n'a rien à faire ici.
        home.forget();
    }
    let mut account = Account {
        server,
        email,
        user_id: resp.user.id,
        kdf: pre.kdf,
        kdf_salt: pre.kdf_salt,
        protected_user_key: resp.protected_user_key,
        protected_private_key: resp.protected_private_key,
        tokens: api::tokens(&resp.tokens),
    };
    home.save_account(&account)?;
    let key = new_session(home, &account, &unlocked)?;
    sync(home, &mut account)?;
    Ok(key)
}

/// Rouvre le compte avec le mot de passe maître — sans le serveur — et
/// rend une nouvelle clé de session.
pub fn unlock(home: &Home, prompt: &dyn Prompt) -> Result<String> {
    let account = require_account(home)?;
    let unlocked = unlock_with_password(&account, prompt)?;
    new_session(home, &account, &unlocked)
}

fn require_account(home: &Home) -> Result<Account> {
    home.account()?
        .ok_or_else(|| anyhow!("aucun compte : `gv login --server https://… --email …`"))
}

fn unlock_with_password(account: &Account, prompt: &dyn Prompt) -> Result<gc::UnlockedAccount> {
    let password = prompt.password(&format!("Mot de passe maître ({}) : ", account.email))?;
    let lm = gc::prepare_login(&password, &account.kdf_salt, account.kdf)?;
    gc::unlock_account(
        &lm.stretched_key,
        &account.protected_user_key,
        &account.protected_private_key,
    )
    .map_err(|_| anyhow!("mot de passe maître incorrect"))
}

#[derive(Serialize, Deserialize)]
struct SessionKeys {
    #[serde(with = "guivault_protocol::b64")]
    user_key: Vec<u8>,
    #[serde(with = "guivault_protocol::b64")]
    private_key: Vec<u8>,
}

fn session_aad(account: &Account) -> Vec<u8> {
    format!("guivault/cli/session\0{}", account.user_id).into_bytes()
}

fn new_session(home: &Home, account: &Account, unlocked: &gc::UnlockedAccount) -> Result<String> {
    let key = gc::SymmetricKey::random();
    let keys = SessionKeys {
        user_key: unlocked.user_key.as_bytes().to_vec(),
        private_key: unlocked.keypair.private.to_bytes().to_vec(),
    };
    let blob = gc::seal(&key, &serde_json::to_vec(&keys)?, &session_aad(account))?;
    home.save_session(&SessionFile { blob })?;
    Ok(URL_SAFE_NO_PAD.encode(key.as_bytes()))
}

/// Le compte déverrouillé : par la clé de session (`GUIVAULT_SESSION`), ou
/// en demandant le mot de passe maître si l'on peut (`prompt`).
pub fn unlocked(
    home: &Home,
    session: Option<&str>,
    prompt: Option<&dyn Prompt>,
) -> Result<(Account, gc::UnlockedAccount)> {
    let account = require_account(home)?;
    if let Some(s) = session.filter(|s| !s.is_empty()) {
        let bytes = URL_SAFE_NO_PAD.decode(s.trim()).context("GUIVAULT_SESSION illisible")?;
        let key = gc::SymmetricKey::from_slice(&bytes).context("GUIVAULT_SESSION illisible")?;
        let file = home
            .session()?
            .ok_or_else(|| anyhow!("session fermée (`gv lock`) : `eval \"$(gv unlock)\"`"))?;
        let plain = gc::open(&key, &file.blob, &session_aad(&account))
            .map_err(|_| anyhow!("GUIVAULT_SESSION ne correspond plus à la session : `eval \"$(gv unlock)\"`"))?;
        let keys: SessionKeys = serde_json::from_slice(&plain)?;
        let private: [u8; 32] = keys.private_key.as_slice().try_into().context("session illisible")?;
        let private = gc::PrivateKey::from(private);
        let unlocked = gc::UnlockedAccount {
            user_key: gc::SymmetricKey::from_slice(&keys.user_key)?,
            keypair: gc::KeyPair {
                public: private.public_key(),
                private,
            },
        };
        return Ok((account, unlocked));
    }
    match prompt {
        Some(p) => {
            let unlocked = unlock_with_password(&account, p)?;
            Ok((account, unlocked))
        }
        None => bail!("verrouillé : `eval \"$(gv unlock)\"` (ou GUIVAULT_SESSION)"),
    }
}

pub fn logout(home: &Home) -> Result<()> {
    if let Some(mut account) = home.account()? {
        let api = Api::new(&account.server)?;
        if let Ok(access) = api.access_token(&mut account) {
            let _ = api.logout(&access);
        }
    }
    home.forget();
    Ok(())
}

// ─── Synchronisation ────────────────────────────────────────────────────────

/// Relit `/sync` et les items des vaults dont la révision a bougé. Sous le
/// verrou : un autre `gv` qui synchronise déjà → le cache tel quel.
pub fn sync(home: &Home, account: &mut Account) -> Result<Cache> {
    let Some(_lock) = home.try_sync_lock()? else {
        return home
            .cache()?
            .ok_or_else(|| anyhow!("synchronisation en cours dans un autre `gv` : réessayez"));
    };
    // Relu sous le verrou : un autre `gv` a pu faire tourner les jetons.
    if let Some(fresh) = home.account()? {
        *account = fresh;
    }
    let api = Api::new(&account.server)?;
    let access = api.access_token(account)?;
    home.save_account(account)?;
    let res = api.sync(&access)?;
    let mut previous = home.cache()?.unwrap_or_default();
    let mut items = HashMap::new();
    for v in &res.vaults {
        if let Some(stored) = previous.items.remove(&v.id)
            && stored.revision == v.revision
        {
            items.insert(v.id, stored);
            continue;
        }
        let page = api.items(&access, v.id)?;
        items.insert(
            v.id,
            VaultItems {
                revision: page.revision,
                items: page.items.into_iter().filter(|i| !i.deleted).collect(),
            },
        );
    }
    let cache = Cache {
        vaults: res.vaults,
        items,
        synced_at: Some(chrono::Utc::now()),
    };
    home.save_cache(&cache)?;
    Ok(cache)
}

/// Le cache, resynchronisé s'il a plus de `CACHE_MAX_AGE`. Serveur
/// injoignable : le cache tel quel, avec un avertissement.
pub fn cache(home: &Home, account: &mut Account) -> Result<(Cache, Option<String>)> {
    let current = home.cache()?;
    let fresh = current
        .as_ref()
        .and_then(|c| c.synced_at)
        .is_some_and(|at| chrono::Utc::now() - at < CACHE_MAX_AGE);
    if let Some(c) = current.clone().filter(|_| fresh) {
        return Ok((c, None));
    }
    match sync(home, account) {
        Ok(c) => Ok((c, None)),
        Err(e) => match current {
            Some(c) => {
                let when = c
                    .synced_at
                    .map(|t| t.with_timezone(&chrono::Local).format("%d/%m %H:%M").to_string());
                Ok((
                    c,
                    Some(format!(
                        "{e} — lu dans le cache du {}",
                        when.unwrap_or_else(|| "?".into())
                    )),
                ))
            }
            None => Err(e),
        },
    }
}

// ─── Références ─────────────────────────────────────────────────────────────

/// `gv://<vault>/<élément>[/<champ>]` — noms ou ids, `%20` pour une espace
/// ou un caractère réservé ; sans vault : `gv://<élément>`.
#[derive(Debug, PartialEq, Eq)]
pub struct SecretRef {
    pub vault: Option<String>,
    pub item: String,
    pub field: Option<String>,
}

pub fn parse_ref(s: &str) -> Result<SecretRef> {
    let rest = s
        .strip_prefix("gv://")
        .ok_or_else(|| anyhow!("« {s} » n'est pas une référence gv://"))?;
    let parts: Vec<String> = rest.split('/').map(percent_decode).collect::<Result<_>>()?;
    match parts.as_slice() {
        [item] if !item.is_empty() => Ok(SecretRef {
            vault: None,
            item: item.clone(),
            field: None,
        }),
        [vault, item] if !item.is_empty() => Ok(SecretRef {
            vault: Some(vault.clone()),
            item: item.clone(),
            field: None,
        }),
        [vault, item, field] if !item.is_empty() && !field.is_empty() => Ok(SecretRef {
            vault: Some(vault.clone()),
            item: item.clone(),
            field: Some(field.clone()),
        }),
        _ => bail!("« {s} » : attendu gv://<vault>/<élément>[/<champ>]"),
    }
}

fn percent_decode(s: &str) -> Result<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).context("référence : UTF-8 invalide")
}

/// La valeur d'une référence.
pub fn resolve(opened: &Opened, r: &SecretRef) -> Result<String> {
    let entry = opened.find(r.vault.as_deref(), &r.item)?;
    let field = match &r.field {
        Some(f) => f.clone(),
        None => vault::default_field(&entry.kind)
            .ok_or_else(|| anyhow!("« {} » ({}) : précisez le champ à lire", entry.name, entry.kind))?
            .to_string(),
    };
    vault::field(entry, &field)
}

/// Les variables d'environnement dont la valeur est une référence `gv://`,
/// remplacées par le secret (`gv run`). Les autres ne bougent pas.
pub fn resolve_env(opened: &Opened, env: &[(String, String)]) -> Result<Vec<(String, String)>> {
    env.iter()
        .filter(|(_, v)| v.starts_with("gv://"))
        .map(|(k, v)| {
            let value = resolve(opened, &parse_ref(v)?).with_context(|| format!("variable {k}"))?;
            Ok((k.clone(), value))
        })
        .collect()
}

/// Un fichier `.env` : `CLÉ=valeur`, lignes vides et `#` ignorées, guillemets
/// retirés, `export ` toléré.
pub fn parse_env_file(text: &str) -> Vec<(String, String)> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let l = l.strip_prefix("export ").unwrap_or(l);
            let (k, v) = l.split_once('=')?;
            let v = v.trim();
            let v = v
                .strip_prefix('"')
                .and_then(|x| x.strip_suffix('"'))
                .or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
                .unwrap_or(v);
            Some((k.trim().to_string(), v.to_string()))
        })
        .collect()
}

// ─── AWS et Git ─────────────────────────────────────────────────────────────

/// La sortie attendue d'un `credential_process` AWS pour un accès du coffre
/// par clés (`authType: keys`) — par son nom, son id ou une référence.
pub fn aws_credential_process(opened: &Opened, target: &str) -> Result<String> {
    let r = if target.starts_with("gv://") {
        parse_ref(target)?
    } else {
        SecretRef {
            vault: None,
            item: target.to_string(),
            field: None,
        }
    };
    let entry = opened.find(r.vault.as_deref(), &r.item)?;
    if entry.kind != "aws" {
        bail!("« {} » n'est pas un accès AWS ({})", entry.name, entry.kind);
    }
    let aws = vault::entity(&entry.payload).cloned().unwrap_or(Value::Null);
    if aws["authType"].as_str() == Some("sso") {
        bail!(
            "« {} » est un accès SSO : `aws sso login`, pas de credential_process",
            entry.name
        );
    }
    let id = aws["accessKeyId"].as_str().filter(|s| !s.is_empty());
    let secret = aws["secretAccessKey"].as_str().filter(|s| !s.is_empty());
    let (Some(id), Some(secret)) = (id, secret) else {
        bail!("« {} » : clé d'accès incomplète", entry.name);
    };
    Ok(serde_json::json!({ "Version": 1, "AccessKeyId": id, "SecretAccessKey": secret }).to_string())
}

/// `git credential get` : l'identifiant du coffre dont une URI correspond à
/// l'hôte demandé (et au protocole, et à l'utilisateur s'il est donné).
/// `None` : rien — Git passe au helper suivant, ou demande.
pub fn git_credential(opened: &Opened, input: &str) -> Option<String> {
    let attrs: HashMap<&str, &str> = input.lines().filter_map(|l| l.split_once('=')).collect();
    let host = attrs.get("host")?.to_lowercase();
    let protocol = attrs.get("protocol").map(|p| p.to_lowercase());
    let user = attrs.get("username").copied();
    let mut candidates: Vec<(&str, &str, &str)> = opened
        .entries
        .iter()
        .filter(|e| e.kind == "login")
        .filter_map(|e| {
            let l = vault::entity(&e.payload)?;
            let matches = l["uris"].as_array()?.iter().filter_map(|u| u["uri"].as_str()).any(|u| {
                // Sans schéma (« hôte:port »), `Url::parse` prendrait l'hôte
                // pour un schéma : on l'ajoute d'abord.
                let parsed = if u.contains("://") {
                    url::Url::parse(u)
                } else {
                    url::Url::parse(&format!("https://{u}"))
                };
                parsed.is_ok_and(|p| {
                    let h = match p.port() {
                        Some(port) => format!("{}:{port}", p.host_str().unwrap_or_default()),
                        None => p.host_str().unwrap_or_default().to_string(),
                    };
                    h.eq_ignore_ascii_case(&host)
                        && (protocol.is_none() || !u.contains("://") || protocol.as_deref() == Some(p.scheme()))
                })
            });
            let username = l["username"].as_str().unwrap_or_default();
            let password = l["password"].as_str().filter(|p| !p.is_empty())?;
            (matches && user.is_none_or(|u| u == username)).then_some((e.name.as_str(), username, password))
        })
        .collect();
    candidates.sort_by(|a, b| a.0.cmp(b.0));
    let (_, username, password) = candidates.first()?;
    Some(format!("username={username}\npassword={password}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_parse_with_and_without_vault_and_field() {
        assert_eq!(
            parse_ref("gv://GitHub").unwrap(),
            SecretRef {
                vault: None,
                item: "GitHub".into(),
                field: None
            }
        );
        assert_eq!(
            parse_ref("gv://Équipe%20infra/Base%20prod/password").unwrap(),
            SecretRef {
                vault: Some("Équipe infra".into()),
                item: "Base prod".into(),
                field: Some("password".into())
            }
        );
        assert!(parse_ref("gv://").is_err());
        assert!(parse_ref("https://x").is_err());
        assert!(parse_ref("gv://a/b/c/d").is_err());
    }

    #[test]
    fn env_files() {
        let env = parse_env_file("# commentaire\nexport A=1\nB=\"gv://V/I\"\n\nC='x y'\n");
        assert_eq!(
            env,
            vec![
                ("A".into(), "1".into()),
                ("B".into(), "gv://V/I".into()),
                ("C".into(), "x y".into())
            ]
        );
    }
}
