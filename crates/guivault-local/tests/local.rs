//! Le coffre local avec de vrais clients : la crypto de `guivault-crypto`
//! des deux côtés du fichier, comme `tests/api.rs` du serveur.
use guivault_crypto::{
    AccountMaterial, KeyPair, Manifest, PrivateKey, SymmetricKey, UnlockedAccount, create_account, open_attachment,
    open_item, open_manifest, prepare_login, rekey_account, seal_attachment, seal_item, seal_manifest,
    seal_user_settings, seal_vault_name, unlock_account, unwrap_vault_key, wrap_vault_key,
};
use guivault_local::{Error, LocalAccount, LocalVault, NewCoffre, Options, PasswordChange};
use guivault_protocol::{
    CreateAttachmentRequest, CreateVaultRequest, DeleteItemRequest, ManifestWrite, MoveAttachmentRequest,
    PutItemRequest, PutManifestRequest, PutUserSettingsRequest, RenameVaultRequest, VaultKind,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use uuid::Uuid;

const PASSWORD: &str = "cheval correct pile agrafe";

/// Un dossier jetable, effacé à la fin du test.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("guivault-local-{}", Uuid::new_v4())))
    }

    fn coffre(&self) -> PathBuf {
        self.0.join("Mon coffre.guivault")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Argon2id à 64 MiB est lent sans optimisations : un seul compte pour tout
/// le fichier, reconstruit à la demande.
fn shared_account() -> (AccountMaterial, UnlockedAccount) {
    static ACCOUNT: OnceLock<(AccountMaterial, [u8; 32], [u8; 32])> = OnceLock::new();
    let (material, user_key, private) = ACCOUNT.get_or_init(|| {
        let (material, unlocked) = create_account(PASSWORD).unwrap();
        (
            material,
            *unlocked.user_key.as_bytes(),
            unlocked.keypair.private.to_bytes(),
        )
    });
    let private = PrivateKey::from(*private);
    let keypair = KeyPair {
        public: private.public_key(),
        private,
    };
    (
        material.clone(),
        UnlockedAccount {
            user_key: SymmetricKey::from_bytes(*user_key),
            keypair,
        },
    )
}

/// Un client : le compte déverrouillé et les clés des vaults qu'il a créés.
struct Client {
    account: UnlockedAccount,
    personal: Uuid,
    keys: std::collections::HashMap<Uuid, SymmetricKey>,
}

impl Client {
    fn vault_request(&mut self, name: &str) -> CreateVaultRequest {
        let id = Uuid::new_v4();
        let key = SymmetricKey::random();
        let req = CreateVaultRequest {
            id,
            name_enc: seal_vault_name(&key, &id.to_string(), name).unwrap(),
            wrapped_vault_key: wrap_vault_key(
                &self.account.keypair,
                &self.account.keypair.public,
                &id.to_string(),
                &key,
            )
            .unwrap(),
        };
        self.keys.insert(id, key);
        req
    }

    fn key(&self, vault: Uuid) -> &SymmetricKey {
        &self.keys[&vault]
    }

    fn seal(&self, vault: Uuid, item: Uuid, item_type: &str, text: &str) -> Vec<u8> {
        seal_item(
            self.key(vault),
            &vault.to_string(),
            &item.to_string(),
            item_type,
            text.as_bytes(),
        )
        .unwrap()
    }

    fn open(&self, vault: Uuid, item: Uuid, item_type: &str, blob: &[u8]) -> String {
        String::from_utf8(open_item(self.key(vault), &vault.to_string(), &item.to_string(), item_type, blob).unwrap())
            .unwrap()
    }

    fn put(&self, store: &LocalVault, vault: Uuid, item: Uuid, text: &str, base: Option<i64>) -> Result<i64, Error> {
        let req = PutItemRequest {
            item_type: "note".into(),
            ciphertext: self.seal(vault, item, "note", text),
            base_revision: base,
            manifest: None,
        };
        store.put_item(vault, item, req).map(|(i, _)| i.revision)
    }
}

fn new_coffre(dir: &Path) -> (LocalVault, Client) {
    new_coffre_with(dir, Options::default())
}

fn new_coffre_with(dir: &Path, options: Options) -> (LocalVault, Client) {
    let (material, account) = shared_account();
    let mut client = Client {
        account,
        personal: Uuid::nil(),
        keys: Default::default(),
    };
    let personal = client.vault_request("Personnel");
    client.personal = personal.id;
    let store = LocalVault::create_with(
        dir,
        NewCoffre {
            account: LocalAccount::from(&material),
            personal,
        },
        options,
    )
    .unwrap();
    (store, client)
}

#[test]
fn create_open_and_unlock_with_the_master_password() {
    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());

    // Un autre processus rouvre le dossier et déverrouille comme au login.
    let reopened = LocalVault::open(tmp.coffre()).unwrap();
    assert_eq!(reopened.id().unwrap(), store.id().unwrap());
    let a = reopened.account().unwrap();
    assert!(a.kdf.is_sane());
    let login = prepare_login(PASSWORD, &a.kdf_salt, a.kdf).unwrap();
    let unlocked = unlock_account(&login.stretched_key, &a.protected_user_key, &a.protected_private_key).unwrap();
    assert_eq!(unlocked.user_key.as_bytes(), client.account.user_key.as_bytes());

    // Le vault personnel s'ouvre avec la clé privée, et son nom aussi.
    let vaults = reopened.vaults().unwrap();
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0].kind, VaultKind::Personal);
    let key = unwrap_vault_key(&unlocked, &vaults[0].id.to_string(), &vaults[0].wrapped_vault_key).unwrap();
    assert_eq!(key.key.as_bytes(), client.key(client.personal).as_bytes());
    assert_eq!(
        guivault_crypto::open_vault_name(&key.key, &vaults[0].id.to_string(), &vaults[0].name_enc).unwrap(),
        "Personnel"
    );

    // Un mauvais mot de passe échoue au déverrouillage (tag AEAD).
    let wrong = prepare_login("pas le bon", &a.kdf_salt, a.kdf).unwrap();
    assert!(unlock_account(&wrong.stretched_key, &a.protected_user_key, &a.protected_private_key).is_err());

    // Le fichier ne contient rien en clair.
    let raw = std::fs::read_to_string(tmp.coffre().join("coffre.json")).unwrap();
    assert!(!raw.contains("Personnel"));
}

#[test]
fn create_refuses_an_existing_coffre_and_open_an_empty_folder() {
    let tmp = TempDir::new();
    let (_, mut client) = new_coffre(&tmp.coffre());
    let (material, _) = shared_account();
    let err = LocalVault::create(
        tmp.coffre(),
        NewCoffre {
            account: LocalAccount::from(&material),
            personal: client.vault_request("Encore"),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "local_exists");

    std::fs::create_dir_all(tmp.0.join("vide")).unwrap();
    let err = LocalVault::open(tmp.0.join("vide")).unwrap_err();
    assert_eq!((err.status, err.code), (404, "local_not_found"));
}

#[test]
fn create_refuses_weak_kdf_params() {
    let tmp = TempDir::new();
    let (material, mut client) = {
        let (m, account) = shared_account();
        (
            m,
            Client {
                account,
                personal: Uuid::nil(),
                keys: Default::default(),
            },
        )
    };
    let mut account = LocalAccount::from(&material);
    account.kdf.m_cost = 8;
    let err = LocalVault::create(
        tmp.coffre(),
        NewCoffre {
            account,
            personal: client.vault_request("Personnel"),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "invalid_kdf");
}

#[test]
fn items_follow_the_server_rules() {
    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());
    let v = client.personal;
    let id = Uuid::new_v4();

    let (item, created) = store
        .put_item(
            v,
            id,
            PutItemRequest {
                item_type: "note".into(),
                ciphertext: client.seal(v, id, "note", "v1"),
                base_revision: None,
                manifest: None,
            },
        )
        .unwrap();
    assert!(created);
    assert_eq!(item.revision, 1);
    assert_eq!(client.open(v, id, "note", &store.item(v, id).unwrap().ciphertext), "v1");

    // Créer par-dessus un item qui existe : conflit, avec l'item courant.
    let err = client.put(&store, v, id, "autre", None).unwrap_err();
    assert_eq!((err.status, err.code), (409, "revision_mismatch"));
    assert_eq!(err.body()["current"]["revision"], 1);

    let r2 = client.put(&store, v, id, "v2", Some(1)).unwrap();
    assert_eq!(r2, 2);
    // Écrire sur une révision périmée : conflit.
    assert_eq!(
        client.put(&store, v, id, "v2bis", Some(1)).unwrap_err().code,
        "revision_mismatch"
    );

    // Le type est dans l'AAD : il ne change pas.
    let err = store
        .put_item(
            v,
            id,
            PutItemRequest {
                item_type: "login".into(),
                ciphertext: client.seal(v, id, "login", "{}"),
                base_revision: Some(2),
                manifest: None,
            },
        )
        .unwrap_err();
    assert_eq!(err.code, "item_type_changed");

    // L'historique garde la version remplacée.
    let versions = store.item_versions(v, id).unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(client.open(v, id, "note", &versions[0].ciphertext), "v1");

    // Suppression : pierre tombale vue par `since`, absente de la liste.
    store.delete_item(v, id, false, DeleteItemRequest::default()).unwrap();
    assert!(store.items(v, None).unwrap().items.is_empty());
    let since = store.items(v, Some(2)).unwrap();
    assert_eq!(since.items.len(), 1);
    assert!(since.items[0].deleted && since.items[0].ciphertext.is_empty());
    assert_eq!(since.revision, 3);
    assert_eq!(store.item(v, id).unwrap_err().code, "not_found");
    assert_eq!(
        store
            .delete_item(v, id, false, DeleteItemRequest::default())
            .unwrap_err()
            .code,
        "not_found"
    );

    // La corbeille rend la dernière version ; la renvoyer telle quelle la restaure.
    let trash = store.trash(v).unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(client.open(v, id, "note", &trash[0].ciphertext), "v2");
    let (restored, created) = store
        .put_item(
            v,
            id,
            PutItemRequest {
                item_type: trash[0].item_type.clone(),
                ciphertext: trash[0].ciphertext.clone(),
                base_revision: None,
                manifest: None,
            },
        )
        .unwrap();
    assert!(created);
    assert_eq!(restored.created_at, item.created_at);
    assert!(store.trash(v).unwrap().is_empty());
}

#[test]
fn history_is_capped_and_a_move_skips_the_trash() {
    let tmp = TempDir::new();
    let options = Options {
        item_history: 3,
        ..Options::default()
    };
    let (store, client) = new_coffre_with(&tmp.coffre(), options);
    let v = client.personal;
    let id = Uuid::new_v4();
    let mut rev = client.put(&store, v, id, "0", None).unwrap();
    for n in 1..=5 {
        rev = client.put(&store, v, id, &n.to_string(), Some(rev)).unwrap();
    }
    let versions = store.item_versions(v, id).unwrap();
    let texts: Vec<String> = versions
        .iter()
        .map(|ver| client.open(v, id, "note", &ver.ciphertext))
        .collect();
    assert_eq!(texts, ["4", "3", "2"]);

    let moved = Uuid::new_v4();
    client.put(&store, v, moved, "parti", None).unwrap();
    store.delete_item(v, moved, true, DeleteItemRequest::default()).unwrap();
    assert!(store.trash(v).unwrap().is_empty());
}

#[test]
fn trash_purge_and_empty() {
    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());
    let v = client.personal;
    let (a, b, live) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    for id in [a, b, live] {
        client.put(&store, v, id, "x", None).unwrap();
    }
    store.delete_item(v, a, false, DeleteItemRequest::default()).unwrap();
    store.delete_item(v, b, false, DeleteItemRequest::default()).unwrap();
    assert_eq!(store.trash(v).unwrap().len(), 2);

    assert_eq!(store.purge(v, live).unwrap_err().code, "not_found");
    store.purge(v, a).unwrap();
    assert_eq!(store.purge(v, a).unwrap_err().code, "not_found");
    assert_eq!(store.trash(v).unwrap().len(), 1);
    store.empty_trash(v).unwrap();
    assert!(store.trash(v).unwrap().is_empty());
}

#[test]
fn the_manifest_is_required_once_created() {
    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());
    let v = client.personal;
    let vs = v.to_string();
    let key = client.key(v);
    let id = Uuid::new_v4();
    let rev = client.put(&store, v, id, "avant", None).unwrap();
    let ct = store.item(v, id).unwrap().ciphertext;

    // Créer le manifeste : sur la révision courante du vault.
    let first = Manifest::of(1, [(id.to_string().as_str(), ct.as_slice())]);
    let blob = seal_manifest(key, &vs, &first).unwrap();
    let stale = store.put_manifest(
        v,
        PutManifestRequest {
            ciphertext: blob.clone(),
            base_revision: 0,
            vault_revision: rev - 1,
        },
    );
    assert_eq!(stale.unwrap_err().code, "revision_mismatch");
    let m = store
        .put_manifest(
            v,
            PutManifestRequest {
                ciphertext: blob,
                base_revision: 0,
                vault_revision: rev,
            },
        )
        .unwrap();
    assert_eq!(m.revision, 1);

    // Désormais, une écriture sans manifeste est refusée.
    // (La création du manifeste a fait monter le vault, pas l'item : toujours 1.)
    assert_eq!(
        client.put(&store, v, id, "sans", Some(1)).unwrap_err().code,
        "manifest_required"
    );

    // Avec un manifeste sur une base périmée : conflit, avec le courant.
    let next_ct = client.seal(v, id, "note", "après");
    let mut next = first.next(m.revision);
    next.put(&id.to_string(), &next_ct);
    let write = |base| PutItemRequest {
        item_type: "note".into(),
        ciphertext: next_ct.clone(),
        base_revision: Some(1),
        manifest: Some(ManifestWrite {
            ciphertext: seal_manifest(key, &vs, &next).unwrap(),
            base_revision: base,
        }),
    };
    let err = store.put_item(v, id, write(0)).unwrap_err();
    assert_eq!(err.code, "manifest_conflict");
    assert_eq!(err.body()["current"]["revision"], 1);
    store.put_item(v, id, write(1)).unwrap();

    let page = store.items(v, None).unwrap();
    let served = page.manifest.unwrap();
    assert_eq!(served.revision, 2);
    let opened = open_manifest(key, &vs, &served.ciphertext).unwrap();
    assert_eq!(opened, next);

    // Supprimer aussi demande le manifeste.
    assert_eq!(
        store
            .delete_item(v, id, false, DeleteItemRequest::default())
            .unwrap_err()
            .code,
        "manifest_required"
    );
}

#[test]
fn two_writers_on_the_same_coffre() {
    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());
    let v = client.personal;
    let id = Uuid::new_v4();
    let rev = client.put(&store, v, id, "base", None).unwrap();

    // Deux poignées, comme l'app et `gv` : le second écrivain perd.
    let other = LocalVault::open(tmp.coffre()).unwrap();
    client.put(&store, v, id, "app", Some(rev)).unwrap();
    let err = client.put(&other, v, id, "gv", Some(rev)).unwrap_err();
    assert_eq!(err.code, "revision_mismatch");

    // Écritures simultanées depuis plusieurs fils : le verrou les sérialise,
    // aucune ne se perd et deux ne partagent jamais une révision.
    let client = std::sync::Arc::new(client);
    let handles: Vec<_> = (0..8)
        .map(|n| {
            let (client, dir) = (client.clone(), tmp.coffre());
            std::thread::spawn(move || {
                let store = LocalVault::open(dir).unwrap();
                (0..5)
                    .map(|k| {
                        client
                            .put(&store, v, Uuid::new_v4(), &format!("{n}-{k}"), None)
                            .unwrap()
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let mut revisions: Vec<i64> = handles.into_iter().flat_map(|h| h.join().unwrap()).collect();
    revisions.sort_unstable();
    revisions.dedup();
    assert_eq!(revisions.len(), 40);
    assert_eq!(store.items(v, None).unwrap().items.len(), 41);
}

#[test]
fn vaults_create_rename_delete() {
    let tmp = TempDir::new();
    let (store, mut client) = new_coffre(&tmp.coffre());
    let req = client.vault_request("Travail");
    let id = req.id;
    let vault = store.create_vault(req.clone()).unwrap();
    assert_eq!(vault.kind, VaultKind::Shared);
    assert_eq!(store.create_vault(req).unwrap_err().code, "vault_id_taken");

    let key = client.key(id);
    let renamed = store
        .rename_vault(
            id,
            RenameVaultRequest {
                name_enc: seal_vault_name(key, &id.to_string(), "Boulot").unwrap(),
            },
        )
        .unwrap();
    assert_eq!(
        guivault_crypto::open_vault_name(key, &id.to_string(), &renamed.name_enc).unwrap(),
        "Boulot"
    );

    let err = store.delete_vault(client.personal).unwrap_err();
    assert_eq!((err.status, err.code), (403, "forbidden"));
    store.delete_vault(id).unwrap();
    assert_eq!(store.vault(id).unwrap_err().code, "not_found");
    assert_eq!(store.vaults().unwrap().len(), 1);
}

#[test]
fn attachments_are_stored_beside_and_follow_their_item() {
    let tmp = TempDir::new();
    let (store, mut client) = new_coffre(&tmp.coffre());
    let v = client.personal;
    let item = Uuid::new_v4();
    client.put(&store, v, item, "avec fichier", None).unwrap();

    let file_key = SymmetricKey::random();
    let att = Uuid::new_v4();
    let data: Vec<u8> = (0..(guivault_crypto::ATTACHMENT_CHUNK + 1000))
        .map(|i| (i % 251) as u8)
        .collect();
    let chunks = seal_attachment(&file_key, &att.to_string(), &data).unwrap();
    assert_eq!(chunks.len(), 2);
    let size: usize = chunks.iter().map(Vec::len).sum();
    let create = |item_id| CreateAttachmentRequest {
        id: att,
        item_id,
        size: size as i64,
        chunks: chunks.len() as i32,
    };

    assert_eq!(
        store.create_attachment(v, create(Uuid::new_v4())).unwrap_err().code,
        "not_found"
    );
    let bad = CreateAttachmentRequest {
        chunks: 5,
        ..create(item)
    };
    assert_eq!(store.create_attachment(v, bad).unwrap_err().code, "invalid_attachment");
    store.create_attachment(v, create(item)).unwrap();
    assert_eq!(
        store.create_attachment(v, create(item)).unwrap_err().code,
        "attachment_exists"
    );

    store.put_chunk(v, att, 0, &chunks[0]).unwrap();
    assert_eq!(
        store.complete_attachment(v, att).unwrap_err().code,
        "attachment_incomplete"
    );
    // Pas servie tant qu'elle n'est pas complète.
    assert_eq!(store.chunk(v, att, 0).unwrap_err().code, "not_found");
    store.put_chunk(v, att, 1, &chunks[1]).unwrap();
    assert!(store.complete_attachment(v, att).unwrap().complete);
    assert_eq!(
        store.put_chunk(v, att, 1, &chunks[1]).unwrap_err().code,
        "attachment_complete"
    );

    let read: Vec<Vec<u8>> = (0..2).map(|i| store.chunk(v, att, i).unwrap()).collect();
    assert_eq!(open_attachment(&file_key, &att.to_string(), &read).unwrap(), data);
    assert_eq!(store.attachments(v, Some(item)).unwrap().len(), 1);

    // L'item part dans un autre vault (même id) : la pièce jointe suit.
    let other = client.vault_request("Archives");
    let w = other.id;
    store.create_vault(other).unwrap();
    client.put(&store, w, item, "avec fichier", None).unwrap();
    store.delete_item(v, item, true, DeleteItemRequest::default()).unwrap();
    store
        .move_attachment(
            v,
            att,
            MoveAttachmentRequest {
                vault_id: w,
                item_id: item,
            },
        )
        .unwrap();
    assert!(store.attachments(v, None).unwrap().is_empty());
    let read: Vec<Vec<u8>> = (0..2).map(|i| store.chunk(w, att, i).unwrap()).collect();
    assert_eq!(open_attachment(&file_key, &att.to_string(), &read).unwrap(), data);

    // Supprimer puis purger l'item efface ses morceaux du disque.
    let att_dir = tmp
        .coffre()
        .join("attachments")
        .join(w.to_string())
        .join(att.to_string());
    assert!(att_dir.exists());
    store.delete_item(w, item, false, DeleteItemRequest::default()).unwrap();
    assert!(att_dir.exists(), "restaurable tant qu'il est dans la corbeille");
    store.purge(w, item).unwrap();
    assert!(!att_dir.exists());
    assert!(store.attachments(w, None).unwrap().is_empty());
}

#[test]
fn settings_and_password_change() {
    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());
    let blob = |s: &str| seal_user_settings(&client.account.user_key, s.as_bytes()).unwrap();

    assert!(store.settings().unwrap().is_none());
    let s = store
        .put_settings(PutUserSettingsRequest {
            blob: blob("{}"),
            base_revision: None,
        })
        .unwrap();
    assert_eq!(s.revision, 1);
    let err = store
        .put_settings(PutUserSettingsRequest {
            blob: blob("{\"a\":1}"),
            base_revision: None,
        })
        .unwrap_err();
    assert_eq!(err.code, "revision_mismatch");
    assert_eq!(err.body()["current"]["revision"], 1);

    let rekey = rekey_account(&client.account, "nouveau mot de passe").unwrap();
    store.change_password(PasswordChange::from(&rekey)).unwrap();
    let a = store.account().unwrap();
    let login = prepare_login("nouveau mot de passe", &a.kdf_salt, a.kdf).unwrap();
    let unlocked = unlock_account(&login.stretched_key, &a.protected_user_key, &a.protected_private_key).unwrap();
    assert_eq!(unlocked.user_key.as_bytes(), client.account.user_key.as_bytes());
    let old = prepare_login(PASSWORD, &a.kdf_salt, a.kdf).unwrap();
    assert!(unlock_account(&old.stretched_key, &a.protected_user_key, &a.protected_private_key).is_err());
}

#[test]
fn newer_formats_unknown_fields_and_corruption() {
    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());
    let path = tmp.coffre().join("coffre.json");

    // Un champ ajouté par une version plus récente survit à une écriture.
    let mut json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    json["futur"] = serde_json::json!({ "x": 1 });
    json["vaults"][0]["futur"] = serde_json::json!(true);
    std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
    client.put(&store, client.personal, Uuid::new_v4(), "x", None).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(json["futur"]["x"], 1);
    assert_eq!(json["vaults"][0]["futur"], true);

    // Un format plus récent : refusé, et jamais réécrit.
    let mut newer = json.clone();
    newer["format"] = serde_json::json!(guivault_local::FORMAT + 1);
    std::fs::write(&path, serde_json::to_vec(&newer).unwrap()).unwrap();
    assert_eq!(
        LocalVault::open(tmp.coffre()).unwrap_err().code,
        "local_format_unsupported"
    );
    let err = client
        .put(&store, client.personal, Uuid::new_v4(), "x", None)
        .unwrap_err();
    assert_eq!(err.code, "local_format_unsupported");

    std::fs::write(&path, b"{ pas du json").unwrap();
    assert_eq!(LocalVault::open(tmp.coffre()).unwrap_err().code, "local_corrupt");
    assert_eq!(std::fs::read(&path).unwrap(), b"{ pas du json");
}

#[test]
fn expired_trash_and_orphan_attachments_are_pruned_on_write() {
    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());
    let v = client.personal;
    let (old, recent) = (Uuid::new_v4(), Uuid::new_v4());
    for id in [old, recent] {
        client.put(&store, v, id, "x", None).unwrap();
    }
    let file_key = SymmetricKey::random();
    let att = Uuid::new_v4();
    let chunks = seal_attachment(&file_key, &att.to_string(), b"contenu").unwrap();
    store
        .create_attachment(
            v,
            CreateAttachmentRequest {
                id: att,
                item_id: old,
                size: chunks[0].len() as i64,
                chunks: 1,
            },
        )
        .unwrap();
    store.put_chunk(v, att, 0, &chunks[0]).unwrap();
    store.complete_attachment(v, att).unwrap();
    // Un envoi resté en plan.
    let stale = Uuid::new_v4();
    store
        .create_attachment(
            v,
            CreateAttachmentRequest {
                id: stale,
                item_id: recent,
                size: chunks[0].len() as i64,
                chunks: 1,
            },
        )
        .unwrap();
    store.put_chunk(v, stale, 0, &chunks[0]).unwrap();
    for id in [old, recent] {
        store.delete_item(v, id, false, DeleteItemRequest::default()).unwrap();
    }

    // On vieillit le fichier : `old` supprimé il y a 31 jours, les pièces
    // jointes créées il y a deux jours.
    let path = tmp.coffre().join("coffre.json");
    let mut json: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let ago = |days| serde_json::json!((chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339());
    for item in json["vaults"][0]["items"].as_array_mut().unwrap() {
        if item["id"] == old.to_string() {
            item["deleted_at"] = ago(31);
        }
    }
    for a in json["vaults"][0]["attachments"].as_array_mut().unwrap() {
        a["created_at"] = ago(2);
    }
    std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();

    // Hors délai, il n'est déjà plus montré ; la prochaine écriture l'efface.
    assert_eq!(store.trash(v).unwrap().len(), 1);
    client.put(&store, v, Uuid::new_v4(), "déclencheur", None).unwrap();
    assert!(store.item_versions(v, old).unwrap().is_empty());
    assert_eq!(store.item_versions(v, recent).unwrap().len(), 1);
    assert!(store.attachments(v, None).unwrap().is_empty());
    let dir = tmp.coffre().join("attachments").join(v.to_string());
    assert!(!dir.join(att.to_string()).exists());
    assert!(!dir.join(stale.to_string()).exists());
}

// ─── rpc : ce que l'interface de l'app envoie ───────────────────────────────

#[test]
fn rpc_ops_match_the_shared_list() {
    let shared: Vec<String> = serde_json::from_str(include_str!("../ops.json")).unwrap();
    assert_eq!(shared, guivault_local::rpc::OPS);

    // Chaque opération est aiguillée : sans arguments, elle se plaint de ses
    // arguments ou répond, jamais « inconnue ».
    let tmp = TempDir::new();
    let (store, _) = new_coffre(&tmp.coffre());
    for op in guivault_local::rpc::OPS {
        if let Err(e) = guivault_local::rpc::call(&store, op, &serde_json::json!({})) {
            assert_ne!(e.code, "local_unsupported", "{op}");
        }
    }
    let err = guivault_local::rpc::call(&store, "members", &serde_json::json!({})).unwrap_err();
    assert_eq!((err.status, err.code), (501, "local_unsupported"));
}

/// Les mêmes corps JSON que l'API HTTP, base64 compris : ceux que produit
/// `web/src/lib/session.ts`.
#[test]
fn rpc_speaks_the_http_json() {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as B64;
    use guivault_local::rpc::call;
    use serde_json::json;

    let tmp = TempDir::new();
    let (store, client) = new_coffre(&tmp.coffre());
    let v = client.personal;
    let id = Uuid::new_v4();

    let sync = call(&store, "sync", &json!({})).unwrap();
    assert_eq!(sync["user"]["id"], store.id().unwrap().to_string());
    assert_eq!(sync["vaults"][0]["role"], "owner");
    assert_eq!(sync["invitations"], json!([]));
    let account = call(&store, "account", &json!({})).unwrap();
    assert_eq!(account["kdf"]["m_cost"], 65536);
    assert!(account["protected_user_key"].is_string());

    let ct = B64.encode(client.seal(v, id, "note", "par le JSON"));
    let req = json!({ "vault": v, "id": id, "req": { "item_type": "note", "ciphertext": ct } });
    let item = call(&store, "putItem", &req).unwrap();
    assert_eq!(item["revision"], 1);
    assert_eq!(item["ciphertext"], ct);
    let err = call(&store, "putItem", &req).unwrap_err();
    assert_eq!(err.code, "revision_mismatch");
    assert_eq!(err.body()["current"]["id"], id.to_string());

    let page = call(&store, "items", &json!({ "vault": v })).unwrap();
    assert_eq!(page["items"][0]["id"], id.to_string());
    assert_eq!(page["revision"], 1);
    assert!(page.get("manifest").is_none());
    let since = call(&store, "items", &json!({ "vault": v, "since": 1 })).unwrap();
    assert_eq!(since["items"], json!([]));

    call(&store, "deleteItem", &json!({ "vault": v, "id": id })).unwrap();
    assert_eq!(
        call(&store, "trash", &json!({ "vault": v })).unwrap()[0]["item_id"],
        id.to_string()
    );

    // Les octets d'une pièce jointe voyagent en base64.
    let item2 = Uuid::new_v4();
    client.put(&store, v, item2, "x", None).unwrap();
    let att = Uuid::new_v4();
    let chunks = seal_attachment(&SymmetricKey::random(), &att.to_string(), b"fichier").unwrap();
    let create = json!({ "vault": v, "req": { "id": att, "item_id": item2, "size": chunks[0].len(), "chunks": 1 } });
    call(&store, "createAttachment", &create).unwrap();
    let put = json!({ "vault": v, "id": att, "index": 0, "bytes": B64.encode(&chunks[0]) });
    call(&store, "putAttachmentChunk", &put).unwrap();
    assert_eq!(
        call(&store, "completeAttachment", &json!({ "vault": v, "id": att })).unwrap()["complete"],
        true
    );
    let got = call(&store, "attachmentChunk", &json!({ "vault": v, "id": att, "index": 0 })).unwrap();
    assert_eq!(B64.decode(got.as_str().unwrap()).unwrap(), chunks[0]);

    let bad = call(&store, "items", &json!({ "vault": "pas un uuid" })).unwrap_err();
    assert_eq!((bad.status, bad.code), (400, "invalid_request"));
}
