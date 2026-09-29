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
    // Enveloppes de la vault key pour le compte : format 2, d'un expéditeur
    // fixe, et format 1 (boîte scellée anonyme, encore lisible).
    let sender_private = PrivateKey::from([5u8; 32]);
    let sender = KeyPair {
        public: sender_private.public_key(),
        private: sender_private,
    };
    let wrapped = wrap_vault_key(&sender, &account.keypair.public, vault_id, &vault_key).unwrap();
    let wrapped_v1 = seal_for(&account.keypair.public, vault_key.as_bytes()).unwrap();
    // La même clé remise à un contact d'urgence (autre contexte).
    let emergency = wrap_emergency_key(&sender, &account.keypair.public, vault_id, &vault_key).unwrap();

    // Un lien de partage, sans puis avec mot de passe.
    let send_secret: [u8; SEND_SECRET_LEN] = *b"link-secret-16by";
    let send_id = "99999999-8888-7777-6666-555555555555";
    let send_plain = r#"{"v":1,"kind":"text","text":"bonjour"}"#;
    let open_keys = send_keys(&send_secret, None).unwrap();
    let send_blob = seal_send(&open_keys, send_id, send_plain.as_bytes()).unwrap();
    let send_salt: [u8; 16] = *b"send-salt-16byte";
    let send_password = "mot de passe — ü";
    let password_key = send_password_key(send_password, &send_salt, kdf).unwrap();
    let locked_keys = send_keys(&send_secret, Some(&password_key)).unwrap();
    let locked_blob = seal_send(&locked_keys, send_id, send_plain.as_bytes()).unwrap();
    let owner_key = SymmetricKey::from_bytes([3u8; 32]);
    let owner_blob = seal_send_owner(&owner_key, send_id, br#"{"name":"Wi-Fi"}"#).unwrap();
    // Le fichier d'un lien, sous la clé du lien protégé par mot de passe.
    let send_chunks: Vec<_> = [(0u32, false, "début"), (1, true, "fin")]
        .iter()
        .map(|(i, last, text)| {
            json!({ "index": i, "last": last, "plaintext": text,
                    "blob": hex(&seal_send_chunk(&locked_keys, send_id, *i, *last, text.as_bytes()).unwrap()) })
        })
        .collect();

    // Le manifeste du vault de `item` : cet item, et un second dont seule
    // l'empreinte compte.
    let other_id = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    let manifest = Manifest::of(3, [(item_id, item.as_slice()), (other_id, b"abc".as_slice())]);
    let manifest_blob = seal_manifest(&vault_key, vault_id, &manifest).unwrap();

    // Une pièce jointe : des morceaux courts à plusieurs places, le dernier
    // marqué — c'est l'AAD (id, index, dernier) qui est vérifié de l'autre côté.
    let attachment_key = SymmetricKey::from_bytes([4u8; 32]);
    let attachment_id = "cccccccc-dddd-eeee-ffff-000000000000";
    let attachment_chunks: Vec<_> = [(0u32, false, "morceau 0"), (1, false, "morceau 1"), (2, true, "fin")]
        .iter()
        .map(|(i, last, text)| {
            json!({
                "index": i, "last": last, "plaintext": text,
                "blob": hex(&seal_attachment_chunk(&attachment_key, attachment_id, *i, *last, text.as_bytes()).unwrap()),
            })
        })
        .collect();

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
            "wrapped_vault_key_v1": hex(&wrapped_v1),
            "wrap_vault_id": vault_id,
            "wrap_sender_public": hex(sender.public.as_bytes()),
            "emergency_key": hex(&emergency),
        },
        "send": {
            "secret": hex(&send_secret),
            "id": send_id,
            "plaintext": send_plain,
            "access_key": hex(open_keys.access.as_bytes()),
            "access_hash": hex(&token_hash(open_keys.access.as_bytes())),
            "blob": hex(&send_blob),
            "password": send_password,
            "password_salt": hex(&send_salt),
            "password_kdf": kdf,
            "locked_access_key": hex(locked_keys.access.as_bytes()),
            "locked_blob": hex(&locked_blob),
            "owner_key": hex(owner_key.as_bytes()),
            "owner_plaintext": r#"{"name":"Wi-Fi"}"#,
            "owner_blob": hex(&owner_blob),
            "file_chunks": send_chunks,
        },
        "item": {
            "vault_key": hex(vault_key.as_bytes()),
            "vault_id": vault_id, "item_id": item_id, "item_type": "host",
            "plaintext": r#"{"kind":"host"}"#, "blob": hex(&item),
            "name": "Prod bancaire", "name_blob": hex(&name),
        },
        "attachment": {
            "key": hex(attachment_key.as_bytes()),
            "id": attachment_id,
            "chunks": attachment_chunks,
            "sealed_size_of_3_mib_plus_1": attachment_sealed_size(3 * ATTACHMENT_CHUNK as u64 + 1),
        },
        "manifest": {
            "vault_key": hex(vault_key.as_bytes()),
            "vault_id": vault_id,
            "counter": manifest.counter,
            "items": manifest.items,
            "blob": hex(&manifest_blob),
            "item_id": item_id,
            "item_blob": hex(&item),
            "other_id": other_id,
            "other_ciphertext": hex(b"abc"),
        },
    });
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}
