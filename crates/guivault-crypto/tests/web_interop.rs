//! Le client web (`web/src/lib/crypto.ts`) produit-il ce que ce crate lit ?
//! `web-vectors.json` est écrit par `GUIVAULT_WRITE_VECTORS=1 npx vitest run`
//! dans `web/` ; l'autre sens (Rust → web) est `examples/vectors.rs`.
use guivault_crypto::*;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("web-vectors.json")).unwrap()
}

fn h(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap()).unwrap()
}

#[test]
fn kdf_matches_browser() {
    let v = &vectors()["kdf"];
    let params: KdfParams = serde_json::from_value(v["params"].clone()).unwrap();
    let master = MasterKey::derive(v["password"].as_str().unwrap(), &h(&v["salt"]), params).unwrap();
    assert_eq!(master.stretched_key().as_bytes().as_slice(), h(&v["stretched_key"]));
    assert_eq!(master.auth_key().as_bytes().as_slice(), h(&v["auth_key"]));
}

#[test]
fn opens_browser_envelope() {
    let v = &vectors()["seal"];
    let key = SymmetricKey::from_slice(&h(&v["key"])).unwrap();
    let plain = open(&key, &h(&v["blob"]), v["aad"].as_str().unwrap().as_bytes()).unwrap();
    assert_eq!(plain, v["plaintext"].as_str().unwrap().as_bytes());
}

#[test]
fn opens_browser_sealed_box() {
    let v = &vectors()["sealed_box"];
    let private = PrivateKey::try_from(h(&v["private"]).as_slice()).unwrap();
    assert_eq!(private.public_key().as_bytes().as_slice(), h(&v["public"]));
    assert_eq!(fingerprint(&private.public_key()), v["fingerprint"].as_str().unwrap());
    let plain = unseal(&private, &h(&v["blob"])).unwrap();
    assert_eq!(plain, v["plaintext"].as_str().unwrap().as_bytes());
}

#[test]
fn opens_browser_vault_key_envelope() {
    let v = &vectors()["vault_envelope"];
    let private = PrivateKey::try_from(h(&v["recipient_private"]).as_slice()).unwrap();
    let account = UnlockedAccount {
        user_key: SymmetricKey::random(),
        keypair: KeyPair {
            public: private.public_key(),
            private,
        },
    };
    let vault_id = v["vault_id"].as_str().unwrap();
    let opened = unwrap_vault_key(&account, vault_id, &h(&v["blob"])).unwrap();
    assert_eq!(opened.key.as_bytes().as_slice(), h(&v["vault_key"]));
    assert_eq!(opened.sender.unwrap().as_bytes().as_slice(), h(&v["sender_public"]));
    assert!(unwrap_vault_key(&account, "autre-vault", &h(&v["blob"])).is_err());
}

#[test]
fn opens_browser_item_and_vault_name() {
    let v = &vectors()["item"];
    let key = SymmetricKey::from_slice(&h(&v["vault_key"])).unwrap();
    let vault_id = v["vault_id"].as_str().unwrap();
    let plain = open_item(
        &key,
        vault_id,
        v["item_id"].as_str().unwrap(),
        v["item_type"].as_str().unwrap(),
        &h(&v["blob"]),
    )
    .unwrap();
    assert_eq!(plain, v["plaintext"].as_str().unwrap().as_bytes());
    assert_eq!(
        open_vault_name(&key, vault_id, &h(&v["name_blob"])).unwrap(),
        v["name"].as_str().unwrap()
    );
}

#[test]
fn opens_and_verifies_browser_manifest() {
    let v = &vectors()["manifest"];
    let key = SymmetricKey::from_slice(&h(&v["vault_key"])).unwrap();
    let vault_id = v["vault_id"].as_str().unwrap();
    let blob = h(&v["blob"]);
    let m = open_manifest(&key, vault_id, &blob).unwrap();
    let counter = v["counter"].as_i64().unwrap();
    assert_eq!(m.counter, counter);
    let items: std::collections::BTreeMap<String, String> = serde_json::from_value(v["items"].clone()).unwrap();
    assert_eq!(m.items, items);
    // Les empreintes du navigateur sont celles d'ici.
    let (item_id, item_blob) = (v["item_id"].as_str().unwrap(), h(&v["item_blob"]));
    let (other_id, other) = (v["other_id"].as_str().unwrap(), h(&v["other_ciphertext"]));
    assert_eq!(m.items[item_id], item_digest(&item_blob));
    assert_eq!(m.items[other_id], item_digest(&other));
    let served = [(item_id, item_blob.as_slice()), (other_id, other.as_slice())];
    let ok = verify_manifest(&key, vault_id, Some((counter, &blob)), served, Some(counter));
    assert!(ok.problems.is_empty(), "{:?}", ok.problems);
    // Et un item retenu se voit.
    let short = verify_manifest(&key, vault_id, Some((counter, &blob)), [served[0]], None);
    assert_eq!(
        short.problems,
        vec![ManifestProblem::Withheld {
            item_id: other_id.to_string()
        }]
    );
    assert!(open_manifest(&key, "autre-vault", &blob).is_err());
}

#[test]
fn opens_browser_attachment_chunks() {
    let v = &vectors()["attachment"];
    let key = SymmetricKey::from_slice(&h(&v["key"])).unwrap();
    let id = v["id"].as_str().unwrap();
    let chunks = v["chunks"].as_array().unwrap();
    for c in chunks {
        let (index, last) = (c["index"].as_u64().unwrap() as u32, c["last"].as_bool().unwrap());
        let plain = open_attachment_chunk(&key, id, index, last, &h(&c["blob"])).unwrap();
        assert_eq!(plain, c["plaintext"].as_str().unwrap().as_bytes());
        // Ailleurs, ou pas à sa place : refusé.
        assert!(open_attachment_chunk(&key, id, index + 1, last, &h(&c["blob"])).is_err());
        assert!(open_attachment_chunk(&key, id, index, !last, &h(&c["blob"])).is_err());
    }
    // Le fichier entier, par les morceaux dans l'ordre.
    let blobs: Vec<Vec<u8>> = chunks.iter().map(|c| h(&c["blob"])).collect();
    let whole: String = chunks.iter().map(|c| c["plaintext"].as_str().unwrap()).collect();
    assert_eq!(open_attachment(&key, id, &blobs).unwrap(), whole.as_bytes());
}

#[test]
fn opens_browser_emergency_envelope() {
    let v = &vectors()["vault_envelope"];
    let private = PrivateKey::try_from(h(&v["recipient_private"]).as_slice()).unwrap();
    let account = UnlockedAccount {
        user_key: SymmetricKey::random(),
        keypair: KeyPair {
            public: private.public_key(),
            private,
        },
    };
    let vault_id = v["vault_id"].as_str().unwrap();
    let opened = unwrap_emergency_key(&account, vault_id, &h(&v["emergency_blob"])).unwrap();
    assert_eq!(opened.key.as_bytes().as_slice(), h(&v["vault_key"]));
    assert_eq!(opened.sender.unwrap().as_bytes().as_slice(), h(&v["sender_public"]));
    assert!(unwrap_vault_key(&account, vault_id, &h(&v["emergency_blob"])).is_err());
}

#[test]
fn opens_browser_send_link() {
    let v = &vectors()["send"];
    let id = v["id"].as_str().unwrap();
    let plain = v["plaintext"].as_str().unwrap().as_bytes();
    let keys = send_keys(&h(&v["secret"]), None).unwrap();
    assert_eq!(token_hash(keys.access.as_bytes()).as_slice(), h(&v["access_hash"]));
    assert_eq!(open_send(&keys, id, &h(&v["blob"])).unwrap(), plain);
    let params: KdfParams = serde_json::from_value(v["password_kdf"].clone()).unwrap();
    let pw = send_password_key(v["password"].as_str().unwrap(), &h(&v["password_salt"]), params).unwrap();
    let locked = send_keys(&h(&v["secret"]), Some(&pw)).unwrap();
    assert_eq!(
        token_hash(locked.access.as_bytes()).as_slice(),
        h(&v["locked_access_hash"])
    );
    assert_eq!(open_send(&locked, id, &h(&v["locked_blob"])).unwrap(), plain);
    let owner_key = SymmetricKey::from_slice(&h(&v["owner_key"])).unwrap();
    assert_eq!(
        open_send_owner(&owner_key, id, &h(&v["owner_blob"])).unwrap(),
        v["owner_plaintext"].as_str().unwrap().as_bytes()
    );
}
