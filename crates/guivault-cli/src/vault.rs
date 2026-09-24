//! Les vaults déchiffrés, un élément retrouvé par son nom ou son id, et un
//! de ses champs. Les items sont le JSON de l'interface web et de Guiterm
//! (`{ "kind": "login", "login": { … } }`, voir `docs/ITEMS.md`) : lus
//! génériquement, pour que tout type et tout champ se lise sans que `gv`
//! ait à les connaître un par un.
use anyhow::{Result, anyhow, bail};
use guivault_crypto as gc;
use guivault_protocol::{Vault, VaultKind};
use serde_json::Value;
use uuid::Uuid;

use crate::store::Cache;

pub struct OpenVault {
    pub id: Uuid,
    pub name: String,
    pub kind: VaultKind,
}

pub struct Entry {
    pub vault: usize,
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub payload: Value,
}

pub struct Opened {
    pub vaults: Vec<OpenVault>,
    pub entries: Vec<Entry>,
    /// Ce qui ne s'est pas ouvert (un vault, un item) : dit sur la sortie
    /// d'erreur, sans arrêter le reste.
    pub warnings: Vec<String>,
}

/// Déchiffre le cache avec le compte déverrouillé.
pub fn open(account: &gc::UnlockedAccount, cache: &Cache) -> Opened {
    let mut out = Opened {
        vaults: Vec::new(),
        entries: Vec::new(),
        warnings: Vec::new(),
    };
    let mut vaults: Vec<&Vault> = cache.vaults.iter().collect();
    vaults.sort_by_key(|v| v.kind != VaultKind::Personal);
    for v in vaults {
        let vid = v.id.to_string();
        let key = match gc::unwrap_vault_key(account, &vid, &v.wrapped_vault_key) {
            Ok(k) => k.key,
            Err(e) => {
                out.warnings.push(format!("vault {} illisible : {e}", v.id));
                continue;
            }
        };
        let name = gc::open_vault_name(&key, &vid, &v.name_enc).unwrap_or_else(|_| {
            if v.kind == VaultKind::Personal {
                "Personnel"
            } else {
                "(nom illisible)"
            }
            .to_string()
        });
        let index = out.vaults.len();
        out.vaults.push(OpenVault {
            id: v.id,
            name,
            kind: v.kind,
        });
        for it in cache.items.get(&v.id).map(|x| x.items.as_slice()).unwrap_or_default() {
            if it.deleted {
                continue;
            }
            let payload = gc::open_item(&key, &vid, &it.id.to_string(), &it.item_type, &it.ciphertext)
                .map_err(|e| e.to_string())
                .and_then(|p| serde_json::from_slice::<Value>(&p).map_err(|e| e.to_string()));
            match payload {
                Ok(payload) if payload["kind"] == it.item_type.as_str() => {
                    let name = entity(&payload)
                        .and_then(|e| e.get("name").or_else(|| e.get("label")))
                        .and_then(Value::as_str)
                        .unwrap_or("(sans nom)")
                        .to_string();
                    out.entries.push(Entry {
                        vault: index,
                        id: it.id,
                        kind: it.item_type.clone(),
                        name,
                        payload,
                    });
                }
                Ok(_) => out
                    .warnings
                    .push(format!("item {} : contenu incohérent avec son type", it.id)),
                Err(e) => out.warnings.push(format!("item {} illisible : {e}", it.id)),
            }
        }
    }
    out
}

/// L'objet de l'entité dans le payload : `login`, `apiKey`, `connection`…
pub fn entity(payload: &Value) -> Option<&Value> {
    let key = match payload["kind"].as_str()? {
        "api-key" => "apiKey",
        "sql-connection" => "connection",
        other => other,
    };
    payload.get(key)
}

impl Opened {
    fn vault_matches(&self, index: usize, wanted: &str) -> bool {
        let v = &self.vaults[index];
        let w = wanted.to_lowercase();
        v.id.to_string() == w
            || v.name.to_lowercase() == w
            || (v.kind == VaultKind::Personal && matches!(w.as_str(), "personal" | "personnel" | "perso"))
    }

    /// Un élément par son id, ou son nom (sans tenir compte de la casse),
    /// dans un vault donné ou partout. Plusieurs de même nom : l'erreur les
    /// nomme, avec leur vault, pour choisir par l'id.
    pub fn find(&self, vault: Option<&str>, item: &str) -> Result<&Entry> {
        if let Some(v) = vault
            && !(0..self.vaults.len()).any(|i| self.vault_matches(i, v))
        {
            bail!("aucun vault « {v} »");
        }
        let wanted = item.to_lowercase();
        let found: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|e| vault.is_none_or(|v| self.vault_matches(e.vault, v)))
            .filter(|e| e.kind != "group" && e.kind != "icon")
            .filter(|e| e.id.to_string() == wanted || e.name.to_lowercase() == wanted)
            .collect();
        match found.as_slice() {
            [one] => Ok(one),
            [] => Err(anyhow!(
                "aucun élément « {item} »{}",
                vault.map(|v| format!(" dans « {v} »")).unwrap_or_default()
            )),
            many => {
                let list: Vec<String> = many
                    .iter()
                    .map(|e| {
                        format!(
                            "  {}  {} ({}, vault « {} »)",
                            e.id, e.name, e.kind, self.vaults[e.vault].name
                        )
                    })
                    .collect();
                bail!(
                    "plusieurs éléments « {item} » — précisez par l'id :\n{}",
                    list.join("\n")
                )
            }
        }
    }
}

/// Le champ lu quand on n'en demande pas : le secret de l'élément.
pub fn default_field(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "login" | "host" | "sql-connection" => "password",
        "api-key" => "secret",
        "aws" => "secret-access-key",
        "note" => "content",
        "card" => "number",
        "key" => "private-key",
        "snippet" => "command",
        "identity" => "email",
        _ => return None,
    })
}

/// Un champ d'un élément. D'abord les noms usuels (`password`, `username`,
/// `totp`, `uri`…), puis n'importe quel champ de l'entité en kebab-case
/// (`access-key-id` → `accessKeyId`), puis ses champs personnalisés par
/// leur nom.
pub fn field(e: &Entry, name: &str) -> Result<String> {
    let f = name.to_lowercase();
    let p = &e.payload;
    let ent = entity(p).ok_or_else(|| anyhow!("« {} » : contenu sans entité", e.name))?;
    let text = |v: &Value| -> Option<String> {
        match v {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    };
    let special: Option<Option<String>> = match (e.kind.as_str(), f.as_str()) {
        (_, "id") => Some(Some(e.id.to_string())),
        (_, "name") => Some(Some(e.name.clone())),
        ("login", "user" | "login") => Some(text(&ent["username"])),
        ("login", "pass") => Some(text(&ent["password"])),
        ("login", "uri" | "url") => Some(ent["uris"].get(0).and_then(|u| text(&u["uri"]))),
        ("login", "totp" | "code" | "otp") => Some(match text(&ent["totp"]) {
            Some(secret) => Some(totp_now(&secret)?),
            None => None,
        }),
        ("host", "password") => Some(text(&p["secrets"]["password"])),
        ("host", "passphrase") => Some(text(&p["secrets"]["passphrase"])),
        ("host", "user") => Some(text(&ent["username"])),
        ("host", "host") => Some(text(&ent["address"])),
        ("sql-connection", "password") => Some(text(&p["password"])),
        ("key", "private-key" | "content") => Some(text(&p["content"])),
        ("key", "passphrase") => Some(text(&p["passphrase"])),
        ("api-key", "key" | "password") => Some(text(&ent["secret"])),
        ("aws", "secret") => Some(text(&ent["secretAccessKey"])),
        ("card", "cvv" | "cvc") => Some(text(&ent["code"])),
        ("note", "notes" | "text") => Some(text(&ent["content"])),
        _ => None,
    };
    if let Some(v) = special {
        return v.ok_or_else(|| anyhow!("« {} » : champ « {name} » vide", e.name));
    }
    let camel = kebab_to_camel(&f);
    if let Some(v) = ent
        .as_object()
        .and_then(|o| o.iter().find(|(k, _)| k.to_lowercase() == camel.to_lowercase()))
        .map(|(_, v)| v)
    {
        return text(v).ok_or_else(|| anyhow!("« {} » : champ « {name} » vide ou non textuel", e.name));
    }
    if let Some(v) = ent["fields"].as_array().and_then(|fs| {
        fs.iter()
            .find(|x| x["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
    }) {
        return text(&v["value"]).ok_or_else(|| anyhow!("« {} » : champ « {name} » vide", e.name));
    }
    bail!("« {} » ({}) n'a pas de champ « {name} »", e.name, e.kind)
}

fn kebab_to_camel(s: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in s.chars() {
        if c == '-' || c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// Le code TOTP du moment : une URI `otpauth://` ou un secret base32 nu,
/// comme l'interface web les enregistre.
pub fn totp_now(secret: &str) -> Result<String> {
    use totp_rs::{Algorithm, Secret, TOTP};
    let totp = if secret.starts_with("otpauth://") {
        TOTP::from_url_unchecked(secret).map_err(|e| anyhow!("URI TOTP invalide : {e}"))?
    } else {
        let bytes = Secret::Encoded(secret.replace([' ', '-'], "").to_uppercase())
            .to_bytes()
            .map_err(|e| anyhow!("secret TOTP invalide : {e:?}"))?;
        TOTP::new_unchecked(Algorithm::SHA1, 6, 1, 30, bytes, None, String::new())
    };
    totp.generate_current().map_err(|e| anyhow!("horloge : {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(payload: Value) -> Entry {
        let kind = payload["kind"].as_str().unwrap().to_string();
        Entry {
            vault: 0,
            id: Uuid::nil(),
            name: "X".into(),
            kind,
            payload,
        }
    }

    #[test]
    fn fields_by_usual_name_by_camel_case_and_custom_fields() {
        let login = entry(json!({ "kind": "login", "login": {
            "name": "GitHub", "username": "alice", "password": "s3cret",
            "uris": [{ "uri": "https://github.com" }], "totp": "JBSWY3DPEHPK3PXP",
            "fields": [{ "name": "Recovery", "value": "abcd", "type": "hidden" }]
        }}));
        assert_eq!(field(&login, "password").unwrap(), "s3cret");
        assert_eq!(field(&login, "user").unwrap(), "alice");
        assert_eq!(field(&login, "uri").unwrap(), "https://github.com");
        assert_eq!(field(&login, "recovery").unwrap(), "abcd");
        assert_eq!(field(&login, "totp").unwrap().len(), 6);
        assert!(field(&login, "nope").is_err());

        let aws = entry(json!({ "kind": "aws", "aws": { "accessKeyId": "AKIA", "secretAccessKey": "wJal" } }));
        assert_eq!(field(&aws, "access-key-id").unwrap(), "AKIA");
        assert_eq!(field(&aws, default_field("aws").unwrap()).unwrap(), "wJal");

        let host = entry(
            json!({ "kind": "host", "host": { "label": "db", "username": "root" }, "secrets": { "password": "pw" } }),
        );
        assert_eq!(field(&host, "password").unwrap(), "pw");
        let api = entry(json!({ "kind": "api-key", "apiKey": { "keyId": "pk", "secret": "sk" } }));
        assert_eq!(field(&api, "key-id").unwrap(), "pk");
        assert_eq!(field(&api, default_field("api-key").unwrap()).unwrap(), "sk");
    }

    #[test]
    fn totp_from_base32_or_otpauth() {
        let a = totp_now("JBSWY3DPEHPK3PXP").unwrap();
        let b = totp_now("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=x").unwrap();
        assert_eq!(a, b);
    }
}
