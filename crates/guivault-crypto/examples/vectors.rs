//! Vecteurs d'interopérabilité pour le client web (`web/src/lib/crypto.ts`).
//! Tout ce qui est aléatoire est fixé ici pour que le fichier soit stable ;
//! les blobs, eux, changent à chaque génération (nonce aléatoire), ce qui
//! est sans importance : le test JS les *ouvre*, il ne les compare pas.
//!
//!     cargo run -p guivault-crypto --example vectors > web/src/lib/crypto.vectors.json
use guivault_crypto::*;
use serde_json::json;

fn hex(b: &[u8]) -> String {
    hex::encode(b)
}

fn main() {
    // Paramètres légers : on vérifie la mécanique, pas la résistance.
    let kdf = KdfParams {
        m_cost: 19_456,
        t_cost: 2,
        p_cost: 1,
    };
    let password = "correct horse battery staple — é";
    let salt: [u8; 16] = *b"0123456789abcdef";
    let master = MasterKey::derive(password, &salt, kdf).unwrap();

    let key = SymmetricKey::from_bytes([7u8; 32]);
    let sealed = seal(&key, b"hello, world", b"ctx-a").unwrap();

    let private = PrivateKey::from([42u8; 32]);
    let public = private.public_key();
    let boxed = seal_for(&public, b"vault key bytes here 32 bytes!!!").unwrap();

    let (material, account) = create_account(password).unwrap();

    let vault_key = SymmetricKey::from_bytes([9u8; 32]);
    let vault_id = "11111111-2222-3333-4444-555555555555";
    let item_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let item = seal_item(&vault_key, vault_id, item_id, "host", br#"{"kind":"host"}"#).unwrap();
    let name = seal_vault_name(&vault_key, vault_id, "Prod bancaire").unwrap();
    let wrapped = wrap_vault_key(&account.keypair.public, &vault_key).unwrap();

    let v = json!({
        "kdf": {
            "password": password,
            "salt": hex(&salt),
            "params": kdf,
            "stretched_key": hex(master.stretched_key().as_bytes()),
            "auth_key": hex(master.auth_key().as_bytes()),
        },
        "seal": { "key": hex(key.as_bytes()), "aad": "ctx-a", "plaintext": "hello, world", "blob": hex(&sealed) },
        "sealed_box": {
            "private": hex(&private.to_bytes()),
            "public": hex(public.as_bytes()),
            "fingerprint": fingerprint(&public),
            "plaintext": "vault key bytes here 32 bytes!!!",
            "blob": hex(&boxed),
        },
        "account": {
            "password": password,
            "kdf": material.kdf,
            "kdf_salt": hex(&material.kdf_salt),
            "auth_key": hex(&material.auth_key),
            "protected_user_key": hex(&material.protected_user_key),
            "public_key": hex(&material.public_key),
            "protected_private_key": hex(&material.protected_private_key),
            "user_key": hex(account.user_key.as_bytes()),
            "private_key": hex(&account.keypair.private.to_bytes()),
            "wrapped_vault_key": hex(&wrapped),
        },
        "item": {
            "vault_key": hex(vault_key.as_bytes()),
            "vault_id": vault_id, "item_id": item_id, "item_type": "host",
            "plaintext": r#"{"kind":"host"}"#, "blob": hex(&item),
            "name": "Prod bancaire", "name_blob": hex(&name),
        },
    });
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}
