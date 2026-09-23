//! Tests d'intégration bout en bout : un vrai serveur sur un port libre, une
//! base Postgres jetable, et des clients qui font la vraie cryptographie
//! (`guivault-crypto`) — exactement ce que fera Guiterm.
//!
//! Ils demandent un Postgres joignable via `GUIVAULT_TEST_DATABASE_URL`
//! (défaut : le conteneur de `scripts/test-db.sh`). Sans base, ils sont
//! ignorés avec un message plutôt que d'échouer.
use guivault_crypto as gc;
use guivault_protocol::*;
use guivault_server::config::Config;
use reqwest::{Client, StatusCode};
use serde::de::DeserializeOwned;
use std::net::SocketAddr;
use std::time::Duration;
use uuid::Uuid;

const DEFAULT_DB: &str = "postgres://guivault:test@localhost:55432/guivault_test";

struct TestServer {
    base: String,
    db_name: String,
    admin_url: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl TestServer {
    async fn start(registration: RegistrationMode) -> Option<TestServer> {
        Self::start_with(registration, |_| {}).await
    }

    async fn start_with(registration: RegistrationMode, tweak: impl FnOnce(&mut Config)) -> Option<TestServer> {
        let admin_url = std::env::var("GUIVAULT_TEST_DATABASE_URL").unwrap_or_else(|_| DEFAULT_DB.into());
        let admin = match sqlx::PgPool::connect(&admin_url).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("⚠ pas de Postgres de test ({admin_url}) : {e} — test ignoré");
                return None;
            }
        };
        let db_name = format!("guivault_t_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {db_name}"))
            .execute(&admin)
            .await
            .unwrap();
        let database_url = {
            let mut u = url::Url::parse(&admin_url).unwrap();
            u.set_path(&db_name);
            u.to_string()
        };
        let mut config = Config {
            database_url,
            bind: "127.0.0.1:0".parse().unwrap(),
            registration,
            allowed_emails: vec!["alice@t.io".into()],
            secret: b"test-secret-test-secret-test-secret-test".to_vec(),
            totp_key: Config::derive_totp_key(b"test-secret-test-secret-test-secret-test"),
            access_ttl: Duration::from_secs(900),
            refresh_ttl: Duration::from_secs(86400),
            invitation_ttl: Duration::from_secs(86400),
            trust_proxy: guivault_server::config::TrustProxy::No,
            max_item_bytes: 64 * 1024,
            auth_rate_burst: 1000,
            auth_rate_per_second: 1000,
            log_json: false,
        };
        tweak(&mut config);
        let (addr_tx, addr_rx) = tokio::sync::oneshot::channel::<SocketAddr>();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            guivault_server::serve(config, |a| addr_tx.send(a).unwrap(), async {
                let _ = stop_rx.await;
            })
            .await
            .unwrap();
        });
        let addr = addr_rx.await.unwrap();
        Some(TestServer {
            base: format!("http://{addr}/api/v1"),
            db_name,
            admin_url,
            shutdown: Some(stop_tx),
        })
    }

    async fn stop(mut self) {
        if let Some(s) = self.shutdown.take() {
            let _ = s.send(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Ok(admin) = sqlx::PgPool::connect(&self.admin_url).await {
            let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.db_name))
                .execute(&admin)
                .await;
        }
    }
}

/// Un client « Guiterm » : compte déverrouillé + jetons.
struct User {
    http: Client,
    base: String,
    email: String,
    password: String,
    account: gc::UnlockedAccount,
    tokens: TokenPair,
    profile: UserProfile,
}

macro_rules! status {
    ($resp:expr, $code:expr) => {{
        let r = $resp;
        let st = r.status();
        let body = r.text().await.unwrap();
        assert_eq!(st, $code, "réponse inattendue : {body}");
        body
    }};
}

impl User {
    async fn register(server: &TestServer, email: &str, password: &str) -> User {
        let (material, account) = gc::create_account(password).unwrap();
        let personal_key = gc::SymmetricKey::random();
        let personal_id = Uuid::new_v4();
        let req = RegisterRequest {
            email: email.into(),
            kdf: material.kdf,
            kdf_salt: material.kdf_salt,
            auth_key: material.auth_key,
            protected_user_key: material.protected_user_key,
            public_key: material.public_key,
            protected_private_key: material.protected_private_key,
            personal_vault: CreateVaultRequest {
                id: personal_id,
                name_enc: gc::seal_vault_name(&personal_key, &personal_id.to_string(), "Personnel").unwrap(),
                wrapped_vault_key: gc::wrap_vault_key(&account.keypair.public, &personal_key).unwrap(),
            },
            device_name: Some("test".into()),
        };
        let http = Client::new();
        let body = status!(
            http.post(format!("{}/auth/register", server.base))
                .json(&req)
                .send()
                .await
                .unwrap(),
            StatusCode::CREATED
        );
        let resp: LoginResponse = serde_json::from_str(&body).unwrap();
        User {
            http,
            base: server.base.clone(),
            email: email.into(),
            password: password.into(),
            account,
            tokens: resp.tokens,
            profile: resp.user,
        }
    }

    /// Connexion depuis un « nouvel appareil » : prelogin → dérivation →
    /// login → déverrouillage des blobs renvoyés.
    async fn login(server: &TestServer, email: &str, password: &str) -> Result<User, (StatusCode, String)> {
        let http = Client::new();
        let pre: PreloginResponse = http
            .post(format!("{}/auth/prelogin", server.base))
            .json(&PreloginRequest { email: email.into() })
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let lm = gc::prepare_login(password, &pre.kdf_salt, pre.kdf).unwrap();
        let resp = http
            .post(format!("{}/auth/login", server.base))
            .json(&LoginRequest {
                email: email.into(),
                auth_key: lm.auth_key.as_bytes().to_vec(),
                device_name: Some("laptop".into()),
            })
            .send()
            .await
            .unwrap();
        if resp.status() != StatusCode::OK {
            return Err((resp.status(), resp.text().await.unwrap()));
        }
        let resp: LoginResponse = resp.json().await.unwrap();
        let account = gc::unlock_account(&lm.stretched_key, &resp.protected_user_key, &resp.protected_private_key)
            .expect("déverrouillage avec le bon mot de passe");
        Ok(User {
            http,
            base: server.base.clone(),
            email: email.into(),
            password: password.into(),
            account,
            tokens: resp.tokens,
            profile: resp.user,
        })
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(&self.tokens.access_token)
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> T {
        let body = status!(
            self.req(reqwest::Method::GET, path).send().await.unwrap(),
            StatusCode::OK
        );
        serde_json::from_str(&body).unwrap()
    }

    async fn sync(&self) -> SyncResponse {
        self.get("/sync").await
    }

    fn vault_key(&self, v: &Vault) -> gc::SymmetricKey {
        gc::unwrap_vault_key(&self.account, &v.wrapped_vault_key).expect("clé de vault ouvrable")
    }

    async fn create_vault(&self, name: &str) -> (Vault, gc::SymmetricKey) {
        let key = gc::SymmetricKey::random();
        let id = Uuid::new_v4();
        let req = CreateVaultRequest {
            id,
            name_enc: gc::seal_vault_name(&key, &id.to_string(), name).unwrap(),
            wrapped_vault_key: gc::wrap_vault_key(&self.account.keypair.public, &key).unwrap(),
        };
        let body = status!(
            self.req(reqwest::Method::POST, "/vaults")
                .json(&req)
                .send()
                .await
                .unwrap(),
            StatusCode::CREATED
        );
        (serde_json::from_str(&body).unwrap(), key)
    }

    async fn put_item(
        &self,
        vault_id: Uuid,
        key: &gc::SymmetricKey,
        item_id: Uuid,
        item_type: &str,
        plaintext: &str,
        base_revision: Option<i64>,
    ) -> reqwest::Response {
        let ct = gc::seal_item(
            key,
            &vault_id.to_string(),
            &item_id.to_string(),
            item_type,
            plaintext.as_bytes(),
        )
        .unwrap();
        self.req(reqwest::Method::PUT, &format!("/vaults/{vault_id}/items/{item_id}"))
            .json(&PutItemRequest {
                item_type: item_type.into(),
                ciphertext: ct,
                base_revision,
            })
            .send()
            .await
            .unwrap()
    }

    fn open_item(&self, key: &gc::SymmetricKey, item: &Item) -> String {
        let pt = gc::open_item(
            key,
            &item.vault_id.to_string(),
            &item.id.to_string(),
            &item.item_type,
            &item.ciphertext,
        )
        .expect("item déchiffrable");
        String::from_utf8(pt).unwrap()
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn health_and_registration_mode() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let h: HealthResponse = Client::new()
        .get(format!("{}/health", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(h.status, "ok");
    assert_eq!(h.protocol_version, PROTOCOL_VERSION);
    assert_eq!(h.registration, RegistrationMode::Open);
    server.stop().await;
}

#[tokio::test]
async fn web_ui_is_served_at_root_and_api_404_stays_json() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let origin = server.base.trim_end_matches("/api/v1").to_string();
    let client = Client::new();

    // Une route d'API inconnue est une erreur d'API, jamais la page.
    let res = client.get(format!("{origin}/api/v1/nope")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let err: ApiError = res.json().await.unwrap();
    assert_eq!(err.code, "not_found");

    // CORS : une origine quelconque (l'extension de navigateur) peut appeler
    // l'API avec son jeton ; la page, elle, n'en a pas besoin.
    let res = client
        .request(reqwest::Method::OPTIONS, format!("{origin}/api/v1/sync"))
        .header("Origin", "chrome-extension://abcdef")
        .header("Access-Control-Request-Method", "GET")
        .header("Access-Control-Request-Headers", "authorization")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["access-control-allow-origin"], "*");
    assert!(
        res.headers()["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .contains("authorization")
    );

    // La racine : la page si le build Vite est embarqué, sinon un texte qui
    // explique comment l'obtenir — les deux cas sont légitimes en test.
    let res = client.get(format!("{origin}/")).send().await.unwrap();
    let ct = res.headers()[reqwest::header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .to_string();
    if guivault_server::web::is_built() {
        assert_eq!(res.status(), StatusCode::OK);
        assert!(ct.starts_with("text/html"), "{ct}");
        assert!(res.headers().contains_key(reqwest::header::CONTENT_SECURITY_POLICY));
        assert_eq!(res.headers()[reqwest::header::CACHE_CONTROL], "no-cache");
        // Un chemin inconnu hors API renvoie aussi la page (routage côté client).
        let res = client.get(format!("{origin}/whatever")).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            res.headers()[reqwest::header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
    } else {
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert!(ct.starts_with("text/plain"), "{ct}");
    }
    server.stop().await;
}

#[tokio::test]
async fn register_login_unlock_and_personal_vault() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let alice = User::register(&server, "Alice@Example.com", "alice-master-pw").await;
    assert_eq!(alice.profile.email, "alice@example.com", "e-mail normalisé");

    // Nouvel appareil : tout se re-dérive depuis le mot de passe.
    let alice2 = User::login(&server, "alice@example.com", "alice-master-pw")
        .await
        .unwrap();
    assert_eq!(alice2.account.user_key.as_bytes(), alice.account.user_key.as_bytes());

    let sync = alice2.sync().await;
    assert_eq!(sync.vaults.len(), 1);
    let pv = &sync.vaults[0];
    assert_eq!(pv.kind, VaultKind::Personal);
    assert_eq!(pv.role, Role::Owner);
    let key = alice2.vault_key(pv);
    assert_eq!(
        gc::open_vault_name(&key, &pv.id.to_string(), &pv.name_enc).unwrap(),
        "Personnel"
    );

    // Mauvais mot de passe → 401 sans détail, e-mail inconnu → même 401.
    let Err(err) = User::login(&server, "alice@example.com", "wrong").await else {
        panic!("mauvais mot de passe accepté")
    };
    assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    assert!(err.1.contains("invalid_credentials"));
    let Err(err) = User::login(&server, "nobody@example.com", "wrong").await else {
        panic!("compte inexistant accepté")
    };
    assert_eq!(err.0, StatusCode::UNAUTHORIZED);

    // Prelogin d'un inconnu : déterministe (pas d'oracle « le sel change »).
    let http = Client::new();
    let p1: PreloginResponse = http
        .post(format!("{}/auth/prelogin", server.base))
        .json(&PreloginRequest {
            email: "ghost@x.io".into(),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let p2: PreloginResponse = http
        .post(format!("{}/auth/prelogin", server.base))
        .json(&PreloginRequest {
            email: "ghost@x.io".into(),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(p1.kdf_salt, p2.kdf_salt);
    assert_eq!(p1.kdf_salt.len(), 16);

    // Doublon d'e-mail.
    let (m, a) = gc::create_account("x").unwrap();
    let k = gc::SymmetricKey::random();
    let pid = Uuid::new_v4();
    let dup = RegisterRequest {
        email: "ALICE@example.com".into(),
        kdf: m.kdf,
        kdf_salt: m.kdf_salt,
        auth_key: m.auth_key,
        protected_user_key: m.protected_user_key,
        public_key: m.public_key,
        protected_private_key: m.protected_private_key,
        personal_vault: CreateVaultRequest {
            id: pid,
            name_enc: gc::seal_vault_name(&k, &pid.to_string(), "P").unwrap(),
            wrapped_vault_key: gc::wrap_vault_key(&a.keypair.public, &k).unwrap(),
        },
        device_name: None,
    };
    status!(
        http.post(format!("{}/auth/register", server.base))
            .json(&dup)
            .send()
            .await
            .unwrap(),
        StatusCode::CONFLICT
    );

    // Sans jeton → 401.
    status!(
        http.get(format!("{}/sync", server.base)).send().await.unwrap(),
        StatusCode::UNAUTHORIZED
    );
    server.stop().await;
}

#[tokio::test]
async fn items_sync_conflicts_and_tombstones() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw").await;
    let sync = alice.sync().await;
    let pv = sync.vaults[0].clone();
    let key = alice.vault_key(&pv);
    assert_eq!(pv.revision, 0);

    let host = Uuid::new_v4();
    let r = alice
        .put_item(pv.id, &key, host, "host", r#"{"host":"db1","user":"root"}"#, None)
        .await;
    let body = status!(r, StatusCode::CREATED);
    let created: Item = serde_json::from_str(&body).unwrap();
    assert_eq!(created.revision, 1);

    // Mise à jour avec la bonne base → OK, révision 2.
    let r = alice
        .put_item(pv.id, &key, host, "host", r#"{"host":"db1","user":"admin"}"#, Some(1))
        .await;
    let body = status!(r, StatusCode::OK);
    let updated: Item = serde_json::from_str(&body).unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(alice.open_item(&key, &updated), r#"{"host":"db1","user":"admin"}"#);

    // Base périmée → 409 avec l'item courant.
    let r = alice.put_item(pv.id, &key, host, "host", "stale", Some(1)).await;
    let body = status!(r, StatusCode::CONFLICT);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["code"], "revision_mismatch");
    assert_eq!(v["current"]["revision"], 2);

    // Créer un id déjà pris (base None) → 409 aussi. Changer de type → 400.
    status!(
        alice.put_item(pv.id, &key, host, "host", "x", None).await,
        StatusCode::CONFLICT
    );
    status!(
        alice.put_item(pv.id, &key, host, "ssh-key", "x", Some(2)).await,
        StatusCode::BAD_REQUEST
    );

    // Deuxième item, puis sync incrémentale depuis la révision 2.
    let key_item = Uuid::new_v4();
    status!(
        alice
            .put_item(pv.id, &key, key_item, "ssh-key", "-----BEGIN…", None)
            .await,
        StatusCode::CREATED
    );
    let page: ItemsPage = alice.get(&format!("/vaults/{}/items?since=2", pv.id)).await;
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, key_item);
    assert_eq!(page.revision, 3);

    // Suppression : tombale visible en incrémental, absente en complet.
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{}/items/{host}", pv.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    let page: ItemsPage = alice.get(&format!("/vaults/{}/items?since=3", pv.id)).await;
    assert_eq!(page.items.len(), 1);
    assert!(page.items[0].deleted && page.items[0].ciphertext.is_empty());
    assert_eq!(page.revision, 4);
    let full: ItemsPage = alice.get(&format!("/vaults/{}/items", pv.id)).await;
    assert_eq!(full.items.len(), 1);
    assert_eq!(full.items[0].id, key_item);
    // Supprimer deux fois → 404 et pas de bump.
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{}/items/{host}", pv.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );
    let sync = alice.sync().await;
    assert_eq!(sync.vaults[0].revision, 4);

    // Item trop gros → 413.
    let big = "x".repeat(65 * 1024);
    status!(
        alice.put_item(pv.id, &key, Uuid::new_v4(), "blob", &big, None).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    server.stop().await;
}

#[tokio::test]
async fn shared_vault_invite_existing_user_roles_and_rotation() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-a").await;
    let bob = User::register(&server, "bob@t.io", "pw-b").await;

    let (vault, vkey) = alice.create_vault("Équipe infra").await;
    assert_eq!(vault.kind, VaultKind::Shared);
    assert_eq!(vault.role, Role::Owner);
    let item = Uuid::new_v4();
    status!(
        alice.put_item(vault.id, &vkey, item, "host", "prod-1", None).await,
        StatusCode::CREATED
    );

    // Bob n'a pas accès : 404 (pas 403, pour ne pas confirmer l'existence).
    status!(
        bob.req(reqwest::Method::GET, &format!("/vaults/{}/items", vault.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );

    // Alice cherche Bob, vérifie l'empreinte (hors bande), enveloppe la clé.
    let lookup: UserLookupResponse = alice.get("/users/lookup?email=BOB@t.io").await;
    assert_eq!(lookup.id, bob.profile.id);
    assert_eq!(lookup.fingerprint, gc::fingerprint(&bob.account.keypair.public));
    let bob_pk = gc::PublicKey::try_from(lookup.public_key.as_slice()).unwrap();
    let body = status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", vault.id))
            .json(&CreateInvitationRequest {
                email: "bob@t.io".into(),
                role: Role::Reader,
                wrapped_vault_key: Some(gc::wrap_vault_key(&bob_pk, &vkey).unwrap()),
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );
    let inv: Invitation = serde_json::from_str(&body).unwrap();
    assert!(inv.has_key && inv.status == InvitationStatus::Pending);

    // Doublon → 409.
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", vault.id))
            .json(&CreateInvitationRequest {
                email: "bob@t.io".into(),
                role: Role::Reader,
                wrapped_vault_key: None
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CONFLICT
    );

    // Bob voit l'invitation dans son sync, accepte, lit l'item.
    let s = bob.sync().await;
    assert_eq!(s.invitations.len(), 1);
    assert_eq!(s.invitations[0].inviter_email, "alice@t.io");
    let body = status!(
        bob.req(reqwest::Method::POST, &format!("/invitations/{}/accept", inv.id))
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let inv: Invitation = serde_json::from_str(&body).unwrap();
    assert_eq!(inv.status, InvitationStatus::Accepted);
    let s = bob.sync().await;
    let shared = s.vaults.iter().find(|v| v.id == vault.id).expect("Bob est membre");
    assert_eq!(shared.role, Role::Reader);
    let bob_key = bob.vault_key(shared);
    assert_eq!(
        gc::open_vault_name(&bob_key, &shared.id.to_string(), &shared.name_enc).unwrap(),
        "Équipe infra"
    );
    let page: ItemsPage = bob.get(&format!("/vaults/{}/items", vault.id)).await;
    assert_eq!(bob.open_item(&bob_key, &page.items[0]), "prod-1");

    // Reader : pas d'écriture, pas de gestion des membres.
    status!(
        bob.put_item(vault.id, &bob_key, Uuid::new_v4(), "host", "x", None)
            .await,
        StatusCode::FORBIDDEN
    );
    status!(
        bob.req(reqwest::Method::GET, &format!("/vaults/{}/invitations", vault.id))
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );

    // Promotion en writer → écriture OK.
    status!(
        alice
            .req(
                reqwest::Method::PATCH,
                &format!("/vaults/{}/members/{}", vault.id, bob.profile.id)
            )
            .json(&UpdateMemberRequest { role: Role::Writer })
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    let bob_item = Uuid::new_v4();
    status!(
        bob.put_item(vault.id, &bob_key, bob_item, "snippet", "ls -la", None)
            .await,
        StatusCode::CREATED
    );
    // Alice lit ce que Bob a écrit.
    let page: ItemsPage = alice.get(&format!("/vaults/{}/items?since=1", vault.id)).await;
    assert_eq!(alice.open_item(&vkey, &page.items[0]), "ls -la");

    // Le vault personnel ne se partage pas.
    let pv = alice
        .sync()
        .await
        .vaults
        .into_iter()
        .find(|v| v.kind == VaultKind::Personal)
        .unwrap();
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", pv.id))
            .json(&CreateInvitationRequest {
                email: "bob@t.io".into(),
                role: Role::Reader,
                wrapped_vault_key: None
            })
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );

    // Audit du vault : réservé admin+, et Bob (writer) n'y a pas droit.
    status!(
        bob.req(reqwest::Method::GET, &format!("/vaults/{}/audit", vault.id))
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );
    let audit: Vec<serde_json::Value> = alice.get(&format!("/vaults/{}/audit", vault.id)).await;
    assert!(
        audit
            .iter()
            .any(|e| e["action"] == "member.update" && e["actor_email"] == "alice@t.io")
    );

    // Alice retire Bob et fait tourner la clé.
    status!(
        alice
            .req(
                reqwest::Method::DELETE,
                &format!("/vaults/{}/members/{}", vault.id, bob.profile.id)
            )
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    let current = alice
        .sync()
        .await
        .vaults
        .into_iter()
        .find(|v| v.id == vault.id)
        .unwrap();
    let all: ItemsPage = alice.get(&format!("/vaults/{}/items", vault.id)).await;
    let new_key = gc::SymmetricKey::random();
    let rotated: Vec<RotatedItem> = all
        .items
        .iter()
        .map(|it| {
            let pt = alice.open_item(&vkey, it);
            RotatedItem {
                id: it.id,
                ciphertext: gc::seal_item(
                    &new_key,
                    &vault.id.to_string(),
                    &it.id.to_string(),
                    &it.item_type,
                    pt.as_bytes(),
                )
                .unwrap(),
            }
        })
        .collect();
    let rotate = RotateVaultKeyRequest {
        name_enc: gc::seal_vault_name(&new_key, &vault.id.to_string(), "Équipe infra").unwrap(),
        members: vec![RotatedMemberKey {
            user_id: alice.profile.id,
            wrapped_vault_key: gc::wrap_vault_key(&alice.account.keypair.public, &new_key).unwrap(),
        }],
        items: rotated,
        base_revision: current.revision,
    };
    // Un item manquant → refus.
    let mut incomplete = rotate.clone();
    incomplete.items.pop();
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/rotate-key", vault.id))
            .json(&incomplete)
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST
    );
    let body = status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/rotate-key", vault.id))
            .json(&rotate)
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let after: Vault = serde_json::from_str(&body).unwrap();
    assert_eq!(after.revision, current.revision + 1);
    let k2 = alice.vault_key(&after);
    assert_eq!(k2.as_bytes(), new_key.as_bytes());
    let page: ItemsPage = alice.get(&format!("/vaults/{}/items", vault.id)).await;
    assert_eq!(page.items.len(), 2);
    for it in &page.items {
        assert!(
            gc::open_item(
                &vkey,
                &vault.id.to_string(),
                &it.id.to_string(),
                &it.item_type,
                &it.ciphertext
            )
            .is_err(),
            "l'ancienne clé n'ouvre plus rien"
        );
        alice.open_item(&k2, it);
    }
    // Bob est dehors.
    status!(
        bob.req(reqwest::Method::GET, &format!("/vaults/{}/items", vault.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );
    assert!(!bob.sync().await.vaults.iter().any(|v| v.id == vault.id));

    // Le propriétaire ne quitte pas, mais peut supprimer.
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/leave", vault.id))
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{}", vault.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{}", pv.id))
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );
    server.stop().await;
}

#[tokio::test]
async fn invite_only_registration_and_deferred_key() {
    let Some(server) = TestServer::start(RegistrationMode::InviteOnly).await else {
        return;
    };
    let http = Client::new();
    let h: HealthResponse = http
        .get(format!("{}/health", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(h.registration, RegistrationMode::InviteOnly);

    // Personne n'est invité : impossible de s'inscrire… sauf les adresses de
    // `GUIVAULT_ALLOWED_EMAILS` (ici alice@t.io), qui amorcent le serveur.
    let (m, a) = gc::create_account("pw-x").unwrap();
    let k = gc::SymmetricKey::random();
    let pid = Uuid::new_v4();
    let req = RegisterRequest {
        email: "stranger@t.io".into(),
        kdf: m.kdf,
        kdf_salt: m.kdf_salt,
        auth_key: m.auth_key,
        protected_user_key: m.protected_user_key,
        public_key: m.public_key,
        protected_private_key: m.protected_private_key,
        personal_vault: CreateVaultRequest {
            id: pid,
            name_enc: gc::seal_vault_name(&k, &pid.to_string(), "P").unwrap(),
            wrapped_vault_key: gc::wrap_vault_key(&a.keypair.public, &k).unwrap(),
        },
        device_name: None,
    };
    let body = status!(
        http.post(format!("{}/auth/register", server.base))
            .json(&req)
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );
    assert!(body.contains("invitation_required"));
    User::register(&server, "alice@t.io", "pw-a").await;

    let alice = User::login(&server, "alice@t.io", "pw-a").await.unwrap();
    let (vault, vkey) = alice.create_vault("Ops").await;
    let item = Uuid::new_v4();
    status!(
        alice.put_item(vault.id, &vkey, item, "host", "bastion", None).await,
        StatusCode::CREATED
    );

    // Invitation sans clé (Carol n'existe pas encore). Avec clé → refusé.
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", vault.id))
            .json(&CreateInvitationRequest {
                email: "carol@t.io".into(),
                role: Role::Writer,
                wrapped_vault_key: Some(vec![0u8; 81])
            })
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST
    );
    let body = status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", vault.id))
            .json(&CreateInvitationRequest {
                email: "carol@t.io".into(),
                role: Role::Writer,
                wrapped_vault_key: None
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );
    let inv: Invitation = serde_json::from_str(&body).unwrap();
    assert!(!inv.has_key && inv.invitee_public_key.is_none());

    // Carol peut maintenant s'inscrire (invitée), accepte → awaiting_key.
    let carol = User::register(&server, "carol@t.io", "pw-c").await;
    let s = carol.sync().await;
    assert_eq!(s.invitations.len(), 1);
    let body = status!(
        carol
            .req(reqwest::Method::POST, &format!("/invitations/{}/accept", inv.id))
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let inv: Invitation = serde_json::from_str(&body).unwrap();
    assert_eq!(inv.status, InvitationStatus::AwaitingKey);
    assert!(
        carol.sync().await.vaults.iter().all(|v| v.id != vault.id),
        "pas encore membre"
    );

    // Alice voit l'invitation avec la clé publique de Carol, vérifie
    // l'empreinte, complète → Carol devient membre.
    let list: Vec<Invitation> = alice.get(&format!("/vaults/{}/invitations", vault.id)).await;
    let pending = list.iter().find(|i| i.id == inv.id).unwrap();
    assert_eq!(pending.status, InvitationStatus::AwaitingKey);
    let carol_pk = gc::PublicKey::try_from(pending.invitee_public_key.as_deref().unwrap()).unwrap();
    assert_eq!(
        pending.invitee_fingerprint.as_deref(),
        Some(gc::fingerprint(&carol.account.keypair.public).as_str())
    );
    let body = status!(
        alice
            .req(reqwest::Method::POST, &format!("/invitations/{}/complete", inv.id))
            .json(&CompleteInvitationRequest {
                wrapped_vault_key: gc::wrap_vault_key(&carol_pk, &vkey).unwrap()
            })
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let inv: Invitation = serde_json::from_str(&body).unwrap();
    assert_eq!(inv.status, InvitationStatus::Accepted);
    let s = carol.sync().await;
    let v = s.vaults.iter().find(|v| v.id == vault.id).unwrap();
    assert_eq!(v.role, Role::Writer);
    let ck = carol.vault_key(v);
    let page: ItemsPage = carol.get(&format!("/vaults/{}/items", vault.id)).await;
    assert_eq!(carol.open_item(&ck, &page.items[0]), "bastion");

    // Carol (writer) ne peut pas inviter ; elle peut partir.
    status!(
        carol
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", vault.id))
            .json(&CreateInvitationRequest {
                email: "dave@t.io".into(),
                role: Role::Reader,
                wrapped_vault_key: None
            })
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );
    status!(
        carol
            .req(reqwest::Method::POST, &format!("/vaults/{}/leave", vault.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(carol.sync().await.vaults.iter().all(|v| v.id != vault.id));
    server.stop().await;
}

#[tokio::test]
async fn sessions_refresh_rotation_and_password_change() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let mut alice = User::register(&server, "alice@t.io", "pw").await;
    let phone = User::login(&server, "alice@t.io", "pw").await.unwrap();

    let sessions: Vec<Session> = alice.get("/auth/sessions").await;
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions.iter().filter(|s| s.current).count(), 1);

    // Rotation du refresh : l'ancien refresh ne marche plus, et le rejouer
    // révoque la session entière (détection de vol).
    let old = alice.tokens.clone();
    let body = status!(
        alice
            .http
            .post(format!("{}/auth/refresh", server.base))
            .json(&RefreshRequest {
                refresh_token: old.refresh_token.clone()
            })
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let fresh: TokenPair = serde_json::from_str(&body).unwrap();
    assert_ne!(fresh.access_token, old.access_token);
    // L'ancien access est mort, le nouveau vit.
    status!(
        alice
            .http
            .get(format!("{}/users/me", server.base))
            .bearer_auth(&old.access_token)
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED
    );
    status!(
        alice
            .http
            .get(format!("{}/users/me", server.base))
            .bearer_auth(&fresh.access_token)
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    // Rejeu de l'ancien refresh → 401 ET le nouveau access tombe aussi.
    status!(
        alice
            .http
            .post(format!("{}/auth/refresh", server.base))
            .json(&RefreshRequest {
                refresh_token: old.refresh_token
            })
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED
    );
    status!(
        alice
            .http
            .get(format!("{}/users/me", server.base))
            .bearer_auth(&fresh.access_token)
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED
    );

    // Reconnexion, puis changement de mot de passe : le téléphone est déconnecté.
    alice = User::login(&server, "alice@t.io", "pw").await.unwrap();
    let pre: PreloginResponse = alice
        .http
        .post(format!("{}/auth/prelogin", server.base))
        .json(&PreloginRequest {
            email: "alice@t.io".into(),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let current = gc::prepare_login("pw", &pre.kdf_salt, pre.kdf).unwrap();
    let rk = gc::rekey_account(&alice.account, "pw-2").unwrap();
    status!(
        alice
            .req(reqwest::Method::POST, "/auth/password")
            .json(&ChangePasswordRequest {
                current_auth_key: current.auth_key.as_bytes().to_vec(),
                kdf: rk.kdf,
                kdf_salt: rk.kdf_salt,
                auth_key: rk.auth_key,
                protected_user_key: rk.protected_user_key,
            })
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    status!(
        phone.req(reqwest::Method::GET, "/users/me").send().await.unwrap(),
        StatusCode::UNAUTHORIZED
    );
    status!(
        alice.req(reqwest::Method::GET, "/users/me").send().await.unwrap(),
        StatusCode::OK
    );
    assert!(User::login(&server, "alice@t.io", "pw").await.is_err());
    let again = User::login(&server, "alice@t.io", "pw-2").await.unwrap();
    assert_eq!(
        again.account.user_key.as_bytes(),
        alice.account.user_key.as_bytes(),
        "la user key survit au changement"
    );
    let _ = (&alice.email, &alice.password);

    // Déconnexion.
    status!(
        alice.req(reqwest::Method::POST, "/auth/logout").send().await.unwrap(),
        StatusCode::NO_CONTENT
    );
    status!(
        alice.req(reqwest::Method::GET, "/users/me").send().await.unwrap(),
        StatusCode::UNAUTHORIZED
    );
    server.stop().await;
}

#[tokio::test]
async fn auth_routes_are_rate_limited_per_ip() {
    let Some(server) = TestServer::start_with(RegistrationMode::Open, |c| {
        c.auth_rate_burst = 3;
        c.auth_rate_per_second = 1;
    })
    .await
    else {
        return;
    };
    let http = Client::new();
    let mut codes = vec![];
    for _ in 0..5 {
        let r = http
            .post(format!("{}/auth/prelogin", server.base))
            .json(&PreloginRequest { email: "a@b.io".into() })
            .send()
            .await
            .unwrap();
        codes.push(r.status());
    }
    assert_eq!(codes[..3], [StatusCode::OK, StatusCode::OK, StatusCode::OK]);
    assert_eq!(codes[3], StatusCode::TOO_MANY_REQUESTS);
    // Les routes authentifiées ne sont pas concernées.
    status!(
        http.get(format!("{}/health", server.base)).send().await.unwrap(),
        StatusCode::OK
    );
    server.stop().await;
}

#[tokio::test]
async fn totp_second_factor_and_recovery_codes() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw").await;
    let st: TotpStatus = alice.get("/auth/totp").await;
    assert!(!st.enabled);

    let body = status!(
        alice
            .req(reqwest::Method::POST, "/auth/totp/setup")
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let setup: TotpSetupResponse = serde_json::from_str(&body).unwrap();
    assert!(
        setup.otpauth_url.starts_with("otpauth://totp/GuiVault:alice%40t.io?")
            || setup.otpauth_url.contains("issuer=GuiVault"),
        "{}",
        setup.otpauth_url
    );
    let totp = totp_rs::TOTP::new(
        totp_rs::Algorithm::SHA1,
        6,
        1,
        30,
        totp_rs::Secret::Encoded(setup.secret.clone()).to_bytes().unwrap(),
        Some("GuiVault".into()),
        "alice@t.io".into(),
    )
    .unwrap();

    // Tant que rien n'est confirmé, la connexion reste en une étape.
    User::login(&server, "alice@t.io", "pw").await.unwrap();
    status!(
        alice
            .req(reqwest::Method::POST, "/auth/totp/enable")
            .json(&TotpCodeRequest { code: "000000".into() })
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED
    );
    let body = status!(
        alice
            .req(reqwest::Method::POST, "/auth/totp/enable")
            .json(&TotpCodeRequest {
                code: totp.generate_current().unwrap()
            })
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let enabled: TotpEnableResponse = serde_json::from_str(&body).unwrap();
    assert_eq!(enabled.recovery_codes.len(), 8);
    let st: TotpStatus = alice.get("/auth/totp").await;
    assert!(st.enabled);

    // Connexion en deux temps : 202 + défi, puis le code.
    let http = Client::new();
    let pre: PreloginResponse = http
        .post(format!("{}/auth/prelogin", server.base))
        .json(&PreloginRequest {
            email: "alice@t.io".into(),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lm = gc::prepare_login("pw", &pre.kdf_salt, pre.kdf).unwrap();
    let login = || {
        http.post(format!("{}/auth/login", server.base)).json(&LoginRequest {
            email: "alice@t.io".into(),
            auth_key: lm.auth_key.as_bytes().to_vec(),
            device_name: Some("phone".into()),
        })
    };
    let body = status!(login().send().await.unwrap(), StatusCode::ACCEPTED);
    let ch: TotpChallenge = serde_json::from_str(&body).unwrap();
    let verify = |token: String, code: String| {
        http.post(format!("{}/auth/totp/verify", server.base))
            .json(&TotpVerifyRequest {
                totp_token: token,
                code,
            })
    };
    status!(
        verify(ch.totp_token.clone(), "123456".into()).send().await.unwrap(),
        StatusCode::UNAUTHORIZED
    );
    let body = status!(
        verify(ch.totp_token.clone(), totp.generate_current().unwrap())
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let session: LoginResponse = serde_json::from_str(&body).unwrap();
    assert_eq!(session.user.email, "alice@t.io");
    // Le défi est consommé.
    status!(
        verify(ch.totp_token, totp.generate_current().unwrap())
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED
    );
    // La session obtenue marche, et son appareil est celui du premier temps.
    let sessions: Vec<Session> = http
        .get(format!("{}/auth/sessions", server.base))
        .bearer_auth(&session.tokens.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        sessions
            .iter()
            .any(|s| s.current && s.device_name.as_deref() == Some("phone"))
    );

    // Code de récupération : une fois, pas deux.
    let body = status!(login().send().await.unwrap(), StatusCode::ACCEPTED);
    let ch: TotpChallenge = serde_json::from_str(&body).unwrap();
    let rc = enabled.recovery_codes[0].clone();
    status!(
        verify(ch.totp_token, rc.to_uppercase()).send().await.unwrap(),
        StatusCode::OK
    );
    let body = status!(login().send().await.unwrap(), StatusCode::ACCEPTED);
    let ch: TotpChallenge = serde_json::from_str(&body).unwrap();
    status!(
        verify(ch.totp_token.clone(), rc).send().await.unwrap(),
        StatusCode::UNAUTHORIZED
    );
    // Cinq échecs et le défi meurt.
    for _ in 0..4 {
        status!(
            verify(ch.totp_token.clone(), "000000".into()).send().await.unwrap(),
            StatusCode::UNAUTHORIZED
        );
    }
    let body = status!(
        verify(ch.totp_token, totp.generate_current().unwrap())
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED
    );
    assert!(body.contains("challenge_expired"), "{body}");

    // Désactivation avec un code, puis connexion en une étape.
    status!(
        alice
            .req(reqwest::Method::POST, "/auth/totp/disable")
            .json(&TotpCodeRequest {
                code: totp.generate_current().unwrap()
            })
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    status!(login().send().await.unwrap(), StatusCode::OK);
    server.stop().await;
}

#[tokio::test]
async fn events_stream_notifies_vault_members() {
    use futures_util::StreamExt;
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-a").await;
    let bob = User::register(&server, "bob@t.io", "pw-b").await;
    let (vault, vkey) = alice.create_vault("Ops").await;
    let lookup: UserLookupResponse = alice.get("/users/lookup?email=bob@t.io").await;
    let bob_pk = gc::PublicKey::try_from(lookup.public_key.as_slice()).unwrap();

    // Bob écoute avant que quoi que ce soit n'arrive.
    let resp = bob.req(reqwest::Method::GET, "/events").send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        resp.headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    // Lit jusqu'à une ligne `data:` complète (ignore les `: ping`).
    async fn next_event<S>(stream: &mut S, buf: &mut String) -> ServerEvent
    where
        S: futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Unpin,
    {
        loop {
            if let Some(pos) = buf.find("\n\n") {
                let block = buf[..pos].to_string();
                buf.replace_range(..pos + 2, "");
                if let Some(data) = block.lines().find_map(|l| l.strip_prefix("data:")) {
                    return serde_json::from_str::<ServerEvent>(data.trim()).unwrap();
                }
                continue;
            }
            let chunk = tokio::time::timeout(Duration::from_secs(10), stream.next())
                .await
                .expect("événement attendu")
                .unwrap()
                .unwrap();
            buf.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }

    // Invitation → Bob est prévenu.
    let body = status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", vault.id))
            .json(&CreateInvitationRequest {
                email: "bob@t.io".into(),
                role: Role::Writer,
                wrapped_vault_key: Some(gc::wrap_vault_key(&bob_pk, &vkey).unwrap())
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );
    let inv: Invitation = serde_json::from_str(&body).unwrap();
    assert_eq!(
        next_event(&mut stream, &mut buf).await,
        ServerEvent::InvitationReceived {
            invitation_id: inv.id,
            vault_id: vault.id
        }
    );

    // Acceptation → les membres (dont Bob lui-même, désormais) sont prévenus.
    status!(
        bob.req(reqwest::Method::POST, &format!("/invitations/{}/accept", inv.id))
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    assert_eq!(
        next_event(&mut stream, &mut buf).await,
        ServerEvent::MembershipChanged { vault_id: vault.id }
    );

    // Écriture d'Alice → Bob reçoit la nouvelle révision.
    status!(
        alice.put_item(vault.id, &vkey, Uuid::new_v4(), "host", "x", None).await,
        StatusCode::CREATED
    );
    assert_eq!(
        next_event(&mut stream, &mut buf).await,
        ServerEvent::VaultChanged {
            vault_id: vault.id,
            revision: 1
        }
    );

    // Un vault dont Bob n'est pas membre ne le concerne pas : rien ne vient
    // (le prochain événement est celui de la suppression de son vault).
    let (other, okey) = alice.create_vault("Privé").await;
    status!(
        alice.put_item(other.id, &okey, Uuid::new_v4(), "host", "y", None).await,
        StatusCode::CREATED
    );
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{}", vault.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        next_event(&mut stream, &mut buf).await,
        ServerEvent::MembershipChanged { vault_id: vault.id }
    );
    server.stop().await;
}

#[tokio::test]
async fn user_settings_follow_the_account_across_devices() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let desk = User::register(&server, "alice@t.io", "pw-a").await;
    let laptop = User::login(&server, "alice@t.io", "pw-a").await.unwrap();
    let bob = User::register(&server, "bob@t.io", "pw-b").await;

    // Rien d'envoyé : `null`.
    let none: Option<UserSettings> = desk.get("/users/me/settings").await;
    assert!(none.is_none());

    // Le bureau envoie ses réglages, scellés sous la user key.
    let json = br#"{"appearance":{"uiAccent":"violet"}}"#;
    let blob = gc::seal_user_settings(&desk.account.user_key, json).unwrap();
    let body = status!(
        desk.req(reqwest::Method::PUT, "/users/me/settings")
            .json(&PutUserSettingsRequest {
                blob: blob.clone(),
                base_revision: None
            })
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let saved: UserSettings = serde_json::from_str(&body).unwrap();
    assert_eq!(saved.revision, 1);

    // L'autre appareil les relit et les ouvre avec la même user key.
    let got: Option<UserSettings> = laptop.get("/users/me/settings").await;
    let got = got.expect("réglages présents");
    assert_eq!(got.revision, 1);
    assert_eq!(
        gc::open_user_settings(&laptop.account.user_key, &got.blob).unwrap(),
        json
    );

    // Écrire sans avoir lu la dernière révision : 409, avec la courante.
    let blob2 = gc::seal_user_settings(&laptop.account.user_key, br#"{"appearance":{}}"#).unwrap();
    let body = status!(
        laptop
            .req(reqwest::Method::PUT, "/users/me/settings")
            .json(&PutUserSettingsRequest {
                blob: blob2.clone(),
                base_revision: None
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CONFLICT
    );
    assert!(
        body.contains("revision_mismatch") && body.contains("\"revision\":1"),
        "{body}"
    );
    let body = status!(
        laptop
            .req(reqwest::Method::PUT, "/users/me/settings")
            .json(&PutUserSettingsRequest {
                blob: blob2,
                base_revision: Some(1)
            })
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    assert_eq!(serde_json::from_str::<UserSettings>(&body).unwrap().revision, 2);

    // Chacun les siens.
    let theirs: Option<UserSettings> = bob.get("/users/me/settings").await;
    assert!(theirs.is_none());

    // Un blob qui n'en est pas un est refusé.
    status!(
        bob.req(reqwest::Method::PUT, "/users/me/settings")
            .json(&PutUserSettingsRequest {
                blob: vec![1, 2, 3],
                base_revision: None
            })
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST
    );
    server.stop().await;
}
