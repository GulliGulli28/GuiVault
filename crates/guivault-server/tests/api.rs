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
    /// La configuration du serveur lancé (pour ses tâches de fond).
    config: Config,
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
            item_history: 20,
            trash_days: 30,
            send_max_days: 30,
            health_lookups: false,
            hibp_url: String::new(),
            twofa_directory_url: String::new(),
            allowed_ips: Default::default(),
            admin_allowed_ips: Default::default(),
            quota_bytes: 0,
            backup: None,
            mail: None,
            auth_rate_burst: 1000,
            auth_rate_per_second: 1000,
            log_json: false,
        };
        tweak(&mut config);
        let kept = config.clone();
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
            config: kept,
            db_name,
            admin_url,
            shutdown: Some(stop_tx),
        })
    }

    /// La base de ce serveur, pour simuler le temps qui passe.
    async fn db(&self) -> sqlx::PgPool {
        let mut u = url::Url::parse(&self.admin_url).unwrap();
        u.set_path(&self.db_name);
        sqlx::PgPool::connect(u.as_str()).await.unwrap()
    }

    fn db_url(&self) -> String {
        let mut u = url::Url::parse(&self.admin_url).unwrap();
        u.set_path(&self.db_name);
        u.to_string()
    }

    /// Une base vide de plus sur le même Postgres (restaurations) : son URL
    /// et son nom, pour `drop_database`.
    async fn fresh_database(&self) -> (String, String) {
        let admin = sqlx::PgPool::connect(&self.admin_url).await.unwrap();
        let name = format!("guivault_t_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        let mut u = url::Url::parse(&self.admin_url).unwrap();
        u.set_path(&name);
        (u.to_string(), name)
    }

    async fn drop_database(&self, name: &str) {
        let admin = sqlx::PgPool::connect(&self.admin_url).await.unwrap();
        let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
            .execute(&admin)
            .await;
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
                wrapped_vault_key: gc::wrap_vault_key(
                    &account.keypair,
                    &account.keypair.public,
                    &personal_id.to_string(),
                    &personal_key,
                )
                .unwrap(),
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
        gc::unwrap_vault_key(&self.account, &v.id.to_string(), &v.wrapped_vault_key)
            .expect("clé de vault ouvrable")
            .key
    }

    async fn create_vault(&self, name: &str) -> (Vault, gc::SymmetricKey) {
        let key = gc::SymmetricKey::random();
        let id = Uuid::new_v4();
        let req = CreateVaultRequest {
            id,
            name_enc: gc::seal_vault_name(&key, &id.to_string(), name).unwrap(),
            wrapped_vault_key: gc::wrap_vault_key(
                &self.account.keypair,
                &self.account.keypair.public,
                &id.to_string(),
                &key,
            )
            .unwrap(),
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
    // Les paramètres fictifs passent le plancher des clients : sinon un
    // e-mail inconnu échouerait côté client avant le 401, et se trahirait.
    assert!(p1.kdf.is_sane());

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
            wrapped_vault_key: gc::wrap_vault_key(&a.keypair, &a.keypair.public, &pid.to_string(), &k).unwrap(),
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
                wrapped_vault_key: Some(
                    gc::wrap_vault_key(&alice.account.keypair, &bob_pk, &vault.id.to_string(), &vkey).unwrap()
                ),
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
    // Avant d'accepter, Bob ouvre l'enveloppe qui accompagne l'invitation :
    // elle vient bien de la clé d'Alice (dont il vérifiera l'empreinte).
    let envelope = s.invitations[0].wrapped_vault_key.as_deref().expect("enveloppe jointe");
    let opened = gc::unwrap_vault_key(&bob.account, &vault.id.to_string(), envelope).unwrap();
    assert_eq!(opened.sender.as_ref(), Some(&alice.account.keypair.public));
    assert_eq!(opened.key.as_bytes(), vkey.as_bytes());
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
            wrapped_vault_key: gc::wrap_vault_key(
                &alice.account.keypair,
                &alice.account.keypair.public,
                &vault.id.to_string(),
                &new_key,
            )
            .unwrap(),
        }],
        items: rotated,
        versions: None,
        emergency: None,
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
            wrapped_vault_key: gc::wrap_vault_key(&a.keypair, &a.keypair.public, &pid.to_string(), &k).unwrap(),
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
                wrapped_vault_key: gc::wrap_vault_key(&alice.account.keypair, &carol_pk, &vault.id.to_string(), &vkey)
                    .unwrap()
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
                wrapped_vault_key: Some(
                    gc::wrap_vault_key(&alice.account.keypair, &bob_pk, &vault.id.to_string(), &vkey).unwrap()
                )
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

#[tokio::test]
async fn item_history_trash_restore_and_rotation() {
    let Some(server) = TestServer::start_with(RegistrationMode::Open, |c| c.item_history = 3).await else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw").await;
    let (vault, key) = alice.create_vault("Équipe").await;
    let vid = vault.id;
    let open = |key: &gc::SymmetricKey, item_id: Uuid, item_type: &str, ct: &[u8]| {
        String::from_utf8(gc::open_item(key, &vid.to_string(), &item_id.to_string(), item_type, ct).unwrap()).unwrap()
    };
    let put_raw = |item_id: Uuid, ciphertext: Vec<u8>, base_revision: Option<i64>| {
        alice
            .req(reqwest::Method::PUT, &format!("/vaults/{vid}/items/{item_id}"))
            .json(&PutItemRequest {
                item_type: "note".into(),
                ciphertext,
                base_revision,
            })
            .send()
    };
    let trash_path = format!("/vaults/{vid}/trash");
    let trash = || alice.get::<Vec<TrashedItem>>(&trash_path);

    // v1 … v5 : l'historique garde les trois dernières versions remplacées.
    let id = Uuid::new_v4();
    let mut rev = None;
    for n in 1..=5 {
        let expected = if n == 1 { StatusCode::CREATED } else { StatusCode::OK };
        let body = status!(
            alice.put_item(vid, &key, id, "note", &format!("v{n}"), rev).await,
            expected
        );
        rev = Some(serde_json::from_str::<Item>(&body).unwrap().revision);
    }
    let versions: Vec<ItemVersion> = alice.get(&format!("/vaults/{vid}/items/{id}/versions")).await;
    let texts: Vec<String> = versions.iter().map(|v| open(&key, id, "note", &v.ciphertext)).collect();
    assert_eq!(texts, ["v4", "v3", "v2"]);
    assert_eq!(versions[0].replaced_by.as_deref(), Some("alice@t.io"));

    // Restaurer v2 : la renvoyer telle quelle (même clé, même AAD).
    let body = status!(
        put_raw(id, versions[2].ciphertext.clone(), rev).await.unwrap(),
        StatusCode::OK
    );
    let restored: Item = serde_json::from_str(&body).unwrap();
    assert_eq!(alice.open_item(&key, &restored), "v2");

    // Supprimer → la corbeille, avec la dernière version et qui l'a supprimé.
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{vid}/items/{id}"))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    let t = trash().await;
    assert_eq!(t.len(), 1);
    assert_eq!(open(&key, id, "note", &t[0].ciphertext), "v2");
    assert_eq!(t[0].deleted_by.as_deref(), Some("alice@t.io"));
    assert!(t[0].expires_at > t[0].deleted_at);

    // … d'où il revient (création : base None), et n'y est plus.
    status!(
        put_raw(id, t[0].ciphertext.clone(), None).await.unwrap(),
        StatusCode::CREATED
    );
    assert!(trash().await.is_empty());

    // Un déplacement vers un autre vault n'est pas une suppression.
    let moved = Uuid::new_v4();
    status!(
        alice.put_item(vid, &key, moved, "note", "partira", None).await,
        StatusCode::CREATED
    );
    status!(
        alice
            .req(
                reqwest::Method::DELETE,
                &format!("/vaults/{vid}/items/{moved}?moved=true")
            )
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(trash().await.is_empty());

    // Supprimer définitivement ; un item vivant n'est pas dans la corbeille.
    let gone = Uuid::new_v4();
    status!(
        alice.put_item(vid, &key, gone, "note", "à jeter", None).await,
        StatusCode::CREATED
    );
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{vid}/trash/{id}"))
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{vid}/items/{gone}"))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(trash().await.len(), 1);
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{vid}/trash/{gone}"))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(trash().await.is_empty());

    // Une corbeille non vide et un historique, pour la rotation.
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/vaults/{vid}/items/{id}"))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    let all: Vec<ItemVersion> = alice.get(&format!("/vaults/{vid}/versions")).await;
    assert!(!all.is_empty());

    // Rotation (plus aucun item vivant : seules les versions sont à
    // re-chiffrer) : toutes sous la nouvelle clé, sinon refus.
    let rotation =
        |new_key: &gc::SymmetricKey, versions: Option<Vec<RotatedVersion>>, base: i64| RotateVaultKeyRequest {
            name_enc: gc::seal_vault_name(new_key, &vid.to_string(), "Équipe").unwrap(),
            members: vec![RotatedMemberKey {
                user_id: alice.profile.id,
                wrapped_vault_key: gc::wrap_vault_key(
                    &alice.account.keypair,
                    &alice.account.keypair.public,
                    &vid.to_string(),
                    new_key,
                )
                .unwrap(),
            }],
            items: vec![],
            versions,
            emergency: None,
            base_revision: base,
        };
    let new_key = gc::SymmetricKey::random();
    let reseal = |v: &ItemVersion| RotatedVersion {
        item_id: v.item_id,
        revision: v.revision,
        ciphertext: gc::seal_item(
            &new_key,
            &vid.to_string(),
            &v.item_id.to_string(),
            &v.item_type,
            &gc::open_item(
                &key,
                &vid.to_string(),
                &v.item_id.to_string(),
                &v.item_type,
                &v.ciphertext,
            )
            .unwrap(),
        )
        .unwrap(),
    };
    let base = alice.get::<Vault>(&format!("/vaults/{vid}")).await.revision;
    let mut partial: Vec<RotatedVersion> = all.iter().map(reseal).collect();
    partial.pop();
    let body = status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{vid}/rotate-key"))
            .json(&rotation(&new_key, Some(partial), base))
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST
    );
    assert!(body.contains("incomplete_rotation"), "{body}");
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{vid}/rotate-key"))
            .json(&rotation(&new_key, Some(all.iter().map(reseal).collect()), base))
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let t = trash().await;
    assert_eq!(t.len(), 1);
    assert_eq!(
        open(&new_key, id, "note", &t[0].ciphertext),
        "v2",
        "la corbeille survit à la rotation"
    );
    let after: Vec<ItemVersion> = alice.get(&format!("/vaults/{vid}/versions")).await;
    assert_eq!(after.len(), all.len());
    for v in &after {
        open(&new_key, v.item_id, &v.item_type, &v.ciphertext);
    }

    // Un client d'avant l'historique ne sait pas les re-chiffrer : effacées.
    let newer_key = gc::SymmetricKey::random();
    let base = alice.get::<Vault>(&format!("/vaults/{vid}")).await.revision;
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{vid}/rotate-key"))
            .json(&rotation(&newer_key, None, base))
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    assert!(
        alice
            .get::<Vec<ItemVersion>>(&format!("/vaults/{vid}/versions"))
            .await
            .is_empty()
    );
    server.stop().await;
}

// ─── Liens de partage ───────────────────────────────────────────────────────

fn fast_kdf() -> KdfParams {
    KdfParams {
        m_cost: 19_456,
        t_cost: 2,
        p_cost: 1,
    }
}

/// Ce que fait le client pour créer un lien : secret, clés, contenu scellé,
/// fiche de l'auteur sous sa user key.
fn new_send(
    user: &User,
    text: &str,
    password: Option<&str>,
    max_views: Option<u32>,
    expires_in_secs: u64,
) -> (CreateSendRequest, Vec<u8>) {
    let id = Uuid::new_v4();
    let secret = gc::random_bytes(gc::SEND_SECRET_LEN);
    let (pw_key, password) = match password {
        Some(pw) => {
            let salt = gc::random_salt().to_vec();
            let key = gc::send_password_key(pw, &salt, fast_kdf()).unwrap();
            (Some(key), Some(SendPassword { kdf: fast_kdf(), salt }))
        }
        None => (None, None),
    };
    let keys = gc::send_keys(&secret, pw_key.as_ref()).unwrap();
    let owner = serde_json::json!({ "name": text, "secret": secret }).to_string();
    let req = CreateSendRequest {
        id,
        ciphertext: gc::seal_send(&keys, &id.to_string(), text.as_bytes()).unwrap(),
        access_hash: gc::token_hash(keys.access.as_bytes()).to_vec(),
        owner_blob: gc::seal_send_owner(&user.account.user_key, &id.to_string(), owner.as_bytes()).unwrap(),
        password,
        max_views,
        expires_in_secs,
    };
    (req, secret)
}

#[tokio::test]
async fn send_links_need_their_key_count_views_and_expire() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw").await;
    let bob = User::register(&server, "bob@t.io", "pw").await;
    let anon = Client::new();
    let h: HealthResponse = anon
        .get(format!("{}/health", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(h.send_max_days, 30);
    let create = |req: &CreateSendRequest| alice.req(reqwest::Method::POST, "/sends").json(req).send();
    let info = |id: Uuid| anon.get(format!("{}/sends/{id}/access", server.base)).send();
    let access = |id: Uuid, key: Vec<u8>| {
        anon.post(format!("{}/sends/{id}/access", server.base))
            .json(&SendAccessRequest { access_key: key })
            .send()
    };

    // Deux vues au plus, sans mot de passe.
    let (req, secret) = new_send(&alice, "code du portail : 4321", None, Some(2), 3600);
    let id = req.id;
    let body = status!(create(&req).await.unwrap(), StatusCode::CREATED);
    let summary: SendSummary = serde_json::from_str(&body).unwrap();
    assert!(summary.available && !summary.has_password);
    assert_eq!((summary.views, summary.max_views), (0, Some(2)));
    status!(create(&req).await.unwrap(), StatusCode::CONFLICT);

    let body = status!(info(id).await.unwrap(), StatusCode::OK);
    let i: SendInfo = serde_json::from_str(&body).unwrap();
    assert!(i.password.is_none());
    assert_eq!(i.views_left, Some(2));

    // Sans la clé (le serveur n'a que l'identifiant) : refusé, rien de consommé.
    let body = status!(access(id, gc::random_bytes(32)).await.unwrap(), StatusCode::FORBIDDEN);
    assert!(body.contains("invalid_send_key"));
    status!(access(id, vec![1; 12]).await.unwrap(), StatusCode::BAD_REQUEST);

    // Avec : le contenu, qui s'ouvre avec le secret du lien.
    let keys = gc::send_keys(&secret, None).unwrap();
    for left in [1, 0] {
        let body = status!(
            access(id, keys.access.as_bytes().to_vec()).await.unwrap(),
            StatusCode::OK
        );
        let content: SendContent = serde_json::from_str(&body).unwrap();
        assert_eq!(content.views_left, Some(left));
        assert_eq!(
            gc::open_send(&keys, &id.to_string(), &content.ciphertext).unwrap(),
            b"code du portail : 4321"
        );
    }
    // Épuisé : introuvable, et le chiffré n'est plus gardé.
    let body = status!(
        access(id, keys.access.as_bytes().to_vec()).await.unwrap(),
        StatusCode::NOT_FOUND
    );
    assert!(body.contains("send_unavailable"));
    status!(info(id).await.unwrap(), StatusCode::NOT_FOUND);
    let db = server.db().await;
    let (kept,): (bool,) = sqlx::query_as("SELECT ciphertext IS NOT NULL FROM sends WHERE id = $1")
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert!(!kept);

    // L'auteur voit ses liens et en relit la fiche.
    let mine: Vec<SendSummary> = alice.get("/sends").await;
    assert_eq!(mine.len(), 1);
    assert!(!mine[0].available);
    assert_eq!(mine[0].views, 2);
    let owner = gc::open_send_owner(&alice.account.user_key, &id.to_string(), &mine[0].owner_blob).unwrap();
    assert!(String::from_utf8(owner).unwrap().contains("portail"));
    assert!(bob.get::<Vec<SendSummary>>("/sends").await.is_empty());

    // Avec mot de passe : il faut les deux ; le lien seul ne donne pas la clé.
    let (req, secret) = new_send(&alice, "PIN 0000", Some("fromage"), None, 86_400);
    let id = req.id;
    status!(create(&req).await.unwrap(), StatusCode::CREATED);
    let i: SendInfo = serde_json::from_str(&status!(info(id).await.unwrap(), StatusCode::OK)).unwrap();
    let pw = i.password.expect("mot de passe annoncé");
    assert_eq!(i.views_left, None);
    let without = gc::send_keys(&secret, None).unwrap();
    status!(
        access(id, without.access.as_bytes().to_vec()).await.unwrap(),
        StatusCode::FORBIDDEN
    );
    let wrong = gc::send_keys(&secret, Some(&gc::send_password_key("brie", &pw.salt, pw.kdf).unwrap())).unwrap();
    status!(
        access(id, wrong.access.as_bytes().to_vec()).await.unwrap(),
        StatusCode::FORBIDDEN
    );
    let right = gc::send_keys(
        &secret,
        Some(&gc::send_password_key("fromage", &pw.salt, pw.kdf).unwrap()),
    )
    .unwrap();
    let body = status!(
        access(id, right.access.as_bytes().to_vec()).await.unwrap(),
        StatusCode::OK
    );
    let content: SendContent = serde_json::from_str(&body).unwrap();
    assert_eq!(
        gc::open_send(&right, &id.to_string(), &content.ciphertext).unwrap(),
        b"PIN 0000"
    );

    // Bornes : durée de vie, vues, tailles.
    let (mut bad, _) = new_send(&alice, "x", None, None, 60);
    status!(create(&bad).await.unwrap(), StatusCode::BAD_REQUEST);
    bad.expires_in_secs = 31 * 86_400;
    status!(create(&bad).await.unwrap(), StatusCode::BAD_REQUEST);
    bad.expires_in_secs = 3600;
    bad.max_views = Some(0);
    status!(create(&bad).await.unwrap(), StatusCode::BAD_REQUEST);
    bad.max_views = None;
    bad.access_hash.pop();
    status!(create(&bad).await.unwrap(), StatusCode::BAD_REQUEST);

    // Supprimer : l'auteur seul ; ensuite, plus rien.
    status!(
        bob.req(reqwest::Method::DELETE, &format!("/sends/{id}"))
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/sends/{id}"))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    status!(info(id).await.unwrap(), StatusCode::NOT_FOUND);

    // Expiré : introuvable tout de suite, effacé au passage suivant.
    let (req, _) = new_send(&alice, "bientôt périmé", None, None, 3600);
    status!(create(&req).await.unwrap(), StatusCode::CREATED);
    sqlx::query("UPDATE sends SET expires_at = now() - interval '1 second' WHERE id = $1")
        .bind(req.id)
        .execute(&db)
        .await
        .unwrap();
    status!(info(req.id).await.unwrap(), StatusCode::NOT_FOUND);
    assert!(guivault_server::routes::sends::prune(&db).await.unwrap() >= 1);
    assert!(
        alice
            .get::<Vec<SendSummary>>("/sends")
            .await
            .iter()
            .all(|s| s.id != req.id)
    );

    // Chaque création et ouverture laisse une trace ; celles de l'auteur
    // sont dans son journal.
    let audit: Vec<serde_json::Value> = alice.get("/users/me/audit").await;
    assert!(audit.iter().any(|e| e["action"] == "send.create"));
    assert!(audit.iter().any(|e| e["action"] == "send.delete"));
    server.stop().await;

    // Désactivés sur ce serveur : ni création, ni ouverture.
    let Some(server) = TestServer::start_with(RegistrationMode::Open, |c| c.send_max_days = 0).await else {
        return;
    };
    let carol = User::register(&server, "carol@t.io", "pw").await;
    let (req, _) = new_send(&carol, "x", None, None, 3600);
    status!(
        carol
            .req(reqwest::Method::POST, "/sends")
            .json(&req)
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );
    status!(
        Client::new()
            .get(format!("{}/sends/{}/access", server.base, req.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );
    server.stop().await;
}

// ─── Accès d'urgence ────────────────────────────────────────────────────────

#[tokio::test]
async fn emergency_access_waits_then_opens_owned_vaults_read_only() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw").await;
    let bob = User::register(&server, "bob@t.io", "pw").await;
    let carol = User::register(&server, "carol@t.io", "pw").await;
    let db = server.db().await;

    // Alice : son vault personnel et un vault « Famille » avec un item.
    let personal = alice.sync().await.vaults.remove(0);
    let personal_key = alice.vault_key(&personal);
    let (famille, famille_key) = alice.create_vault("Famille").await;
    let item_id = Uuid::new_v4();
    status!(
        alice
            .put_item(famille.id, &famille_key, item_id, "login", "banque", None)
            .await,
        StatusCode::CREATED
    );

    // Elle désigne Bob (clé publique vérifiée) pour ces deux vaults, 7 jours.
    let lookup: UserLookupResponse = alice.get("/users/lookup?email=bob@t.io").await;
    let bob_pk = gc::PublicKey::try_from(lookup.public_key.as_slice()).unwrap();
    let envelope = |vault_id: Uuid, key: &gc::SymmetricKey| EmergencyVaultKey {
        vault_id,
        wrapped_vault_key: gc::wrap_emergency_key(&alice.account.keypair, &bob_pk, &vault_id.to_string(), key).unwrap(),
    };
    let create = |req: &CreateEmergencyGrantRequest| alice.req(reqwest::Method::POST, "/emergency").json(req).send();
    let mut req = CreateEmergencyGrantRequest {
        grantee_id: bob.profile.id,
        wait_days: 0,
        vaults: vec![envelope(personal.id, &personal_key), envelope(famille.id, &famille_key)],
    };
    status!(create(&req).await.unwrap(), StatusCode::BAD_REQUEST);
    req.wait_days = 7;
    // On ne confie que ce qu'on possède.
    let bob_personal = bob.sync().await.vaults.remove(0);
    let mut foreign = req.clone();
    foreign
        .vaults
        .push(envelope(bob_personal.id, &gc::SymmetricKey::random()));
    status!(create(&foreign).await.unwrap(), StatusCode::FORBIDDEN);
    let mut to_self = req.clone();
    to_self.grantee_id = alice.profile.id;
    status!(create(&to_self).await.unwrap(), StatusCode::BAD_REQUEST);
    let body = status!(create(&req).await.unwrap(), StatusCode::CREATED);
    let grant: EmergencyGrant = serde_json::from_str(&body).unwrap();
    assert_eq!(grant.status, EmergencyStatus::Invited);
    assert_eq!(grant.vaults.len(), 2);
    status!(create(&req).await.unwrap(), StatusCode::CONFLICT);
    let gid = grant.id;

    let post = |u: &User, what: &str| u.req(reqwest::Method::POST, &format!("/emergency/{gid}/{what}")).send();
    let bob_vaults = || {
        bob.req(reqwest::Method::GET, &format!("/emergency/{gid}/vaults"))
            .send()
    };

    // Bob le voit, avec l'empreinte d'Alice à vérifier.
    let ov: EmergencyOverview = bob.get("/emergency").await;
    assert!(ov.granted_by_me.is_empty());
    let mine = &ov.granted_to_me[0];
    assert_eq!(mine.grantor.email, "alice@t.io");
    assert_eq!(mine.grantor.fingerprint, gc::fingerprint(&alice.account.keypair.public));
    // Carol, étrangère à l'affaire, ne voit rien et ne peut rien.
    assert!(
        carol
            .get::<EmergencyOverview>("/emergency")
            .await
            .granted_to_me
            .is_empty()
    );
    status!(post(&carol, "accept").await.unwrap(), StatusCode::NOT_FOUND);

    // Demander avant d'accepter : non. Accepter, demander : il faut attendre.
    status!(post(&bob, "request").await.unwrap(), StatusCode::CONFLICT);
    status!(post(&alice, "accept").await.unwrap(), StatusCode::FORBIDDEN);
    let g: EmergencyGrant =
        serde_json::from_str(&status!(post(&bob, "accept").await.unwrap(), StatusCode::OK)).unwrap();
    assert_eq!(g.status, EmergencyStatus::Accepted);
    let g: EmergencyGrant =
        serde_json::from_str(&status!(post(&bob, "request").await.unwrap(), StatusCode::OK)).unwrap();
    assert_eq!(g.status, EmergencyStatus::Requested);
    let wait = g.access_at.unwrap() - g.requested_at.unwrap();
    assert_eq!(wait.num_days(), 7);
    status!(post(&bob, "request").await.unwrap(), StatusCode::CONFLICT);
    let body = status!(bob_vaults().await.unwrap(), StatusCode::FORBIDDEN);
    assert!(body.contains("emergency_not_granted"));

    // Alice refuse ; Bob redemande ; elle accorde sans attendre.
    status!(post(&bob, "approve").await.unwrap(), StatusCode::FORBIDDEN);
    let g: EmergencyGrant =
        serde_json::from_str(&status!(post(&alice, "reject").await.unwrap(), StatusCode::OK)).unwrap();
    assert_eq!(g.status, EmergencyStatus::Accepted);
    // Bob peut aussi retirer sa propre demande.
    status!(post(&bob, "request").await.unwrap(), StatusCode::OK);
    let g: EmergencyGrant =
        serde_json::from_str(&status!(post(&bob, "reject").await.unwrap(), StatusCode::OK)).unwrap();
    assert_eq!(g.status, EmergencyStatus::Accepted);
    status!(post(&bob, "reject").await.unwrap(), StatusCode::CONFLICT);
    status!(post(&bob, "request").await.unwrap(), StatusCode::OK);
    let g: EmergencyGrant =
        serde_json::from_str(&status!(post(&alice, "approve").await.unwrap(), StatusCode::OK)).unwrap();
    assert_eq!(g.status, EmergencyStatus::Granted);

    // Bob ouvre les vaults : enveloppes d'urgence signées d'Alice, en lecture.
    let read_all = || async {
        let vaults: Vec<EmergencyVault> =
            serde_json::from_str(&status!(bob_vaults().await.unwrap(), StatusCode::OK)).unwrap();
        vaults
    };
    let vaults = read_all().await;
    assert_eq!(vaults.len(), 2);
    let v = vaults.iter().find(|v| v.id == famille.id).unwrap();
    let opened = gc::unwrap_emergency_key(&bob.account, &v.id.to_string(), &v.wrapped_vault_key).unwrap();
    assert_eq!(opened.sender.as_ref(), Some(&alice.account.keypair.public));
    assert_eq!(
        gc::open_vault_name(&opened.key, &v.id.to_string(), &v.name_enc).unwrap(),
        "Famille"
    );
    // Pas une enveloppe de membre : le serveur ne peut pas l'installer comme telle.
    assert!(gc::unwrap_vault_key(&bob.account, &v.id.to_string(), &v.wrapped_vault_key).is_err());
    let page: ItemsPage = bob.get(&format!("/emergency/{gid}/vaults/{}/items", famille.id)).await;
    assert_eq!(bob.open_item(&opened.key, &page.items[0]), "banque");
    // Lecture seule : Bob n'est pas membre.
    status!(
        bob.put_item(famille.id, &opened.key, Uuid::new_v4(), "login", "x", None)
            .await,
        StatusCode::NOT_FOUND
    );
    status!(
        carol
            .req(reqwest::Method::GET, &format!("/emergency/{gid}/vaults"))
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );
    // Alice le voit dans le journal du vault — une fois, même relu.
    read_all().await;
    let audit: Vec<serde_json::Value> = alice.get(&format!("/vaults/{}/audit", famille.id)).await;
    let accesses: Vec<_> = audit.iter().filter(|e| e["action"] == "emergency.access").collect();
    assert_eq!(accesses.len(), 1);
    assert_eq!(accesses[0]["actor_email"], "bob@t.io");

    // Elle reprend la main ; Bob redemande, et au bout du délai l'accès
    // s'ouvre sans elle.
    status!(post(&alice, "reject").await.unwrap(), StatusCode::OK);
    status!(bob_vaults().await.unwrap(), StatusCode::FORBIDDEN);
    status!(post(&bob, "request").await.unwrap(), StatusCode::OK);
    status!(bob_vaults().await.unwrap(), StatusCode::FORBIDDEN);
    sqlx::query("UPDATE emergency_grants SET requested_at = now() - interval '8 days' WHERE id = $1")
        .bind(gid)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        bob.get::<EmergencyOverview>("/emergency").await.granted_to_me[0].status,
        EmergencyStatus::Granted
    );
    assert_eq!(read_all().await.len(), 2);

    // Rotation de la clé de « Famille » par Alice.
    let rotate = |new_key: &gc::SymmetricKey, emergency: Option<Vec<RotatedEmergencyKey>>| {
        rotate_as_owner(&alice, famille.id, "Famille", new_key.clone(), emergency)
    };
    // Sans les enveloppes d'urgence : celle de Bob est à renouveler, et le
    // vault ne lui est plus remis (elle ouvrirait l'ancienne clé).
    let k2 = gc::SymmetricKey::random();
    status!(rotate(&k2, None).await, StatusCode::OK);
    let g = &alice.get::<EmergencyOverview>("/emergency").await.granted_by_me[0];
    assert!(!g.vaults.iter().find(|v| v.vault_id == famille.id).unwrap().has_key);
    assert!(read_all().await.iter().all(|v| v.id != famille.id));
    // Alice ré-enveloppe (remplacement de l'ensemble).
    let patch = |req: &UpdateEmergencyGrantRequest| {
        alice
            .req(reqwest::Method::PATCH, &format!("/emergency/{gid}"))
            .json(req)
            .send()
    };
    status!(
        patch(&UpdateEmergencyGrantRequest {
            wait_days: Some(3),
            vaults: Some(vec![envelope(personal.id, &personal_key), envelope(famille.id, &k2)]),
        })
        .await
        .unwrap(),
        StatusCode::OK
    );
    assert_eq!(read_all().await.len(), 2);
    // Avec les enveloppes : il les faut toutes, et elles suivent la clé.
    let k3 = gc::SymmetricKey::random();
    let body = status!(rotate(&k3, Some(vec![])).await, StatusCode::BAD_REQUEST);
    assert!(body.contains("incomplete_rotation"));
    let fresh = RotatedEmergencyKey {
        grant_id: gid,
        wrapped_vault_key: envelope(famille.id, &k3).wrapped_vault_key,
    };
    status!(rotate(&k3, Some(vec![fresh])).await, StatusCode::OK);
    let v = read_all().await.into_iter().find(|v| v.id == famille.id).unwrap();
    let opened = gc::unwrap_emergency_key(&bob.account, &v.id.to_string(), &v.wrapped_vault_key).unwrap();
    assert_eq!(opened.key.as_bytes(), k3.as_bytes());

    // Bob renonce : plus rien, d'un côté comme de l'autre.
    status!(
        bob.req(reqwest::Method::DELETE, &format!("/emergency/{gid}"))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(
        alice
            .get::<EmergencyOverview>("/emergency")
            .await
            .granted_by_me
            .is_empty()
    );
    status!(bob_vaults().await.unwrap(), StatusCode::NOT_FOUND);
    let audit: Vec<serde_json::Value> = alice.get("/users/me/audit").await;
    for action in [
        "emergency.create",
        "emergency.approve",
        "emergency.reject",
        "emergency.update",
    ] {
        assert!(audit.iter().any(|e| e["action"] == action), "{action} manquant");
    }
    let audit: Vec<serde_json::Value> = bob.get("/users/me/audit").await;
    for action in [
        "emergency.accept",
        "emergency.request",
        "emergency.cancel",
        "emergency.delete",
    ] {
        assert!(audit.iter().any(|e| e["action"] == action), "{action} manquant");
    }
    server.stop().await;
}

/// Rotation de la clé d'un vault dont `owner` est le seul membre : items
/// re-chiffrés, historique renvoyé tel quel, enveloppes d'urgence fournies
/// ou non.
async fn rotate_as_owner(
    owner: &User,
    vault_id: Uuid,
    name: &str,
    new_key: gc::SymmetricKey,
    emergency: Option<Vec<RotatedEmergencyKey>>,
) -> reqwest::Response {
    let cur: Vault = owner.get(&format!("/vaults/{vault_id}")).await;
    let page: ItemsPage = owner.get(&format!("/vaults/{vault_id}/items")).await;
    let versions: Vec<ItemVersion> = owner.get(&format!("/vaults/{vault_id}/versions")).await;
    let vid = vault_id.to_string();
    let old_key = owner.vault_key(&cur);
    let req = RotateVaultKeyRequest {
        name_enc: gc::seal_vault_name(&new_key, &vid, name).unwrap(),
        members: vec![RotatedMemberKey {
            user_id: owner.profile.id,
            wrapped_vault_key: gc::wrap_vault_key(
                &owner.account.keypair,
                &owner.account.keypair.public,
                &vid,
                &new_key,
            )
            .unwrap(),
        }],
        items: page
            .items
            .iter()
            .map(|it| RotatedItem {
                id: it.id,
                ciphertext: gc::seal_item(
                    &new_key,
                    &vid,
                    &it.id.to_string(),
                    &it.item_type,
                    owner.open_item(&old_key, it).as_bytes(),
                )
                .unwrap(),
            })
            .collect(),
        versions: Some(
            versions
                .iter()
                .map(|v| RotatedVersion {
                    item_id: v.item_id,
                    revision: v.revision,
                    ciphertext: v.ciphertext.clone(),
                })
                .collect(),
        ),
        emergency,
        base_revision: cur.revision,
    };
    owner
        .req(reqwest::Method::POST, &format!("/vaults/{vault_id}/rotate-key"))
        .json(&req)
        .send()
        .await
        .unwrap()
}

// ─── Rapport de santé : relais ──────────────────────────────────────────────

/// Un faux Have I Been Pwned et un faux 2fa.directory, sur un port local :
/// les tests ne sortent pas sur Internet. Rend l'adresse et le compte des
/// requêtes reçues (préfixe, et en-tête de remplissage).
async fn fake_lookups() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use axum::routing::get;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    let app = axum::Router::new()
        .route(
            "/range/{prefix}",
            get(move |axum::extract::Path(prefix): axum::extract::Path<String>, headers: axum::http::HeaderMap| {
                let log = log.clone();
                async move {
                    let padded = headers.get("add-padding").map(|v| v == "true").unwrap_or(false);
                    log.lock().unwrap().push(format!("{prefix} padding={padded}"));
                    // SHA-1("password") = 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
                    "1D2DA4053E34E76F6576ED1DA63134B5E2A:2\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365\r\n0000000000000000000000000000000000A:0"
                }
            }),
        )
        .route(
            "/totp.json",
            get(|| async {
                axum::Json(serde_json::json!([
                    ["Exemple", { "domain": "exemple.com", "tfa": ["totp"], "documentation": "https://exemple.com/2fa" }]
                ]))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

#[tokio::test]
async fn health_lookups_are_relayed_without_the_password() {
    let (fake, seen) = fake_lookups().await;
    let Some(server) = TestServer::start_with(RegistrationMode::Open, |c| {
        c.health_lookups = true;
        c.hibp_url = fake.clone();
        c.twofa_directory_url = format!("{fake}/totp.json");
    })
    .await
    else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw").await;
    let h: HealthResponse = Client::new()
        .get(format!("{}/health", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(h.health_lookups);

    // k-anonymat : 5 caractères seulement, en majuscules, avec remplissage.
    let body = status!(
        alice
            .req(reqwest::Method::GET, "/lookups/pwned-passwords/5baa6")
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    assert!(body.contains("1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365"));
    assert_eq!(seen.lock().unwrap().as_slice(), ["5BAA6 padding=true"]);
    for bad in ["5BAA", "5BAA61", "ZZZZZ"] {
        status!(
            alice
                .req(reqwest::Method::GET, &format!("/lookups/pwned-passwords/{bad}"))
                .send()
                .await
                .unwrap(),
            StatusCode::BAD_REQUEST
        );
    }
    // Réservé aux comptes : ce n'est pas un relais ouvert.
    status!(
        Client::new()
            .get(format!("{}/lookups/pwned-passwords/5BAA6", server.base))
            .send()
            .await
            .unwrap(),
        StatusCode::UNAUTHORIZED
    );

    let sites: Vec<TwoFactorSite> = alice.get("/lookups/2fa-directory").await;
    assert_eq!(sites[0].domains, ["exemple.com"]);
    assert_eq!(sites[0].documentation.as_deref(), Some("https://exemple.com/2fa"));
    server.stop().await;

    // Désactivé : aucune requête sortante.
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let bob = User::register(&server, "bob@t.io", "pw").await;
    let before = seen.lock().unwrap().len();
    let body = status!(
        bob.req(reqwest::Method::GET, "/lookups/pwned-passwords/5BAA6")
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );
    assert!(body.contains("lookups_disabled"));
    status!(
        bob.req(reqwest::Method::GET, "/lookups/2fa-directory")
            .send()
            .await
            .unwrap(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(seen.lock().unwrap().len(), before);
    server.stop().await;
}

// ─── Suppression de compte ──────────────────────────────────────────────────

#[tokio::test]
async fn account_deletion_needs_the_password_and_no_orphaned_shared_vault() {
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    let bob = User::register(&server, "bob@t.io", "pw-bob").await;
    let db = server.db().await;
    let delete = |u: &User, password: &str| {
        let pre_email = u.email.clone();
        let http = u.http.clone();
        let base = u.base.clone();
        let token = u.tokens.access_token.clone();
        let password = password.to_string();
        async move {
            let pre: PreloginResponse = http
                .post(format!("{base}/auth/prelogin"))
                .json(&PreloginRequest { email: pre_email })
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let lm = gc::prepare_login(&password, &pre.kdf_salt, pre.kdf).unwrap();
            http.delete(format!("{base}/users/me"))
                .bearer_auth(token)
                .json(&DeleteAccountRequest {
                    auth_key: lm.auth_key.as_bytes().to_vec(),
                    totp_code: None,
                })
                .send()
                .await
                .unwrap()
        }
    };

    // Un vault partagé d'Alice, où Bob est membre ; un item ; un lien.
    let (shared, key) = alice.create_vault("Équipe").await;
    let lookup: UserLookupResponse = alice.get("/users/lookup?email=bob@t.io").await;
    let bob_pk = gc::PublicKey::try_from(lookup.public_key.as_slice()).unwrap();
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/members", shared.id))
            .json(&AddMemberRequest {
                user_id: bob.profile.id,
                role: Role::Writer,
                wrapped_vault_key: gc::wrap_vault_key(&alice.account.keypair, &bob_pk, &shared.id.to_string(), &key)
                    .unwrap(),
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );
    status!(
        alice
            .put_item(shared.id, &key, Uuid::new_v4(), "note", "partagée", None)
            .await,
        StatusCode::CREATED
    );
    let (send, _) = new_send(&alice, "lien d'Alice", None, None, 3600);
    status!(
        alice
            .req(reqwest::Method::POST, "/sends")
            .json(&send)
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );

    // Mauvais mot de passe : refusé.
    status!(delete(&alice, "pas-le-bon").await, StatusCode::UNAUTHORIZED);
    // Bob perdrait son propriétaire : refusé, et le vault est nommé.
    let body = status!(delete(&alice, "pw-alice").await, StatusCode::CONFLICT);
    assert!(body.contains("owns_shared_vaults") && body.contains(&shared.id.to_string()));

    // Propriété transférée à Bob : la suppression passe.
    status!(
        alice
            .req(
                reqwest::Method::POST,
                &format!("/vaults/{}/members/{}/transfer", shared.id, bob.profile.id)
            )
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    status!(delete(&alice, "pw-alice").await, StatusCode::NO_CONTENT);

    // Alice n'existe plus : ni connexion, ni session.
    assert_eq!(
        User::login(&server, "alice@t.io", "pw-alice").await.err().map(|e| e.0),
        Some(StatusCode::UNAUTHORIZED)
    );
    status!(
        alice.req(reqwest::Method::GET, "/sync").send().await.unwrap(),
        StatusCode::UNAUTHORIZED
    );
    // Son vault personnel et son lien ont disparu ; le vault d'équipe reste à
    // Bob, avec l'item.
    let (vaults,): (i64,) = sqlx::query_as("SELECT count(*) FROM vaults")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(vaults, 2, "les vaults personnel et d'équipe de Bob");
    let (sends,): (i64,) = sqlx::query_as("SELECT count(*) FROM sends")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(sends, 0);
    let sync = bob.sync().await;
    let team = sync
        .vaults
        .iter()
        .find(|v| v.id == shared.id)
        .expect("le vault d'équipe reste à Bob");
    assert_eq!(team.role, Role::Owner);
    let page: ItemsPage = bob.get(&format!("/vaults/{}/items", shared.id)).await;
    assert_eq!(page.items.len(), 1);
    // Le journal du vault garde l'histoire, sans l'adresse IP d'Alice.
    let (with_ip,): (i64,) = sqlx::query_as("SELECT count(*) FROM audit_log WHERE actor_id = $1 AND ip IS NOT NULL")
        .bind(alice.profile.id)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(with_ip, 0);
    let audit: Vec<serde_json::Value> = bob.get(&format!("/vaults/{}/audit", shared.id)).await;
    assert!(
        audit
            .iter()
            .any(|e| e["action"] == "vault.create" && e["actor_email"].is_null())
    );
    server.stop().await;
}

/// Une demande d'inscription complète, pour les cas où elle doit échouer.
fn register_request(email: &str) -> RegisterRequest {
    let (m, a) = gc::create_account("pw-x").unwrap();
    let k = gc::SymmetricKey::random();
    let pid = Uuid::new_v4();
    RegisterRequest {
        email: email.into(),
        kdf: m.kdf,
        kdf_salt: m.kdf_salt,
        auth_key: m.auth_key,
        protected_user_key: m.protected_user_key,
        public_key: m.public_key,
        protected_private_key: m.protected_private_key,
        personal_vault: CreateVaultRequest {
            id: pid,
            name_enc: gc::seal_vault_name(&k, &pid.to_string(), "P").unwrap(),
            wrapped_vault_key: gc::wrap_vault_key(&a.keypair, &a.keypair.public, &pid.to_string(), &k).unwrap(),
        },
        device_name: None,
    }
}

/// Ajoute `member` au vault partagé de `owner`, avec la vraie enveloppe.
async fn add_member(owner: &User, vault: &Vault, key: &gc::SymmetricKey, member: &User, role: Role) {
    let lookup: UserLookupResponse = owner.get(&format!("/users/lookup?email={}", member.email)).await;
    let pk = gc::PublicKey::try_from(lookup.public_key.as_slice()).unwrap();
    status!(
        owner
            .req(reqwest::Method::POST, &format!("/vaults/{}/members", vault.id))
            .json(&AddMemberRequest {
                user_id: member.profile.id,
                role,
                wrapped_vault_key: gc::wrap_vault_key(&owner.account.keypair, &pk, &vault.id.to_string(), key).unwrap(),
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn server_admin_accounts_quotas_and_registrations() {
    let Some(server) = TestServer::start(RegistrationMode::InviteOnly).await else {
        return;
    };
    let db = server.db().await;
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    assert!(!alice.profile.is_admin);
    // Pas encore administratrice : rien.
    let body = status!(
        alice.req(reqwest::Method::GET, "/admin/overview").send().await.unwrap(),
        StatusCode::FORBIDDEN
    );
    assert!(body.contains("\"forbidden\""), "{body}");

    // Le rôle se donne depuis le shell du serveur, pas par l'API.
    assert!(
        !guivault_server::admin::set_admin(&db, "personne@t.io", true)
            .await
            .unwrap()
    );
    assert!(
        guivault_server::admin::set_admin(&db, "Alice@t.io", true)
            .await
            .unwrap()
    );
    assert_eq!(guivault_server::admin::list(&db).await.unwrap(), vec!["alice@t.io"]);
    let me: UserProfile = alice.get("/users/me").await;
    assert!(me.is_admin);

    // Inscriptions : Bob n'a ni invitation de vault ni place dans la liste
    // blanche ; l'administratrice lui ouvre la porte, qui sert une fois.
    let body = status!(
        Client::new()
            .post(format!("{}/auth/register", server.base))
            .json(&register_request("bob@t.io"))
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );
    assert!(body.contains("invitation_required"), "{body}");
    for email in ["bob@t.io", "carol@t.io"] {
        status!(
            alice
                .req(reqwest::Method::POST, "/admin/registrations")
                .json(&CreateRegistrationInvite {
                    email: email.into(),
                    days: Some(3),
                })
                .send()
                .await
                .unwrap(),
            StatusCode::CREATED
        );
    }
    let body = status!(
        alice
            .req(reqwest::Method::POST, "/admin/registrations")
            .json(&CreateRegistrationInvite {
                email: "alice@t.io".into(),
                days: None,
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CONFLICT
    );
    assert!(body.contains("email_taken"));
    let bob = User::register(&server, "bob@t.io", "pw-bob").await;
    let carol = User::register(&server, "carol@t.io", "pw-carol").await;
    let open: Vec<RegistrationInvite> = alice.get("/admin/registrations").await;
    assert!(open.is_empty(), "consommées à l'inscription : {open:?}");

    // Un peu de contenu : un vault partagé de Bob où Carol écrit.
    let (team, team_key) = bob.create_vault("Équipe").await;
    add_member(&bob, &team, &team_key, &carol, Role::Writer).await;
    status!(
        bob.put_item(team.id, &team_key, Uuid::new_v4(), "note", "consignes", None)
            .await,
        StatusCode::CREATED
    );

    let users: Vec<AdminUserInfo> = alice.get("/admin/users").await;
    assert_eq!(users.len(), 3);
    let b = users.iter().find(|u| u.email == "bob@t.io").unwrap();
    assert_eq!((b.vaults_owned, b.vaults_joined, b.items), (2, 0, 1));
    assert!(b.storage_bytes > 0 && b.active_sessions == 1 && b.last_seen_at.is_some());
    assert_eq!(b.effective_quota_bytes, 0, "aucun quota par défaut");
    let c = users.iter().find(|u| u.email == "carol@t.io").unwrap();
    assert_eq!((c.vaults_owned, c.vaults_joined, c.items), (1, 1, 0));
    let overview: AdminOverview = alice.get("/admin/overview").await;
    assert_eq!((overview.users, overview.admins, overview.shared_vaults), (3, 1, 1));

    // Quota : le vault d'équipe compte pour Bob, son propriétaire — même
    // quand c'est Carol qui écrit.
    let body = status!(
        alice
            .req(reqwest::Method::PUT, &format!("/admin/users/{}/quota", bob.profile.id))
            .json(&SetQuotaRequest {
                quota_bytes: Some(b.storage_bytes as u64 + 200),
            })
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let b: AdminUserInfo = serde_json::from_str(&body).unwrap();
    assert_eq!(b.effective_quota_bytes, b.storage_bytes as u64 + 200);
    status!(
        carol
            .put_item(team.id, &team_key, Uuid::new_v4(), "note", "court", None)
            .await,
        StatusCode::CREATED
    );
    let big = "x".repeat(400);
    let body = status!(
        carol
            .put_item(team.id, &team_key, Uuid::new_v4(), "note", &big, None)
            .await,
        StatusCode::INSUFFICIENT_STORAGE
    );
    assert!(body.contains("quota_exceeded") && body.contains("\"quota\""), "{body}");
    // Le vault personnel de Carol n'est pas concerné.
    let carol_personal = carol
        .sync()
        .await
        .vaults
        .into_iter()
        .find(|v| v.kind == VaultKind::Personal)
        .unwrap();
    let carol_key = carol.vault_key(&carol_personal);
    status!(
        carol
            .put_item(carol_personal.id, &carol_key, Uuid::new_v4(), "note", &big, None)
            .await,
        StatusCode::CREATED
    );
    status!(
        alice
            .req(reqwest::Method::PUT, &format!("/admin/users/{}/quota", bob.profile.id))
            .json(&SetQuotaRequest { quota_bytes: None })
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    status!(
        carol
            .put_item(team.id, &team_key, Uuid::new_v4(), "note", &big, None)
            .await,
        StatusCode::CREATED
    );

    // Désactiver : sessions coupées, connexion refusée en le disant (le mot
    // de passe une fois prouvé), puis réactiver.
    let body = status!(
        alice
            .req(
                reqwest::Method::POST,
                &format!("/admin/users/{}/disable", alice.profile.id)
            )
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST
    );
    assert!(body.contains("self_action"));
    let body = status!(
        alice
            .req(
                reqwest::Method::POST,
                &format!("/admin/users/{}/disable", bob.profile.id)
            )
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let b: AdminUserInfo = serde_json::from_str(&body).unwrap();
    assert!(b.disabled_at.is_some() && b.active_sessions == 0);
    status!(
        bob.req(reqwest::Method::GET, "/sync").send().await.unwrap(),
        StatusCode::UNAUTHORIZED
    );
    let (st, body) = User::login(&server, "bob@t.io", "pw-bob").await.err().unwrap();
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert!(body.contains("account_disabled"), "{body}");
    let (st, body) = User::login(&server, "bob@t.io", "mauvais").await.err().unwrap();
    assert_eq!(
        st,
        StatusCode::UNAUTHORIZED,
        "sans le mot de passe, rien de plus : {body}"
    );
    status!(
        alice
            .req(
                reqwest::Method::POST,
                &format!("/admin/users/{}/enable", bob.profile.id)
            )
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let bob = User::login(&server, "bob@t.io", "pw-bob").await.unwrap();

    // Un autre administrateur est intouchable depuis l'API.
    guivault_server::admin::set_admin(&db, "carol@t.io", true)
        .await
        .unwrap();
    let body = status!(
        alice
            .req(
                reqwest::Method::POST,
                &format!("/admin/users/{}/disable", carol.profile.id)
            )
            .send()
            .await
            .unwrap(),
        StatusCode::CONFLICT
    );
    assert!(body.contains("target_is_admin"));
    guivault_server::admin::set_admin(&db, "carol@t.io", false)
        .await
        .unwrap();

    // Supprimer Bob : son vault personnel part, le vault d'équipe passe à
    // Carol (seule autre membre), avec ses items.
    status!(
        alice
            .req(reqwest::Method::DELETE, &format!("/admin/users/{}", bob.profile.id))
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    let team_now = carol
        .sync()
        .await
        .vaults
        .into_iter()
        .find(|v| v.id == team.id)
        .expect("le vault reste");
    assert_eq!(team_now.role, Role::Owner);
    let page: ItemsPage = carol.get(&format!("/vaults/{}/items", team.id)).await;
    assert_eq!(page.items.len(), 3);
    assert!(User::login(&server, "bob@t.io", "pw-bob").await.is_err());
    let actions: Vec<String> =
        sqlx::query_scalar("SELECT action FROM audit_log WHERE action LIKE 'admin.%' ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
    assert_eq!(
        actions,
        vec![
            "admin.grant",
            "admin.registration_open",
            "admin.registration_open",
            "admin.user_quota",
            "admin.user_quota",
            "admin.user_disable",
            "admin.user_enable",
            "admin.grant",
            "admin.revoke",
            "admin.user_delete",
        ]
    );
    server.stop().await;
}

#[tokio::test]
async fn ip_allow_lists_for_the_server_and_its_administration() {
    // Tout le serveur fermé à 127.0.0.1 : ni l'API, ni l'interface — la
    // sonde de santé seule répond.
    let Some(server) = TestServer::start_with(RegistrationMode::Open, |c| {
        c.allowed_ips = guivault_server::config::IpAllowList::parse("X", "10.0.0.0/8").unwrap();
    })
    .await
    else {
        return;
    };
    let http = Client::new();
    let root = server.base.trim_end_matches("/api/v1").to_string();
    status!(
        http.get(format!("{}/health", server.base)).send().await.unwrap(),
        StatusCode::OK
    );
    let body = status!(
        http.post(format!("{}/auth/prelogin", server.base))
            .json(&PreloginRequest { email: "a@t.io".into() })
            .send()
            .await
            .unwrap(),
        StatusCode::FORBIDDEN
    );
    assert!(body.contains("ip_not_allowed"), "{body}");
    status!(
        http.get(format!("{root}/")).send().await.unwrap(),
        StatusCode::FORBIDDEN
    );
    server.stop().await;

    // Derrière un proxy de confiance, c'est l'adresse du client qui compte.
    let Some(server) = TestServer::start_with(RegistrationMode::Open, |c| {
        c.allowed_ips = guivault_server::config::IpAllowList::parse("X", "10.0.0.0/8").unwrap();
        c.trust_proxy = guivault_server::config::TrustProxy::parse("127.0.0.1").unwrap();
    })
    .await
    else {
        return;
    };
    for (xff, expected) in [("10.1.2.3", StatusCode::OK), ("192.0.2.9", StatusCode::FORBIDDEN)] {
        status!(
            http.post(format!("{}/auth/prelogin", server.base))
                .header("x-forwarded-for", xff)
                .json(&PreloginRequest { email: "a@t.io".into() })
                .send()
                .await
                .unwrap(),
            expected
        );
    }
    server.stop().await;

    // L'administration seule restreinte : le reste répond, `/admin` non —
    // même pour un administrateur.
    let Some(server) = TestServer::start_with(RegistrationMode::Open, |c| {
        c.admin_allowed_ips = guivault_server::config::IpAllowList::parse("X", "10.0.0.0/8").unwrap();
    })
    .await
    else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    guivault_server::admin::set_admin(&server.db().await, "alice@t.io", true)
        .await
        .unwrap();
    alice.sync().await;
    let body = status!(
        alice.req(reqwest::Method::GET, "/admin/users").send().await.unwrap(),
        StatusCode::FORBIDDEN
    );
    assert!(body.contains("ip_not_allowed"), "{body}");
    server.stop().await;
}

/// Décompresse une sauvegarde, applique `edit` à ses lignes, recompresse.
fn tamper(src: &std::path::Path, dst: &std::path::Path, edit: impl FnOnce(&mut Vec<String>)) {
    use std::io::{Read, Write};
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(src).unwrap())
        .read_to_string(&mut text)
        .unwrap();
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    edit(&mut lines);
    let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(dst).unwrap(), flate2::Compression::fast());
    for l in &lines {
        writeln!(gz, "{l}").unwrap();
    }
    gz.finish().unwrap();
}

#[tokio::test]
async fn backups_are_verified_by_restoring_them() {
    use guivault_server::backup::{self, Trigger, Verified};
    use guivault_server::config::BackupConfig;
    let Some(server) = TestServer::start(RegistrationMode::Open).await else {
        return;
    };
    // Un peu de tout : deux comptes, un vault partagé, des items dont un
    // modifié (historique), un lien de partage.
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    let bob = User::register(&server, "bob@t.io", "pw-bob").await;
    let (team, team_key) = alice.create_vault("Équipe").await;
    add_member(&alice, &team, &team_key, &bob, Role::Writer).await;
    let note = Uuid::new_v4();
    let body = status!(
        alice.put_item(team.id, &team_key, note, "note", "v1", None).await,
        StatusCode::CREATED
    );
    let item: Item = serde_json::from_str(&body).unwrap();
    status!(
        alice
            .put_item(team.id, &team_key, note, "note", "consignes v2", Some(item.revision))
            .await,
        StatusCode::OK
    );
    let (send, _) = new_send(&alice, "à transmettre", None, None, 3600);
    status!(
        alice
            .req(reqwest::Method::POST, "/sends")
            .json(&send)
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );
    let db = server.db().await;
    let dir = std::env::temp_dir().join(format!("guivault-backups-{}", Uuid::new_v4()));
    let (scratch_url, scratch) = server.fresh_database().await;
    let cfg = BackupConfig {
        dir: dir.clone(),
        interval: Duration::from_secs(3600),
        keep: 2,
        verify_database_url: Some(scratch_url.clone()),
    };

    // Écrite, relue, restaurée dans la base d'essai et re-sauvegardée à
    // l'identique.
    let out = backup::run(&db, &cfg, &server.db_url(), Trigger::Shell).await.unwrap();
    assert_eq!(out.verified, Verified::Restore);
    assert_eq!(out.summary.tables["users"].rows, 2);
    assert_eq!(out.summary.tables["item_versions"].rows, 1);
    assert_eq!(out.summary.tables["sends"].rows, 1);
    let (verified, error, rows): (Option<String>, Option<String>, Option<i64>) =
        sqlx::query_as("SELECT verified, error, row_count FROM backup_runs WHERE id = $1")
            .bind(out.id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!((verified.as_deref(), error), (Some("restore"), None));
    assert_eq!(rows, Some(out.summary.rows() as i64));
    // La base d'essai de nouveau vérifiable (marquée) : un second passage passe.
    backup::restore_check(&scratch_url, &out.path, &out.summary)
        .await
        .unwrap();
    // Un serveur tournant sur la base, pas celle d'essai.
    let err = backup::run(
        &db,
        &BackupConfig {
            verify_database_url: Some(server.db_url()),
            ..cfg.clone()
        },
        &server.db_url(),
        Trigger::Shell,
    )
    .await
    .unwrap_err();
    assert!(format!("{err:#}").contains("base du serveur"), "{err:#}");

    // Restaurée pour de vrai, puis servie : Alice se connecte avec son mot
    // de passe et relit son vault.
    let (restored_url, restored) = server.fresh_database().await;
    let pool = sqlx::PgPool::connect(&restored_url).await.unwrap();
    backup::restore(&pool, &out.path, true).await.unwrap();
    let err = backup::restore(&pool, &out.path, true).await.unwrap_err();
    assert!(format!("{err:#}").contains("contient déjà des données"), "{err:#}");
    pool.close().await;
    let url = restored_url.clone();
    let again = TestServer::start_with(RegistrationMode::Open, move |c| c.database_url = url)
        .await
        .unwrap();
    let alice2 = User::login(&again, "alice@t.io", "pw-alice").await.unwrap();
    let v = alice2
        .sync()
        .await
        .vaults
        .into_iter()
        .find(|v| v.id == team.id)
        .unwrap();
    let key = alice2.vault_key(&v);
    let page: ItemsPage = alice2.get(&format!("/vaults/{}/items", team.id)).await;
    assert_eq!(alice2.open_item(&key, &page.items[0]), "consignes v2");
    let versions: Vec<ItemVersion> = alice2.get(&format!("/vaults/{}/items/{note}/versions", team.id)).await;
    let v1 = gc::open_item(
        &key,
        &team.id.to_string(),
        &note.to_string(),
        "note",
        &versions[0].ciphertext,
    )
    .unwrap();
    assert_eq!(v1, b"v1");
    // Le journal reprend après sa plus grande ligne.
    status!(
        alice2
            .put_item(team.id, &key, Uuid::new_v4(), "note", "après", None)
            .await,
        StatusCode::CREATED
    );
    again.stop().await;

    // Tronquée, altérée, sans fin, ou pas une sauvegarde : refusée.
    let bad = dir.join("mauvaise.jsonl.gz");
    let bytes = std::fs::read(&out.path).unwrap();
    std::fs::write(&bad, &bytes[..bytes.len() / 2]).unwrap();
    assert!(backup::verify_file(&bad).is_err(), "tronquée");
    tamper(&out.path, &bad, |lines| {
        let l = lines.iter_mut().find(|l| l.starts_with("items\t")).unwrap();
        *l = l.replacen("\"note\"", "\"nota\"", 1);
    });
    let err = backup::verify_file(&bad).unwrap_err().to_string();
    assert!(err.contains("« items »") && err.contains("altéré"), "{err}");
    tamper(&out.path, &bad, |lines| {
        lines.pop();
    });
    let err = backup::verify_file(&bad).unwrap_err().to_string();
    assert!(err.contains("tronquée"), "{err}");
    tamper(&out.path, &bad, |lines| {
        let i = lines.iter().position(|l| l.starts_with("sends\t")).unwrap();
        let l = lines.remove(i);
        lines.insert(1, l);
    });
    let err = backup::verify_file(&bad).unwrap_err().to_string();
    assert!(err.contains("hors d'ordre"), "{err}");
    std::fs::write(&bad, b"pas du tout une sauvegarde").unwrap();
    assert!(backup::verify_file(&bad).is_err());
    std::fs::remove_file(&bad).unwrap();

    // Une base d'essai qui contient autre chose n'est pas effacée.
    let (other_url, other) = server.fresh_database().await;
    let other_pool = sqlx::PgPool::connect(&other_url).await.unwrap();
    sqlx::raw_sql("CREATE TABLE compta (x int); INSERT INTO compta VALUES (42)")
        .execute(&other_pool)
        .await
        .unwrap();
    let err = backup::restore_check(&other_url, &out.path, &out.summary)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("refus de l'effacer"), "{err:#}");
    let (kept,): (i32,) = sqlx::query_as("SELECT x FROM compta")
        .fetch_one(&other_pool)
        .await
        .unwrap();
    assert_eq!(kept, 42);
    // Une table inconnue des sauvegardes les fait échouer plutôt que de
    // l'oublier.
    backup::migrate_to(&other_pool, 6).await.unwrap();
    let err = backup::dump(&other_pool, &mut std::io::sink()).await.unwrap_err();
    assert!(err.to_string().contains("« compta »"), "{err}");
    sqlx::query("DROP TABLE compta").execute(&other_pool).await.unwrap();

    // Une sauvegarde d'un schéma plus ancien (6) se restaure, puis monte.
    sqlx::query(
        "INSERT INTO users (id, email, kdf_m_cost, kdf_t_cost, kdf_p_cost, kdf_salt, auth_hash,
                            protected_user_key, public_key, protected_private_key)
         VALUES ($1, 'ancien@t.io', 65536, 3, 1, '\\x00', 'x', '\\x01', '\\x02', '\\x03')",
    )
    .bind(Uuid::new_v4())
    .execute(&other_pool)
    .await
    .unwrap();
    let old = dir.join("ancienne.jsonl.gz");
    let summary = backup::create_file(&other_pool, &old).await.unwrap();
    assert_eq!(summary.header.schema, 6);
    assert!(!summary.header.tables.contains(&"registration_invites".to_string()));
    other_pool.close().await;
    let (up_url, up) = server.fresh_database().await;
    let up_pool = sqlx::PgPool::connect(&up_url).await.unwrap();
    backup::restore(&up_pool, &old, true).await.unwrap();
    let (email, is_admin): (String, bool) = sqlx::query_as("SELECT email::text, is_admin FROM users")
        .fetch_one(&up_pool)
        .await
        .unwrap();
    assert_eq!((email.as_str(), is_admin), ("ancien@t.io", false));
    let latest: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&up_pool)
        .await
        .unwrap();
    assert_eq!(
        latest,
        guivault_server::MIGRATOR.iter().map(|m| m.version).max().unwrap()
    );
    up_pool.close().await;
    std::fs::remove_file(&old).unwrap();

    // Une seule à la fois ; et on n'en garde que `keep`.
    let quick = BackupConfig {
        verify_database_url: None,
        ..cfg.clone()
    };
    let mut holder = db.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(backup::LOCK_KEY)
        .execute(&mut *holder)
        .await
        .unwrap();
    assert!(backup::running(&db).await.unwrap());
    let err = backup::run(&db, &quick, &server.db_url(), Trigger::Shell)
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<backup::Busy>().is_some(), "{err:#}");
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(backup::LOCK_KEY)
        .execute(&mut *holder)
        .await
        .unwrap();
    drop(holder);
    for _ in 0..2 {
        backup::run(&db, &quick, &server.db_url(), Trigger::Schedule)
            .await
            .unwrap();
    }
    let files = std::fs::read_dir(&dir).unwrap().count();
    assert_eq!(files, 2, "rétention : 2 gardées sur 3");

    // Une base d'essai qui n'existe pas encore est créée à côté.
    let missing = format!("guivault_t_{}", Uuid::new_v4().simple());
    let mut missing_url = url::Url::parse(&server.db_url()).unwrap();
    missing_url.set_path(&missing);
    let out = backup::run(
        &db,
        &BackupConfig {
            verify_database_url: Some(missing_url.to_string()),
            keep: 10,
            ..cfg.clone()
        },
        &server.db_url(),
        Trigger::Schedule,
    )
    .await
    .unwrap();
    assert_eq!(out.verified, Verified::Restore);
    server.drop_database(&missing).await;

    for name in [&scratch, &restored, &other, &up] {
        server.drop_database(name).await;
    }
    let _ = std::fs::remove_dir_all(&dir);
    server.stop().await;
}

#[tokio::test]
async fn admin_starts_a_backup_and_follows_it() {
    use guivault_server::config::BackupConfig;
    let dir = std::env::temp_dir().join(format!("guivault-backups-{}", Uuid::new_v4()));
    let d = dir.clone();
    let Some(server) = TestServer::start_with(RegistrationMode::Open, move |c| {
        c.backup = Some(BackupConfig {
            dir: d,
            interval: Duration::from_secs(24 * 3600),
            keep: 3,
            verify_database_url: None,
        })
    })
    .await
    else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    guivault_server::admin::set_admin(&server.db().await, "alice@t.io", true)
        .await
        .unwrap();
    let st: BackupsStatus = alice.get("/admin/backups").await;
    assert!(st.enabled && !st.restore_check && st.runs.is_empty());
    assert_eq!((st.interval_hours, st.keep), (24, 3));
    status!(
        alice.req(reqwest::Method::POST, "/admin/backups").send().await.unwrap(),
        StatusCode::ACCEPTED
    );
    let mut done = None;
    for _ in 0..100 {
        let st: BackupsStatus = alice.get("/admin/backups").await;
        if let Some(r) = st.runs.first().filter(|r| r.finished_at.is_some()) {
            done = Some(r.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let run = done.expect("sauvegarde terminée");
    assert_eq!(run.triggered_by, "admin");
    assert_eq!((run.verified.as_deref(), run.error.as_deref()), (Some("file"), None));
    assert!(dir.join(run.file.unwrap()).exists());
    let _ = std::fs::remove_dir_all(&dir);
    server.stop().await;
}

/// Un serveur SMTP de test : accepte tout et garde chaque message brut.
struct FakeSmtp {
    url: String,
    mails: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl FakeSmtp {
    async fn start() -> FakeSmtp {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("smtp://{}", listener.local_addr().unwrap());
        let mails = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let store = mails.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let store = store.clone();
                tokio::spawn(async move {
                    let (r, mut w) = stream.into_split();
                    let mut lines = BufReader::new(r).lines();
                    w.write_all(b"220 faux ESMTP\r\n").await.unwrap();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let cmd = line.to_ascii_uppercase();
                        if cmd.starts_with("EHLO") {
                            w.write_all(b"250-faux\r\n250 8BITMIME\r\n").await.unwrap();
                        } else if cmd == "DATA" {
                            w.write_all(b"354 allez\r\n").await.unwrap();
                            let mut data = String::new();
                            while let Ok(Some(l)) = lines.next_line().await {
                                if l == "." {
                                    break;
                                }
                                data.push_str(l.strip_prefix('.').filter(|_| l.starts_with("..")).unwrap_or(&l));
                                data.push_str("\r\n");
                            }
                            store.lock().unwrap().push(data);
                            w.write_all(b"250 recu\r\n").await.unwrap();
                        } else if cmd == "QUIT" {
                            let _ = w.write_all(b"221 au revoir\r\n").await;
                            break;
                        } else {
                            w.write_all(b"250 OK\r\n").await.unwrap();
                        }
                    }
                });
            }
        });
        FakeSmtp { url, mails }
    }

    /// Attend au moins `n` messages (l'envoi part en arrière-plan).
    async fn wait(&self, n: usize) -> Vec<Received> {
        for _ in 0..100 {
            if self.mails.lock().unwrap().len() >= n {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.mails.lock().unwrap().iter().map(|m| Received::parse(m)).collect()
    }
}

/// Un message reçu, en-têtes et corps décodés (RFC 2047, quoted-printable,
/// base64 : ce que `lettre` choisit selon le texte).
#[derive(Debug)]
struct Received {
    to: String,
    subject: String,
    body: String,
}

impl Received {
    fn parse(raw: &str) -> Received {
        use base64::Engine;
        let b64 = |s: &str| {
            base64::engine::general_purpose::STANDARD
                .decode(s.split_whitespace().collect::<String>())
                .unwrap()
        };
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        let mut headers: Vec<(String, String)> = Vec::new();
        for line in head.split("\r\n") {
            if line.starts_with([' ', '\t']) {
                // Dépliage (RFC 5322) : seul le saut de ligne disparaît.
                headers.last_mut().unwrap().1.push_str(line);
            } else if let Some((k, v)) = line.split_once(':') {
                headers.push((k.to_ascii_lowercase(), v.trim().to_string()));
            }
        }
        let header = |k: &str| {
            headers
                .iter()
                .find(|(h, _)| h == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        let qp = |s: &str, underscore: bool| {
            let s = s.replace("=\r\n", "");
            let bytes = s.as_bytes();
            let mut out = Vec::new();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'='
                    && i + 2 < bytes.len()
                    && let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16)
                {
                    out.push(b);
                    i += 3;
                    continue;
                }
                out.push(if underscore && bytes[i] == b'_' { b' ' } else { bytes[i] });
                i += 1;
            }
            out
        };
        // Mots encodés `=?utf-8?b?…?=` / `=?utf-8?q?…?=` : l'espace entre deux
        // d'entre eux ne compte pas, les autres si.
        let mut subject = Vec::new();
        let mut previous_encoded = None;
        for word in header("subject").split_whitespace() {
            let encoded = word.strip_prefix("=?").and_then(|w| w.strip_suffix("?="));
            if previous_encoded.is_some() && !(previous_encoded == Some(true) && encoded.is_some()) {
                subject.push(b' ');
            }
            match encoded {
                Some(enc) => {
                    let mut parts = enc.splitn(3, '?');
                    let (_, kind, data) = (parts.next(), parts.next().unwrap(), parts.next().unwrap());
                    subject.extend(if kind.eq_ignore_ascii_case("b") {
                        b64(data)
                    } else {
                        qp(data, true)
                    });
                }
                None => subject.extend(word.as_bytes()),
            }
            previous_encoded = Some(encoded.is_some());
        }
        let body = match header("content-transfer-encoding").to_ascii_lowercase().as_str() {
            "quoted-printable" => qp(body, false),
            "base64" => b64(body),
            _ => body.as_bytes().to_vec(),
        };
        Received {
            to: header("to"),
            subject: String::from_utf8(subject).unwrap(),
            body: String::from_utf8(body).unwrap().replace("\r\n", "\n"),
        }
    }
}

/// Connexion en se disant venir de `from` (derrière un proxy de confiance).
async fn login_from(server: &TestServer, email: &str, password: &str, from: &str) -> StatusCode {
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
    http.post(format!("{}/auth/login", server.base))
        .header("x-forwarded-for", from)
        .header("user-agent", "Firefox de test")
        .json(&LoginRequest {
            email: email.into(),
            auth_key: lm.auth_key.as_bytes().to_vec(),
            device_name: Some("portable".into()),
        })
        .send()
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn mail_goes_out_when_configured_and_never_blocks() {
    use guivault_server::config::{MailConfig, TrustProxy};
    let smtp = FakeSmtp::start().await;
    let url = smtp.url.clone();
    let Some(server) = TestServer::start_with(RegistrationMode::Open, move |c| {
        c.trust_proxy = TrustProxy::parse("127.0.0.1").unwrap();
        c.mail = Some(MailConfig {
            smtp_url: url,
            from: "GuiVault <coffre@vault.test>".into(),
            public_url: Some("https://vault.test".into()),
        });
    })
    .await
    else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    let bob = User::register(&server, "bob@t.io", "pw-bob").await;
    assert!(smtp.wait(1).await.is_empty(), "l'inscription n'envoie rien");

    // Une invitation vers quelqu'un qui n'a pas de compte.
    let (team, _) = alice.create_vault("Équipe").await;
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", team.id))
            .json(&CreateInvitationRequest {
                email: "carol@t.io".into(),
                role: Role::Writer,
                wrapped_vault_key: None,
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );
    let mails = smtp.wait(1).await;
    let m = &mails[0];
    assert_eq!(m.to, "carol@t.io");
    assert_eq!(m.subject, "alice@t.io vous invite dans un vault GuiVault");
    assert!(
        m.body.contains("rôle « éditeur »") && m.body.contains("créez-le avec cette adresse"),
        "{}",
        m.body
    );
    assert!(
        m.body.contains("https://vault.test") && m.body.contains("empreinte"),
        "{}",
        m.body
    );
    assert!(!m.body.contains("Équipe"), "jamais le nom d'un vault (chiffré)");

    // Connexion depuis une adresse inconnue : alerte ; la même ensuite, ou
    // celle de l'inscription : rien.
    assert_eq!(
        login_from(&server, "alice@t.io", "pw-alice", "203.0.113.7").await,
        StatusCode::OK
    );
    let mails = smtp.wait(2).await;
    let m = &mails[1];
    assert_eq!(
        (m.to.as_str(), m.subject.as_str()),
        ("alice@t.io", "Nouvelle connexion à votre compte GuiVault")
    );
    assert!(m.body.contains("203.0.113.7") && m.body.contains("« portable »") && m.body.contains("Firefox de test"));
    assert_eq!(
        login_from(&server, "alice@t.io", "pw-alice", "203.0.113.7").await,
        StatusCode::OK
    );
    User::login(&server, "alice@t.io", "pw-alice").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(smtp.mails.lock().unwrap().len(), 2, "adresse déjà vue : pas d'alerte");

    // Accès d'urgence : chaque étape prévient l'autre partie.
    let personal = alice
        .sync()
        .await
        .vaults
        .into_iter()
        .find(|v| v.kind == VaultKind::Personal)
        .unwrap();
    let lookup: UserLookupResponse = alice.get("/users/lookup?email=bob@t.io").await;
    let bob_pk = gc::PublicKey::try_from(lookup.public_key.as_slice()).unwrap();
    let envelope = EmergencyVaultKey {
        vault_id: personal.id,
        wrapped_vault_key: gc::wrap_emergency_key(
            &alice.account.keypair,
            &bob_pk,
            &personal.id.to_string(),
            &alice.vault_key(&personal),
        )
        .unwrap(),
    };
    let grant: EmergencyGrant = serde_json::from_str(&status!(
        alice
            .req(reqwest::Method::POST, "/emergency")
            .json(&CreateEmergencyGrantRequest {
                grantee_id: bob.profile.id,
                wait_days: 3,
                vaults: vec![envelope],
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    ))
    .unwrap();
    for (who, action) in [(&bob, "accept"), (&bob, "request"), (&alice, "reject")] {
        status!(
            who.req(reqwest::Method::POST, &format!("/emergency/{}/{action}", grant.id))
                .send()
                .await
                .unwrap(),
            StatusCode::OK
        );
    }
    let mails = smtp.wait(6).await;
    let got: Vec<(&str, &str)> = mails[2..].iter().map(|m| (m.to.as_str(), m.subject.as_str())).collect();
    assert_eq!(
        got,
        vec![
            ("bob@t.io", "alice@t.io vous désigne comme contact d'urgence"),
            ("alice@t.io", "bob@t.io a accepté d'être votre contact d'urgence"),
            ("alice@t.io", "bob@t.io demande l'accès d'urgence à votre coffre"),
            ("bob@t.io", "alice@t.io a refusé votre demande d'accès d'urgence"),
        ]
    );
    assert!(
        mails[4]
            .body
            .contains("Sans refus de votre part, il lui sera ouvert le"),
        "{}",
        mails[4].body
    );

    // Nouvelle demande, puis le délai s'écoule sans réponse : les deux
    // parties sont prévenues par la tâche de fond — une seule fois.
    status!(
        bob.req(reqwest::Method::POST, &format!("/emergency/{}/request", grant.id))
            .send()
            .await
            .unwrap(),
        StatusCode::OK
    );
    let db = server.db().await;
    let background = guivault_server::app_state(server.config.clone(), db.clone());
    assert_eq!(
        guivault_server::routes::emergency::notify_opened(&background)
            .await
            .unwrap(),
        0
    );
    sqlx::query("UPDATE emergency_grants SET requested_at = now() - interval '4 days' WHERE id = $1")
        .bind(grant.id)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(
        guivault_server::routes::emergency::notify_opened(&background)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        guivault_server::routes::emergency::notify_opened(&background)
            .await
            .unwrap(),
        0
    );
    let mails = smtp.wait(9).await;
    assert_eq!(mails[6].subject, "bob@t.io demande l'accès d'urgence à votre coffre");
    // Les deux avis partent ensemble : dans n'importe quel ordre.
    let mut got: Vec<(&str, &str)> = mails[7..9]
        .iter()
        .map(|m| (m.to.as_str(), m.subject.as_str()))
        .collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            (
                "alice@t.io",
                "bob@t.io a maintenant accès à votre coffre (accès d'urgence)"
            ),
            ("bob@t.io", "L'accès d'urgence au coffre de alice@t.io vous est ouvert"),
        ]
    );

    // L'administration : état et e-mail d'essai.
    guivault_server::admin::set_admin(&server.db().await, "alice@t.io", true)
        .await
        .unwrap();
    let overview: AdminOverview = alice.get("/admin/overview").await;
    assert!(overview.mail_enabled && overview.mail_error.is_none());
    status!(
        alice
            .req(reqwest::Method::POST, "/admin/mail-test")
            .send()
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    let mails = smtp.wait(10).await;
    assert_eq!(mails[9].subject, "Essai d'envoi GuiVault");
    server.stop().await;

    // SMTP qui accepte la connexion et ne répond jamais : un envoi attendu
    // bloquerait au moins 20 s (délai de `lettre`). L'invitation et la
    // connexion (qui déclencherait une alerte) répondent quand même.
    let hole = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let hole_addr = hole.local_addr().unwrap();
    let Some(server) = TestServer::start_with(RegistrationMode::Open, move |c| {
        c.trust_proxy = TrustProxy::parse("127.0.0.1").unwrap();
        c.mail = Some(MailConfig {
            smtp_url: format!("smtp://{hole_addr}"),
            from: "GuiVault <coffre@vault.test>".into(),
            public_url: None,
        });
    })
    .await
    else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    let (team, _) = alice.create_vault("Équipe").await;
    let started = std::time::Instant::now();
    status!(
        alice
            .req(reqwest::Method::POST, &format!("/vaults/{}/invitations", team.id))
            .json(&CreateInvitationRequest {
                email: "carol@t.io".into(),
                role: Role::Reader,
                wrapped_vault_key: None,
            })
            .send()
            .await
            .unwrap(),
        StatusCode::CREATED
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "l'envoi n'est jamais attendu"
    );
    assert_eq!(
        login_from(&server, "alice@t.io", "pw-alice", "198.51.100.4").await,
        StatusCode::OK
    );
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "l'alerte de connexion non plus"
    );
    server.stop().await;
    drop(hole);

    // SMTP injoignable : l'e-mail d'essai, lui, le dit.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    let Some(server) = TestServer::start_with(RegistrationMode::Open, move |c| {
        c.mail = Some(MailConfig {
            smtp_url: format!("smtp://{closed}"),
            from: "GuiVault <coffre@vault.test>".into(),
            public_url: None,
        });
    })
    .await
    else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    guivault_server::admin::set_admin(&server.db().await, "alice@t.io", true)
        .await
        .unwrap();
    let body = status!(
        alice
            .req(reqwest::Method::POST, "/admin/mail-test")
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_GATEWAY
    );
    assert!(body.contains("mail_failed"), "{body}");
    server.stop().await;

    // Réglage illisible : le serveur démarre quand même, sans e-mails, et le dit.
    let Some(server) = TestServer::start_with(RegistrationMode::Open, |c| {
        c.mail = Some(MailConfig {
            smtp_url: "n'importe quoi".into(),
            from: "GuiVault <coffre@vault.test>".into(),
            public_url: None,
        });
    })
    .await
    else {
        return;
    };
    let alice = User::register(&server, "alice@t.io", "pw-alice").await;
    guivault_server::admin::set_admin(&server.db().await, "alice@t.io", true)
        .await
        .unwrap();
    let overview: AdminOverview = alice.get("/admin/overview").await;
    assert!(!overview.mail_enabled);
    assert!(overview.mail_error.unwrap().contains("GUIVAULT_SMTP_URL"));
    let body = status!(
        alice
            .req(reqwest::Method::POST, "/admin/mail-test")
            .send()
            .await
            .unwrap(),
        StatusCode::BAD_REQUEST
    );
    assert!(body.contains("mail_disabled"), "{body}");
    server.stop().await;
}
