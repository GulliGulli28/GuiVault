//! Fabrique un coffre local pour les tests de bout en bout de l'extension
//! (`web/extension/e2e/native.spec.ts`) : la vraie crypto, un identifiant
//! pour `http://coffre.test`.
//!
//! ```text
//! cargo run -p guivault-local --example make_coffre -- <dossier> <mot de passe>
//! ```
use guivault_crypto::{SymmetricKey, create_account, seal_item, seal_vault_name, wrap_vault_key};
use guivault_local::{LocalAccount, LocalVault, NewCoffre};
use guivault_protocol::{CreateVaultRequest, PutItemRequest};
use uuid::Uuid;

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(dir), Some(password)) = (args.next(), args.next()) else {
        eprintln!("usage : make_coffre <dossier> <mot de passe>");
        std::process::exit(2);
    };
    let (material, account) = create_account(&password).expect("compte");
    let vault_id = Uuid::new_v4();
    let key = SymmetricKey::random();
    let vs = vault_id.to_string();
    let store = LocalVault::create(
        &dir,
        NewCoffre {
            account: LocalAccount::from(&material),
            personal: CreateVaultRequest {
                id: vault_id,
                name_enc: seal_vault_name(&key, &vs, "Personnel").expect("nom"),
                wrapped_vault_key: wrap_vault_key(&account.keypair, &account.keypair.public, &vs, &key).expect("clé"),
            },
        },
    )
    .expect("coffre");
    let id = Uuid::new_v4();
    let payload = serde_json::json!({
        "kind": "login",
        "login": {
            "id": id, "name": "Banque locale", "groupId": null, "tags": [],
            "username": "alice@coffre", "password": "mdp-coffre-local",
            "uris": [{ "uri": "http://coffre.test", "match": null }],
            "totp": null, "passkeys": [], "passwordHistory": []
        }
    });
    let ciphertext = seal_item(&key, &vs, &id.to_string(), "login", payload.to_string().as_bytes()).expect("item");
    store
        .put_item(
            vault_id,
            id,
            PutItemRequest {
                item_type: "login".into(),
                ciphertext,
                base_revision: None,
                manifest: None,
            },
        )
        .expect("écriture");
    println!("{dir}");
}
