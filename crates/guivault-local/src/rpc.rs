//! Le coffre local vu par l'interface web de l'app : une opération par
//! méthode d'`api.ts` (`web/src/lib/localHost.ts`), avec **les mêmes corps
//! JSON que l'API HTTP** — base64 compris. L'hôte (la commande Tauri) n'a
//! qu'à passer `op` et `args`, et rendre le résultat ou [`Error::body`].
//!
//! La liste des opérations est dans `ops.json`, lu par les tests des deux
//! côtés : une opération ajoutée ici sans l'être là-bas (ou l'inverse) casse
//! un test.
use crate::{Error, LocalVault, PasswordChange, Result};
use guivault_protocol::{
    CreateAttachmentRequest, CreateVaultRequest, DeleteItemRequest, HealthResponse, KdfParams, MoveAttachmentRequest,
    PROTOCOL_VERSION, PutItemRequest, PutManifestRequest, PutUserSettingsRequest, RegistrationMode, RenameVaultRequest,
    SyncResponse, b64,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Les opérations, dans l'ordre de `ops.json`.
pub const OPS: &[&str] = &[
    "health",
    "account",
    "changePassword",
    "me",
    "sync",
    "settings",
    "putSettings",
    "vault",
    "createVault",
    "renameVault",
    "deleteVault",
    "items",
    "putItem",
    "deleteItem",
    "manifest",
    "putManifest",
    "itemVersions",
    "vaultVersions",
    "trash",
    "purgeTrashItem",
    "emptyTrash",
    "attachments",
    "createAttachment",
    "putAttachmentChunk",
    "completeAttachment",
    "attachmentChunk",
    "deleteAttachment",
    "moveAttachment",
];

/// Des octets en base64, comme partout dans l'API.
#[derive(Serialize, Deserialize)]
struct Bytes(#[serde(with = "b64")] Vec<u8>);

/// `changePassword` : sans preuve de l'ancien mot de passe — il n'y a
/// personne à qui la donner, et qui peut écrire dans le dossier peut déjà
/// tout remplacer.
#[derive(Deserialize)]
struct ChangePasswordArgs {
    kdf: KdfParams,
    #[serde(with = "b64")]
    kdf_salt: Vec<u8>,
    #[serde(with = "b64")]
    protected_user_key: Vec<u8>,
}

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T> {
    let v = args.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| Error::bad_request("invalid_request", format!("{name} : {e}")))
}

fn json<T: Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|e| Error::new(500, "local_io", e.to_string()))
}

/// Exécute une opération sur le coffre. Une opération inconnue répond
/// `501 local_unsupported`, comme une méthode d'`api` que le transport local
/// n'a pas.
pub fn call(vault: &LocalVault, op: &str, args: &Value) -> Result<Value> {
    let v = || arg::<Uuid>(args, "vault");
    let id = || arg::<Uuid>(args, "id");
    match op {
        // Ce que le coffre offre, comme `GET /health` : l'interface y lit la
        // taille des pièces jointes, et que les liens, les relais du rapport
        // de santé et les passkeys n'existent pas ici.
        "health" => json(HealthResponse {
            status: "ok".into(),
            protocol_version: PROTOCOL_VERSION,
            server_version: format!("coffre local {}", env!("CARGO_PKG_VERSION")),
            registration: RegistrationMode::Closed,
            send_max_days: 0,
            health_lookups: false,
            max_attachment_bytes: vault.options().max_attachment_bytes,
            passkeys: false,
        }),
        "account" => json(vault.account()?),
        "changePassword" => {
            let a: ChangePasswordArgs = arg(args, "req")?;
            vault.change_password(PasswordChange {
                kdf: a.kdf,
                kdf_salt: a.kdf_salt,
                protected_user_key: a.protected_user_key,
            })?;
            Ok(Value::Null)
        }
        "me" => json(vault.profile()?),
        "sync" => json(SyncResponse {
            user: vault.profile()?,
            vaults: vault.vaults()?,
            invitations: Vec::new(),
            server_time: chrono::Utc::now(),
        }),
        "settings" => json(vault.settings()?),
        "putSettings" => json(vault.put_settings(arg::<PutUserSettingsRequest>(args, "req")?)?),
        "vault" => json(vault.vault(v()?)?),
        "createVault" => json(vault.create_vault(arg::<CreateVaultRequest>(args, "req")?)?),
        "renameVault" => json(vault.rename_vault(v()?, arg::<RenameVaultRequest>(args, "req")?)?),
        "deleteVault" => json(vault.delete_vault(v()?)?),
        "items" => json(vault.items(v()?, arg::<Option<i64>>(args, "since")?)?),
        "putItem" => json(vault.put_item(v()?, id()?, arg::<PutItemRequest>(args, "req")?)?.0),
        "deleteItem" => {
            let moved = arg::<Option<bool>>(args, "moved")?.unwrap_or(false);
            let req = arg::<Option<DeleteItemRequest>>(args, "req")?.unwrap_or_default();
            json(vault.delete_item(v()?, id()?, moved, req)?)
        }
        "manifest" => json(vault.manifest(v()?)?),
        "putManifest" => json(vault.put_manifest(v()?, arg::<PutManifestRequest>(args, "req")?)?),
        "itemVersions" => json(vault.item_versions(v()?, id()?)?),
        "vaultVersions" => json(vault.vault_versions(v()?)?),
        "trash" => json(vault.trash(v()?)?),
        "purgeTrashItem" => json(vault.purge(v()?, id()?)?),
        "emptyTrash" => json(vault.empty_trash(v()?)?),
        "attachments" => json(vault.attachments(v()?, arg::<Option<Uuid>>(args, "item")?)?),
        "createAttachment" => json(vault.create_attachment(v()?, arg::<CreateAttachmentRequest>(args, "req")?)?),
        "putAttachmentChunk" => {
            let bytes: Bytes = arg(args, "bytes")?;
            json(vault.put_chunk(v()?, id()?, arg(args, "index")?, &bytes.0)?)
        }
        "completeAttachment" => json(vault.complete_attachment(v()?, id()?)?),
        "attachmentChunk" => json(Bytes(vault.chunk(v()?, id()?, arg(args, "index")?)?)),
        "deleteAttachment" => json(vault.delete_attachment(v()?, id()?)?),
        "moveAttachment" => json(vault.move_attachment(v()?, id()?, arg::<MoveAttachmentRequest>(args, "req")?)?),
        _ => Err(Error::new(
            501,
            "local_unsupported",
            format!("« {op} » n'existe pas dans un coffre local"),
        )),
    }
}
