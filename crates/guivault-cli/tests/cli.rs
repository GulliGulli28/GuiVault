//! `gv` de bout en bout : un vrai serveur (base jetable, comme
//! `guivault-server/tests/api.rs`), un compte et des éléments écrits avec la
//! vraie cryptographie, puis la bibliothèque et le binaire `gv`. Sans
//! Postgres joignable (`GUIVAULT_TEST_DATABASE_URL`), le test s'ignore.
use guivault_cli::store::Home;
use guivault_cli::{Prompt, SecretRef, vault};
use guivault_crypto as gc;
use guivault_protocol::*;
use guivault_server::config::Config;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::time::Duration;
use uuid::Uuid;

const DEFAULT_DB: &str = "postgres://guivault:test@localhost:55432/guivault_test";

struct Server {
    root: String,
    db_name: String,
    admin_url: String,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    rt: tokio::runtime::Runtime,
}

impl Server {
    /// Le serveur tourne sur son propre runtime : le test reste synchrone,
    /// comme `gv` (client HTTP bloquant).
    fn start() -> Option<Self> {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let admin_url = std::env::var("GUIVAULT_TEST_DATABASE_URL").unwrap_or_else(|_| DEFAULT_DB.into());
        let admin = match rt.block_on(sqlx::PgPool::connect(&admin_url)) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("⚠ pas de Postgres de test ({admin_url}) : {e} — test ignoré");
                return None;
            }
        };
        let db_name = format!("guivault_cli_{}", Uuid::new_v4().simple());
        rt.block_on(sqlx::query(&format!("CREATE DATABASE {db_name}")).execute(&admin))
            .unwrap();
        let mut url = url::Url::parse(&admin_url).unwrap();
        url.set_path(&db_name);
        let config = Config {
            database_url: url.to_string(),
            bind: "127.0.0.1:0".parse().unwrap(),
            registration: RegistrationMode::Open,
            allowed_emails: vec![],
            secret: b"test-secret-test-secret-test-secret-test".to_vec(),
            totp_key: Config::derive_totp_key(b"test-secret-test-secret-test-secret-test"),
            access_ttl: Duration::from_secs(900),
            refresh_ttl: Duration::from_secs(86400),
            invitation_ttl: Duration::from_secs(86400),
            trust_proxy: guivault_server::config::TrustProxy::No,
            max_item_bytes: 64 * 1024,
            item_history: 20,
            trash_days: 30,
            auth_rate_burst: 1000,
            auth_rate_per_second: 1000,
            log_json: false,
        };
        let (addr_tx, addr_rx) = std::sync::mpsc::channel::<SocketAddr>();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        rt.spawn(async move {
            guivault_server::serve(config, move |a| addr_tx.send(a).unwrap(), async {
                let _ = stop_rx.await;
            })
            .await
            .unwrap();
        });
        let addr = addr_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        Some(Self {
            root: format!("http://{addr}"),
            db_name,
            admin_url,
            stop: Some(stop_tx),
            rt,
        })
    }

    fn api(&self, path: &str) -> String {
        format!("{}/api/v1{path}", self.root)
    }

    fn stop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
        let (url, db) = (self.admin_url.clone(), self.db_name.clone());
        self.rt.block_on(async move {
            if let Ok(admin) = sqlx::PgPool::connect(&url).await {
                let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"))
                    .execute(&admin)
                    .await;
            }
        });
    }
}

struct Fixed(&'static str);

impl Prompt for Fixed {
    fn password(&self, _: &str) -> anyhow::Result<String> {
        Ok(self.0.into())
    }
    fn code(&self, _: &str) -> anyhow::Result<String> {
        anyhow::bail!("pas de second facteur attendu")
    }
}

/// Un compte et ses éléments, écrits comme l'interface web les écrit.
fn seed(server: &Server, email: &str, password: &str) {
    let http = reqwest::blocking::Client::new();
    let (material, account) = gc::create_account(password).unwrap();
    let key = gc::SymmetricKey::random();
    let vid = Uuid::new_v4();
    let res = http
        .post(server.api("/auth/register"))
        .json(&RegisterRequest {
            email: email.into(),
            kdf: material.kdf,
            kdf_salt: material.kdf_salt,
            auth_key: material.auth_key,
            protected_user_key: material.protected_user_key,
            public_key: material.public_key,
            protected_private_key: material.protected_private_key,
            personal_vault: CreateVaultRequest {
                id: vid,
                name_enc: gc::seal_vault_name(&key, &vid.to_string(), "Personnel").unwrap(),
                wrapped_vault_key: gc::wrap_vault_key(
                    &account.keypair,
                    &account.keypair.public,
                    &vid.to_string(),
                    &key,
                )
                .unwrap(),
            },
            device_name: None,
        })
        .send()
        .unwrap();
    assert_eq!(res.status(), 201);
    let login: LoginResponse = res.json().unwrap();
    let put = |kind: &str, entity_key: &str, entity: Value| {
        let id = Uuid::new_v4();
        let mut e = entity;
        e["id"] = json!(id);
        let payload = json!({ "kind": kind, entity_key: e });
        let ct = gc::seal_item(
            &key,
            &vid.to_string(),
            &id.to_string(),
            kind,
            payload.to_string().as_bytes(),
        )
        .unwrap();
        let res = http
            .put(server.api(&format!("/vaults/{vid}/items/{id}")))
            .bearer_auth(&login.tokens.access_token)
            .json(&PutItemRequest {
                item_type: kind.into(),
                ciphertext: ct,
                base_revision: None,
            })
            .send()
            .unwrap();
        assert_eq!(res.status(), 201);
    };
    put(
        "login",
        "login",
        json!({ "name": "GitHub", "username": "alice", "password": "gh-pass",
        "uris": [{ "uri": "https://github.com" }], "totp": "JBSWY3DPEHPK3PXP",
        "fields": [{ "name": "Recovery", "value": "rc-1", "type": "hidden" }] }),
    );
    put(
        "login",
        "login",
        json!({ "name": "GitLab interne", "username": "bob", "password": "gl-pass",
        "uris": [{ "uri": "gitlab.corp.example:8443" }] }),
    );
    put(
        "api-key",
        "apiKey",
        json!({ "name": "Stripe", "keyId": "pk_1", "secret": "sk_1" }),
    );
    put(
        "aws",
        "aws",
        json!({ "name": "Prod", "authType": "keys", "accessKeyId": "AKIA1", "secretAccessKey": "wJal1" }),
    );
    put(
        "aws",
        "aws",
        json!({ "name": "SSO", "authType": "sso", "ssoStartUrl": "https://x.awsapps.com/start" }),
    );
    put("note", "note", json!({ "name": "Doublon", "content": "a" }));
    put("note", "note", json!({ "name": "Doublon", "content": "b" }));
}

#[test]
fn gv_end_to_end() {
    let Some(mut server) = Server::start() else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("gv-test-{}", Uuid::new_v4().simple()));
    let home = Home(dir.clone());
    let (email, pw) = ("alice@t.io", "cli master password");
    seed(&server, email, pw);

    // Connexion : la clé de session, le cache rempli.
    let key = guivault_cli::login(&home, &server.root, email, "test", &Fixed(pw)).unwrap();
    let (mut account, unlocked) = guivault_cli::unlocked(&home, Some(&key), None).unwrap();
    let (cache, warning) = guivault_cli::cache(&home, &mut account).unwrap();
    assert!(warning.is_none());
    let opened = vault::open(&unlocked, &cache);
    assert!(opened.warnings.is_empty(), "{:?}", opened.warnings);
    let get = |r: &str| guivault_cli::resolve(&opened, &guivault_cli::parse_ref(r).unwrap());

    // Références, champs, secret par défaut.
    assert_eq!(get("gv://Personnel/GitHub/password").unwrap(), "gh-pass");
    assert_eq!(get("gv://personal/github/username").unwrap(), "alice");
    assert_eq!(
        get("gv://GitHub/recovery").unwrap_err().to_string(),
        "aucun vault « GitHub »"
    );
    assert_eq!(get("gv://Personnel/GitHub/recovery").unwrap(), "rc-1");
    assert_eq!(get("gv://Personnel/GitHub/totp").unwrap().len(), 6);
    assert_eq!(get("gv://Stripe").unwrap(), "sk_1");
    assert_eq!(get("gv://Personnel/Stripe/key-id").unwrap(), "pk_1");
    let err = guivault_cli::resolve(
        &opened,
        &SecretRef {
            vault: None,
            item: "Doublon".into(),
            field: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("plusieurs éléments"), "{err}");

    // `gv run` : seules les valeurs gv:// changent.
    let env = vec![
        ("DB".to_string(), "gv://Stripe".to_string()),
        ("PLAIN".to_string(), "x".to_string()),
    ];
    assert_eq!(
        guivault_cli::resolve_env(&opened, &env).unwrap(),
        vec![("DB".to_string(), "sk_1".to_string())]
    );

    // AWS : les clés, pas une session SSO.
    let aws: Value = serde_json::from_str(&guivault_cli::aws_credential_process(&opened, "Prod").unwrap()).unwrap();
    assert_eq!(
        aws,
        json!({ "Version": 1, "AccessKeyId": "AKIA1", "SecretAccessKey": "wJal1" })
    );
    assert!(guivault_cli::aws_credential_process(&opened, "SSO").is_err());

    // Git : l'hôte (et son port), le protocole, l'utilisateur.
    let git = |input: &str| guivault_cli::git_credential(&opened, input);
    assert_eq!(
        git("protocol=https\nhost=github.com\n\n").unwrap(),
        "username=alice\npassword=gh-pass\n"
    );
    assert_eq!(
        git("protocol=https\nhost=gitlab.corp.example:8443\n").unwrap(),
        "username=bob\npassword=gl-pass\n"
    );
    assert!(git("protocol=https\nhost=github.com\nusername=carol\n").is_none());
    assert!(git("protocol=https\nhost=example.org\n").is_none());

    // Le binaire lui-même.
    let gv = |args: &[&str], envs: &[(&str, &str)]| {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_gv"))
            .args(args)
            .env("GV_HOME", &dir)
            .env("GUIVAULT_SESSION", &key)
            .envs(envs.iter().copied())
            .output()
            .unwrap();
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    };
    assert_eq!(gv(&["get", "gv://Personnel/GitHub/password", "-n"], &[]).1, "gh-pass");
    let (ok, out, err) = gv(
        &["run", "--", "sh", "-c", "printf '%s|%s' \"$DB\" \"$PLAIN\""],
        &[("DB", "gv://Stripe"), ("PLAIN", "x")],
    );
    assert!(ok, "{err}");
    assert_eq!(out, "sk_1|x");
    let (ok, _, err) = gv(&["get", "Doublon"], &[]);
    assert!(!ok && err.contains("précisez par l'id"), "{err}");

    // Déverrouiller : mauvais mot de passe refusé ; une nouvelle session rend
    // l'ancienne clé caduque.
    assert!(guivault_cli::unlock(&home, &Fixed("wrong")).is_err());
    let key2 = guivault_cli::unlock(&home, &Fixed(pw)).unwrap();
    assert!(guivault_cli::unlocked(&home, Some(&key), None).is_err());
    assert!(guivault_cli::unlocked(&home, Some(&key2), None).is_ok());

    // Jeton d'accès expiré : rafraîchi, et le nouveau jeton gardé.
    let mut account = home.account().unwrap().unwrap();
    account.tokens.access_expires_at = chrono::Utc::now() - chrono::Duration::minutes(1);
    home.save_account(&account).unwrap();
    let before = account.tokens.refresh_token.clone();
    guivault_cli::sync(&home, &mut account).unwrap();
    let stored = home.account().unwrap().unwrap();
    assert_ne!(stored.tokens.refresh_token, before);
    guivault_cli::sync(&home, &mut account.clone()).unwrap();

    // Paramètres épinglés : un prelogin plus faible que la dernière fois est
    // refusé avant d'envoyer quoi que ce soit.
    let mut pinned = home.account().unwrap().unwrap();
    pinned.kdf.m_cost *= 2;
    home.save_account(&pinned).unwrap();
    let err = guivault_cli::login(&home, &server.root, email, "test", &Fixed(pw)).unwrap_err();
    assert!(err.to_string().contains("plus faible"), "{err}");
    pinned.kdf.m_cost /= 2;
    home.save_account(&pinned).unwrap();

    // Serveur arrêté : le cache (vieilli) sert, avec un avertissement.
    server.stop();
    let mut cache = home.cache().unwrap().unwrap();
    cache.synced_at = Some(chrono::Utc::now() - chrono::Duration::hours(1));
    home.save_cache(&cache).unwrap();
    let mut account = home.account().unwrap().unwrap();
    let (cache, warning) = guivault_cli::cache(&home, &mut account).unwrap();
    assert!(warning.is_some_and(|w| w.contains("cache")));
    let (_, unlocked) = guivault_cli::unlocked(&home, Some(&key2), None).unwrap();
    let opened = vault::open(&unlocked, &cache);
    assert_eq!(
        guivault_cli::resolve(&opened, &guivault_cli::parse_ref("gv://GitHub").unwrap()).unwrap(),
        "gh-pass"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
