//! Le contenu en clair des items « secrets » d'un vault — ce que l'interface
//! web (`web/src/lib/types.ts`) écrit et ce que Guiterm lira le jour où il
//! les affichera. Le serveur ne voit jamais ces structures : elles voyagent
//! chiffrées sous la clé du vault (`guivault-crypto::seal_item`), avec
//! `kind` pour `item_type`.
//!
//! Même convention que les entités de Guiterm
//! (`termius_core::guivault::entity::Payload`) : JSON en camelCase, enveloppe
//! `{ "kind": "login", "login": { … } }`, `groupId` pour le dossier (un
//! item `group` de Guiterm), `tags`. Modelé sur les types de Bitwarden pour
//! que l'import et l'export soient sans perte.
//!
//! **Tolérance** : tout champ absent prend sa valeur par défaut, tout champ
//! inconnu est conservé dans `extra` et réécrit tel quel — un client ancien
//! ne perd pas ce qu'un client récent a ajouté. Les fixtures de
//! `tests/web-items.json` sont écrites par les tests du web
//! (`GUIVAULT_WRITE_VECTORS=1 npx vitest run`) : c'est ce qui tient les deux
//! implémentations ensemble.
//!
//! Intégration Guiterm (voir `docs/ITEMS.md`) : ajouter à son `Payload` les
//! variantes `Login`, `Note`, `Card`, `Identity` en déléguant à ces types,
//! ou déserialiser d'abord ici pour tout `kind` qu'il ne connaît pas.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

pub const TYPE_LOGIN: &str = "login";
pub const TYPE_NOTE: &str = "note";
pub const TYPE_CARD: &str = "card";
pub const TYPE_IDENTITY: &str = "identity";

/// Un champ libre ajouté à n'importe quel secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub r#type: FieldType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
    #[default]
    Text,
    Hidden,
    Boolean,
}

/// Comment une URI enregistrée se compare à celle d'une page (même sens
/// que Bitwarden).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UriMatch {
    Domain,
    Host,
    StartsWith,
    Exact,
    Regex,
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginUri {
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub r#match: Option<UriMatch>,
}

/// Une passkey (WebAuthn) rattachée à un identifiant — le format
/// `fido2Credentials` de Bitwarden. `key_value` est la clé privée (PKCS#8,
/// base64) : c'est le secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passkey {
    pub credential_id: String,
    #[serde(default)]
    pub key_type: String,
    #[serde(default)]
    pub key_algorithm: String,
    #[serde(default)]
    pub key_curve: String,
    pub key_value: String,
    pub rp_id: String,
    #[serde(default)]
    pub rp_name: Option<String>,
    #[serde(default)]
    pub user_handle: String,
    #[serde(default)]
    pub user_name: Option<String>,
    #[serde(default)]
    pub user_display_name: Option<String>,
    #[serde(default)]
    pub counter: u64,
    #[serde(default)]
    pub discoverable: bool,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordHistoryEntry {
    pub password: String,
    pub changed_at: String,
}

/// Ce que tous les secrets ont en commun. Aplati dans chaque type (`serde
/// flatten`) : le JSON n'a pas de sous-objet `base`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretBase {
    pub id: Uuid,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub group_id: Option<Uuid>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<CustomField>>,
    /// Les champs que cette version ne connaît pas, conservés tels quels.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    #[serde(flatten)]
    pub base: SecretBase,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub uris: Vec<LoginUri>,
    /// Une URI `otpauth://` ou un secret base32 nu.
    #[serde(default)]
    pub totp: Option<String>,
    #[serde(default)]
    pub passkeys: Vec<Passkey>,
    #[serde(default)]
    pub password_history: Vec<PasswordHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(flatten)]
    pub base: SecretBase,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    #[serde(flatten)]
    pub base: SecretBase,
    #[serde(default)]
    pub cardholder_name: String,
    #[serde(default)]
    pub brand: String,
    #[serde(default)]
    pub number: String,
    #[serde(default)]
    pub exp_month: String,
    #[serde(default)]
    pub exp_year: String,
    #[serde(default)]
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    #[serde(flatten)]
    pub base: SecretBase,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub middle_name: String,
    #[serde(default)]
    pub last_name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub company: String,
    #[serde(default)]
    pub ssn: String,
    #[serde(default)]
    pub passport_number: String,
    #[serde(default)]
    pub license_number: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub address1: String,
    #[serde(default)]
    pub address2: String,
    #[serde(default)]
    pub address3: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub postal_code: String,
    #[serde(default)]
    pub country: String,
}

/// L'enveloppe d'un item secret : `kind` est l'`item_type` du serveur.
// `large_enum_variant` : une identité pèse plus qu'une note, et alors ?
// Ces valeurs vivent le temps d'un chiffrement, jamais en tableau.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SecretItem {
    Login { login: Login },
    Note { note: Note },
    Card { card: Card },
    Identity { identity: Identity },
}

impl SecretItem {
    pub fn item_type(&self) -> &'static str {
        match self {
            SecretItem::Login { .. } => TYPE_LOGIN,
            SecretItem::Note { .. } => TYPE_NOTE,
            SecretItem::Card { .. } => TYPE_CARD,
            SecretItem::Identity { .. } => TYPE_IDENTITY,
        }
    }

    pub fn is_secret_type(item_type: &str) -> bool {
        matches!(item_type, TYPE_LOGIN | TYPE_NOTE | TYPE_CARD | TYPE_IDENTITY)
    }

    pub fn base(&self) -> &SecretBase {
        match self {
            SecretItem::Login { login } => &login.base,
            SecretItem::Note { note } => &note.base,
            SecretItem::Card { card } => &card.base,
            SecretItem::Identity { identity } => &identity.base,
        }
    }

    /// L'identité d'un payload : l'id de l'entité, qui doit être celui de
    /// l'item (même règle que les entités Guiterm).
    pub fn id(&self) -> Uuid {
        self.base().id
    }

    pub fn name(&self) -> &str {
        &self.base().name
    }

    pub fn from_json(json: &[u8]) -> serde_json::Result<Self> {
        serde_json::from_slice(json)
    }

    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_fields_survive_a_roundtrip() {
        let json = r#"{"kind":"login","login":{"id":"11111111-1111-4111-8111-111111111111","name":"x","groupId":null,"tags":[],"username":"u","password":"p","uris":[],"totp":null,"passkeys":[],"passwordHistory":[],"futureField":{"a":1}}}"#;
        let item = SecretItem::from_json(json.as_bytes()).unwrap();
        assert_eq!(item.item_type(), "login");
        assert_eq!(item.base().extra["futureField"], serde_json::json!({"a": 1}));
        let again = SecretItem::from_json(item.to_json().unwrap().as_bytes()).unwrap();
        assert_eq!(item, again);
    }

    #[test]
    fn missing_fields_take_defaults() {
        let item =
            SecretItem::from_json(br#"{"kind":"card","card":{"id":"11111111-1111-4111-8111-111111111111"}}"#).unwrap();
        let SecretItem::Card { card } = &item else { panic!() };
        assert_eq!(card.number, "");
        assert!(card.base.favorite.is_none());
        assert!(SecretItem::is_secret_type("note") && !SecretItem::is_secret_type("host"));
    }
}
