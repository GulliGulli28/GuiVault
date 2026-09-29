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
            send_max_days: 30,
            max_attachment_bytes: 10 * 1024 * 1024,
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

    /// La base du serveur, pour jouer un serveur qui ment.
    fn sql(&self, query: &str, bytes: Option<Vec<u8>>) {
        let mut url = url::Url::parse(&self.admin_url).unwrap();
        url.set_path(&self.db_name);
        self.rt.block_on(async {
            let pool = sqlx::PgPool::connect(url.as_str()).await.unwrap();
            let q = sqlx::query(query);
            let q = match bytes {
                Some(b) => q.bind(b),
                None => q,
            };
            q.execute(&pool).await.unwrap();
        });
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

/// Un compte et ses éléments, écrits comme l'interface web les écrit. Rend
/// la clé et l'id du vault personnel, et un jeton d'accès.
fn seed(server: &Server, email: &str, password: &str) -> (gc::SymmetricKey, Uuid, String) {
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
                manifest: None,
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
    (key, vid, login.tokens.access_token)
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

#[test]
fn gv_checks_vault_manifests() {
    let Some(server) = Server::start() else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("gv-test-{}", Uuid::new_v4().simple()));
    let home = Home(dir.clone());
    let (email, pw) = ("bob@t.io", "cli master password");
    let (key, vid, token) = seed(&server, email, pw);
    let http = reqwest::blocking::Client::new();

    // Le manifeste, comme l'interface web l'écrit : créé (base 0), réécrit.
    let write_manifest = |base: i64| {
        let page: ItemsPage = http
            .get(server.api(&format!("/vaults/{vid}/items")))
            .bearer_auth(&token)
            .send()
            .unwrap()
            .json()
            .unwrap();
        let live: Vec<(String, Vec<u8>)> = page
            .items
            .into_iter()
            .filter(|i| !i.deleted)
            .map(|i| (i.id.to_string(), i.ciphertext))
            .collect();
        let m = gc::Manifest::of(base + 1, live.iter().map(|(i, c)| (i.as_str(), c.as_slice())));
        let res = http
            .put(server.api(&format!("/vaults/{vid}/manifest")))
            .bearer_auth(&token)
            .json(&PutManifestRequest {
                ciphertext: gc::seal_manifest(&key, &vid.to_string(), &m).unwrap(),
                base_revision: base,
                vault_revision: page.revision,
            })
            .send()
            .unwrap();
        assert!(res.status().is_success(), "{}", res.text().unwrap());
        gc::seal_manifest(&key, &vid.to_string(), &m).unwrap()
    };
    let first = write_manifest(0);

    let session = guivault_cli::login(&home, &server.root, email, "test", &Fixed(pw)).unwrap();
    let (mut account, unlocked) = guivault_cli::unlocked(&home, Some(&session), None).unwrap();
    let open = |account: &mut guivault_cli::store::Account| {
        let cache = guivault_cli::sync(&home, account).unwrap();
        guivault_cli::open(&home, account, &unlocked, &cache).unwrap()
    };
    let seen = || home.manifest_counters(&server.root).unwrap().get(&vid).copied();

    // Un serveur fidèle : rien à dire, le compteur retenu.
    let opened = open(&mut account);
    assert!(opened.warnings.is_empty(), "{:?}", opened.warnings);
    assert_eq!(seen(), Some(1));
    write_manifest(1);
    assert!(open(&mut account).problems.is_empty());
    assert_eq!(seen(), Some(2));

    // Il ressert l'ancien manifeste : vu, et le compteur ne recule pas.
    server.sql(
        &format!("UPDATE vaults SET manifest = $1, manifest_revision = 1, revision = revision + 1 WHERE id = '{vid}'"),
        Some(first),
    );
    let opened = open(&mut account);
    assert_eq!(
        opened.problems,
        vec![(vid, gc::ManifestProblem::Rollback { counter: 1, seen: 2 })]
    );
    assert!(
        opened.warnings.iter().any(|w| w.contains("gv sync --accept")),
        "{:?}",
        opened.warnings
    );
    assert_eq!(seen(), Some(2));
    // Une restauration connue : on en prend acte.
    let cache = home.cache().unwrap().unwrap();
    guivault_cli::accept_manifests(&home, &account, &cache).unwrap();
    assert_eq!(seen(), Some(1));
    assert!(open(&mut account).problems.is_empty());

    // Une ancienne version de GitHub rejouée, Stripe retenu.
    let id_of = |name: &str| opened.entries.iter().find(|e| e.name == name).unwrap().id;
    let (github, stripe) = (id_of("GitHub"), id_of("Stripe"));
    let old = json!({ "kind": "login", "login": { "id": github, "name": "GitHub", "password": "old-pass" } });
    let replayed = gc::seal_item(
        &key,
        &vid.to_string(),
        &github.to_string(),
        "login",
        old.to_string().as_bytes(),
    )
    .unwrap();
    server.sql(
        &format!("UPDATE items SET ciphertext = $1 WHERE id = '{github}'"),
        Some(replayed),
    );
    server.sql(&format!("DELETE FROM items WHERE id = '{stripe}'"), None);
    server.sql(
        &format!("UPDATE vaults SET revision = revision + 1 WHERE id = '{vid}'"),
        None,
    );
    let opened = open(&mut account);
    assert_eq!(
        opened.problems,
        vec![
            (
                vid,
                gc::ManifestProblem::Altered {
                    item_id: github.to_string()
                }
            ),
            (
                vid,
                gc::ManifestProblem::Withheld {
                    item_id: stripe.to_string()
                }
            ),
        ]
    );
    assert!(
        opened
            .warnings
            .iter()
            .any(|w| w.contains("« GitHub » n'est pas la version annoncée")),
        "{:?}",
        opened.warnings
    );
    // `gv` lit quand même (il ne fait que lire), et le dit.
    assert_eq!(
        guivault_cli::resolve(
            &opened,
            &guivault_cli::parse_ref("gv://Personnel/GitHub/password").unwrap()
        )
        .unwrap(),
        "old-pass"
    );

    // Le binaire : le secret sur la sortie, l'alerte sur la sortie d'erreur ;
    // `--accept` ne fait pas taire un écart d'élément.
    let gv = |args: &[&str]| {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_gv"))
            .args(args)
            .env("GV_HOME", &dir)
            .env("GUIVAULT_SESSION", &session)
            .output()
            .unwrap();
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    };
    let (ok, out, err) = gv(&["get", "gv://Personnel/GitHub/password", "-n"]);
    assert!(ok, "{err}");
    assert_eq!(out, "old-pass");
    assert!(err.contains("manifeste"), "{err}");
    let (ok, _, err) = gv(&["sync", "--accept"]);
    assert!(ok, "{err}");
    let (_, _, err) = gv(&["get", "gv://Personnel/GitHub/password"]);
    assert!(err.contains("« GitHub » n'est pas la version annoncée"), "{err}");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Une pièce jointe envoyée comme l'interface web l'envoie, puis rattachée à
/// l'item (`docs/PIECES-JOINTES.md`). Rend sa description.
fn attach(server: &Server, token: &str, vid: Uuid, item: Uuid, name: &str, data: &[u8]) -> Value {
    let http = reqwest::blocking::Client::new();
    let key = gc::SymmetricKey::random();
    let id = Uuid::new_v4();
    let chunks = gc::seal_attachment(&key, &id.to_string(), data).unwrap();
    let size: usize = chunks.iter().map(Vec::len).sum();
    let res = http
        .post(server.api(&format!("/vaults/{vid}/attachments")))
        .bearer_auth(token)
        .json(&CreateAttachmentRequest {
            id,
            item_id: item,
            size: size as i64,
            chunks: chunks.len() as i32,
        })
        .send()
        .unwrap();
    assert_eq!(res.status(), 201);
    for (i, c) in chunks.iter().enumerate() {
        let res = http
            .put(server.api(&format!("/vaults/{vid}/attachments/{id}/chunks/{i}")))
            .bearer_auth(token)
            .body(c.clone())
            .send()
            .unwrap();
        assert_eq!(res.status(), 204);
    }
    let res = http
        .post(server.api(&format!("/vaults/{vid}/attachments/{id}/complete")))
        .bearer_auth(token)
        .send()
        .unwrap();
    assert_eq!(res.status(), 200);
    use base64::Engine;
    json!({ "id": id, "name": name, "size": data.len(), "key": base64::engine::general_purpose::STANDARD.encode(key.as_bytes()) })
}

#[test]
fn gv_downloads_attachments() {
    let Some(server) = Server::start() else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("gv-test-{}", Uuid::new_v4().simple()));
    let home = Home(dir.clone());
    let (email, pw) = ("carol@t.io", "cli master password");
    let (key, vid, token) = seed(&server, email, pw);
    let http = reqwest::blocking::Client::new();

    // Une note, puis deux fichiers qu'on lui rattache (1,5 Mio : deux morceaux).
    let note = Uuid::new_v4();
    let put = |body: Value, base: Option<i64>| -> Item {
        let ct = gc::seal_item(
            &key,
            &vid.to_string(),
            &note.to_string(),
            "note",
            body.to_string().as_bytes(),
        )
        .unwrap();
        let res = http
            .put(server.api(&format!("/vaults/{vid}/items/{note}")))
            .bearer_auth(&token)
            .json(&PutItemRequest {
                item_type: "note".into(),
                ciphertext: ct,
                base_revision: base,
                manifest: None,
            })
            .send()
            .unwrap();
        assert!(res.status().is_success());
        res.json().unwrap()
    };
    let first = put(
        json!({ "kind": "note", "note": { "id": note, "name": "Contrat", "content": "voir le scan" } }),
        None,
    );
    let scan: Vec<u8> = (0..3 * 512 * 1024).map(|i| (i % 253) as u8).collect();
    let codes = b"1234-5678\n".to_vec();
    let a1 = attach(&server, &token, vid, note, "scan.pdf", &scan);
    let a2 = attach(&server, &token, vid, note, "codes.txt", &codes);
    put(
        json!({ "kind": "note", "note": { "id": note, "name": "Contrat", "content": "voir le scan", "attachments": [a1, a2] } }),
        Some(first.revision),
    );

    // La bibliothèque : trouver, désigner, télécharger.
    let session = guivault_cli::login(&home, &server.root, email, "test", &Fixed(pw)).unwrap();
    let (mut account, unlocked) = guivault_cli::unlocked(&home, Some(&session), None).unwrap();
    let (cache, _) = guivault_cli::cache(&home, &mut account).unwrap();
    let opened = vault::open(&unlocked, &cache);
    let entry = opened.find(None, "Contrat").unwrap();
    let list = guivault_cli::attachments(entry);
    assert_eq!(
        list.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
        ["scan.pdf", "codes.txt"]
    );
    let err = guivault_cli::find_attachment(entry, None).unwrap_err().to_string();
    assert!(err.contains("précisez laquelle"), "{err}");
    assert!(guivault_cli::find_attachment(entry, Some("absent.pdf")).is_err());
    let scan_ref = guivault_cli::find_attachment(entry, Some("SCAN.PDF")).unwrap();
    let got = guivault_cli::download_attachment(&home, &mut account, vid, &scan_ref).unwrap();
    assert_eq!(got, scan);
    // Une clé qui n'est pas la sienne : le morceau ne s'ouvre pas.
    let mut forged = scan_ref.clone();
    use base64::Engine;
    forged.key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    let err = guivault_cli::download_attachment(&home, &mut account, vid, &forged)
        .unwrap_err()
        .to_string();
    assert!(err.contains("ne s'ouvre pas"), "{err}");

    // Le binaire : la liste, un fichier à son nom (jamais par-dessus), la sortie.
    let work = dir.join("out");
    std::fs::create_dir_all(&work).unwrap();
    let gv = |args: &[&str]| {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_gv"))
            .args(args)
            .current_dir(&work)
            .env("GV_HOME", &dir)
            .env("GUIVAULT_SESSION", &session)
            .output()
            .unwrap();
        (
            out.status.success(),
            out.stdout,
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    };
    let (ok, out, err) = gv(&["attachment", "list", "Contrat"]);
    assert!(ok, "{err}");
    let listing = String::from_utf8(out).unwrap();
    assert!(
        listing.contains("scan.pdf\t1572864") && listing.contains("codes.txt\t10"),
        "{listing}"
    );
    let (ok, _, err) = gv(&["attachment", "get", "Contrat", "scan.pdf"]);
    assert!(ok, "{err}");
    assert_eq!(std::fs::read(work.join("scan.pdf")).unwrap(), scan);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(work.join("scan.pdf")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let (ok, _, err) = gv(&["attachment", "get", "Contrat", "scan.pdf"]);
    assert!(!ok && err.contains("existe déjà"), "{err}");
    let (ok, out, err) = gv(&["attachment", "get", "gv://Personnel/Contrat/codes.txt", "-o", "-"]);
    assert!(ok, "{err}");
    assert_eq!(out, codes);
    let (ok, _, err) = gv(&["attachment", "get", "Contrat"]);
    assert!(!ok && err.contains("précisez laquelle"), "{err}");

    let _ = std::fs::remove_dir_all(&dir);
}
