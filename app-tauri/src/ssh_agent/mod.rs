//! L'agent SSH de l'application (`docs/APP.md`, « Agent SSH ») : `ssh`, `git`,
//! `scp`… lancés sur le poste lui demandent de signer avec les clés du coffre
//! ouvert, qui ne sont jamais écrites sur le disque. Repris de l'agent de
//! Guiterm (`core/src/ssh_agent/`) : même protocole, même confirmation qui
//! dit ce qui est signé et qui le demande, même refus de tout ce qui ajoute,
//! retire ou verrouille des clés.
//!
//! Ce qui change ici : les clés viennent de l'interface (le coffre est
//! déchiffré par elle, `web/src/components/SshAgent.tsx`) — confiées à
//! l'ouverture, retirées et effacées au verrouillage ; et l'application ne
//! connaît pas les clés d'hôte des serveurs (pas de `known_hosts`) : toutes
//! les clés confiées sont présentées, l'hôte n'est dit que par l'empreinte de
//! sa clé, quand le client l'annonce.
//!
//! La règle n°1 tient : c'est l'application, sur ce poste, qui signe ; rien
//! ne part ailleurs.
pub mod protocol;
pub mod purpose;
mod server;

use protocol::Request;
use purpose::Purpose;
use serde::{Deserialize, Serialize};
use signature::{Signer, Verifier};
use ssh_key::private::KeypairData;
use ssh_key::{HashAlg, PrivateKey, PublicKey, Signature};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use zeroize::Zeroize;

/// Combien de temps « ne plus demander pour cette clé » vaut.
pub const REMEMBER_FOR: Duration = Duration::from_secs(10 * 60);

/// Sans réponse au bout de ce délai, la signature est refusée.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Une clé confiée par l'interface, déchiffrée.
pub struct LoadedKey {
    pub id: String,
    pub name: String,
    pub public: PublicKey,
    private: PrivateKey,
}

/// Une clé telle que l'interface l'envoie : le texte de la clé privée et sa
/// phrase de passe, effacés une fois lus.
#[derive(Deserialize)]
pub struct KeyInput {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub passphrase: Option<String>,
}

impl Drop for KeyInput {
    fn drop(&mut self) {
        self.content.zeroize();
        if let Some(p) = &mut self.passphrase {
            p.zeroize();
        }
    }
}

/// Ce que l'interface affiche de chaque clé confiée.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub id: String,
    pub fingerprint: Option<String>,
    pub error: Option<String>,
}

/// Lit une clé au format OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`),
/// chiffrée ou non.
pub fn load_key(input: &KeyInput) -> Result<LoadedKey, String> {
    let key = PrivateKey::from_openssh(input.content.trim()).map_err(|_| {
        if input.content.contains("BEGIN RSA PRIVATE KEY")
            || input.content.contains("BEGIN PRIVATE KEY")
            || input.content.contains("BEGIN EC PRIVATE KEY")
        {
            "format PEM ancien : le convertir avec `ssh-keygen -p -f <fichier>`".to_string()
        } else {
            "clé illisible (format OpenSSH attendu)".to_string()
        }
    })?;
    let private = if key.is_encrypted() {
        let pass = input
            .passphrase
            .as_deref()
            .filter(|p| !p.is_empty())
            .ok_or("clé chiffrée sans phrase de passe enregistrée")?;
        key.decrypt(pass)
            .map_err(|_| "phrase de passe incorrecte".to_string())?
    } else {
        key
    };
    Ok(LoadedKey {
        id: input.id.clone(),
        name: input.name.clone(),
        public: private.public_key().clone(),
        private,
    })
}

/// Qui demande, quand le système le dit (Windows : le processus au bout du
/// tube).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    pub pid: Option<u32>,
    pub program: Option<String>,
}

/// Ce qui est signé, dit pour l'utilisateur.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UsePurpose {
    /// Une connexion SSH ; `fingerprint` : la clé d'hôte du serveur, quand
    /// le client l'a annoncée (et prouvée) pour cette session.
    SshLogin {
        user: String,
        fingerprint: Option<String>,
    },
    /// Un commit ou une étiquette Git signés (`SSHSIG`, espace `git`).
    GitSignature,
    /// Une autre signature `SSHSIG` (`ssh-keygen -Y sign -n <namespace>`).
    Sshsig {
        namespace: String,
    },
    Unknown,
}

/// La question posée à l'utilisateur.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UseRequest {
    pub key_id: String,
    pub key_name: String,
    pub key_fingerprint: String,
    pub purpose: UsePurpose,
    pub client: Client,
    /// La demande vient d'un hôte distant par un agent transféré.
    pub forwarded: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize)]
pub struct Decision {
    pub allow: bool,
    /// Ne plus demander pour cette clé pendant [`REMEMBER_FOR`].
    pub remember: bool,
}

pub type Pending<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Qui répond à la question : la fenêtre de l'application, ou un test.
pub trait Confirmer: Send + Sync {
    fn confirm(&self, request: UseRequest) -> Pending<Decision>;
}

/// Ce que le client a annoncé de son serveur, vérifié.
#[derive(Clone, Debug)]
pub struct Binding {
    pub host_key: PublicKey,
    pub session_id: Vec<u8>,
    pub forwarding: bool,
}

/// L'état d'une connexion d'un client à l'agent.
#[derive(Default)]
pub struct Session {
    pub client: Client,
    /// Une par saut (`ProxyJump`) : la dernière est la destination.
    pub bindings: Vec<Binding>,
}

/// La signature d'un hôte sur l'id de session : ce qui prouve que la clé
/// d'hôte annoncée est bien celle du serveur de cette session — sans quoi un
/// processus local pourrait faire afficher l'empreinte d'un hôte de confiance.
pub fn verify_binding(host_key: &[u8], session_id: &[u8], signature: &[u8]) -> Option<PublicKey> {
    let key = PublicKey::from_bytes(host_key).ok()?;
    let sig = Signature::try_from(signature).ok()?;
    Verifier::verify(key.key_data(), session_id, &sig).ok()?;
    Some(key)
}

/// Signe `data` avec `key`. RSA : l'algorithme de hachage que le client
/// demande (`rsa-sha2-512` ou `rsa-sha2-256` ; l'ancien `ssh-rsa` à SHA-1
/// est refusé, comme OpenSSH le fait par défaut depuis la 8.8).
pub fn sign(key: &PrivateKey, data: &[u8], flags: u32) -> Result<Vec<u8>, String> {
    let sig: Signature = match key.key_data() {
        KeypairData::Rsa(rsa) => {
            use rsa::pkcs1v15::SigningKey;
            use signature::{RandomizedSigner, SignatureEncoding};
            use ssh_key::rand_core::OsRng;
            use ssh_key::sha2::{Sha256, Sha512};
            // Avec un aléa : `rsa` aveugle l'opération privée, et le temps
            // qu'elle prend ne dit plus rien de l'entrée choisie par le
            // demandeur (RUSTSEC-2023-0071, `.cargo/audit.toml`).
            let private = rsa_private(rsa)?;
            let (hash, data) = if flags & protocol::RSA_SHA2_512 != 0 {
                (
                    HashAlg::Sha512,
                    SigningKey::<Sha512>::new(private)
                        .try_sign_with_rng(&mut OsRng, data)
                        .map(|s| s.to_vec()),
                )
            } else if flags & protocol::RSA_SHA2_256 != 0 {
                (
                    HashAlg::Sha256,
                    SigningKey::<Sha256>::new(private)
                        .try_sign_with_rng(&mut OsRng, data)
                        .map(|s| s.to_vec()),
                )
            } else {
                return Err("signature ssh-rsa (SHA-1) refusée".into());
            };
            let data = data.map_err(|e| format!("signature RSA impossible : {e}"))?;
            Signature::new(ssh_key::Algorithm::Rsa { hash: Some(hash) }, data).map_err(|e| e.to_string())?
        }
        keypair => Signer::try_sign(keypair, data).map_err(|e| format!("signature impossible : {e}"))?,
    };
    Vec::<u8>::try_from(sig).map_err(|e| format!("signature illisible : {e}"))
}

/// La clé RSA pour `rsa` — pas par la conversion de `ssh-key` 0.6, qui passe
/// `p` deux fois au lieu de `p` et `q` (toute signature y échoue).
fn rsa_private(key: &ssh_key::private::RsaKeypair) -> Result<rsa::RsaPrivateKey, String> {
    let n = |m: &ssh_key::Mpint| {
        m.as_positive_bytes()
            .map(rsa::BigUint::from_bytes_be)
            .ok_or_else(|| "clé RSA illisible".to_string())
    };
    rsa::RsaPrivateKey::from_components(
        n(&key.public.n)?,
        n(&key.public.e)?,
        n(&key.private.d)?,
        vec![n(&key.private.p)?, n(&key.private.q)?],
    )
    .map_err(|e| format!("clé RSA illisible : {e}"))
}

/// L'agent : les clés confiées, le protocole, et les accords « pour 10
/// minutes » en mémoire.
pub struct Agent {
    keys: Mutex<Vec<LoadedKey>>,
    remembered: Mutex<HashMap<String, Instant>>,
    confirmer: Box<dyn Confirmer>,
}

impl Agent {
    pub fn new(confirmer: Box<dyn Confirmer>) -> Self {
        Self {
            keys: Mutex::new(Vec::new()),
            remembered: Mutex::new(HashMap::new()),
            confirmer,
        }
    }

    /// Remplace les clés confiées (vide : coffre verrouillé) ; oublie les
    /// accords « pour 10 minutes ».
    pub fn set_keys(&self, inputs: Vec<KeyInput>) -> Vec<KeyStatus> {
        let mut loaded = Vec::new();
        let mut status = Vec::new();
        for input in &inputs {
            match load_key(input) {
                Ok(k) => {
                    status.push(KeyStatus {
                        id: k.id.clone(),
                        fingerprint: Some(k.public.fingerprint(HashAlg::Sha256).to_string()),
                        error: None,
                    });
                    loaded.push(k);
                }
                Err(e) => status.push(KeyStatus {
                    id: input.id.clone(),
                    fingerprint: None,
                    error: Some(e),
                }),
            }
        }
        *lock(&self.keys) = loaded;
        lock(&self.remembered).clear();
        status
    }

    /// Répond à une trame ; `session` garde ce que le client a annoncé.
    pub async fn handle(&self, payload: &[u8], session: &mut Session) -> Vec<u8> {
        match protocol::parse(payload) {
            Ok(Request::Identities) => {
                let ids: Vec<(Vec<u8>, String)> = lock(&self.keys)
                    .iter()
                    .filter_map(|k| Some((k.public.to_bytes().ok()?, k.name.clone())))
                    .collect();
                protocol::identities_answer(&ids)
            }
            Ok(Request::Sign { key_blob, data, flags }) => {
                match self.sign_request(&key_blob, &data, flags, session).await {
                    Ok(sig) => protocol::sign_response(&sig),
                    Err(_) => vec![protocol::FAILURE],
                }
            }
            Ok(Request::SessionBind {
                host_key,
                session_id,
                signature,
                forwarding,
            }) => match verify_binding(&host_key, &session_id, &signature) {
                Some(key) => {
                    session.bindings.push(Binding {
                        host_key: key,
                        session_id,
                        forwarding,
                    });
                    vec![protocol::SUCCESS]
                }
                None => vec![protocol::FAILURE],
            },
            Ok(Request::UnknownExtension(_)) => vec![protocol::EXTENSION_FAILURE],
            Ok(Request::Other(_)) | Err(_) => vec![protocol::FAILURE],
        }
    }

    async fn sign_request(
        &self,
        key_blob: &[u8],
        data: &[u8],
        flags: u32,
        session: &Session,
    ) -> Result<Vec<u8>, String> {
        let (id, name, fingerprint) = lock(&self.keys)
            .iter()
            .find(|k| k.public.to_bytes().is_ok_and(|b| b == key_blob))
            .map(|k| {
                (
                    k.id.clone(),
                    k.name.clone(),
                    k.public.fingerprint(HashAlg::Sha256).to_string(),
                )
            })
            .ok_or("clé inconnue de l'agent")?;
        let purpose = match purpose::describe(data) {
            Purpose::SshLogin {
                session_id,
                user,
                host_key,
            } => {
                // L'empreinte de l'hôte n'est dite que si le client l'a
                // annoncée (et prouvée) pour **cette** session.
                let binding = session.bindings.iter().find(|b| b.session_id == session_id);
                let embedded = host_key.as_deref().and_then(|k| PublicKey::from_bytes(k).ok());
                let fingerprint = binding
                    .filter(|b| embedded.as_ref().is_none_or(|k| k == &b.host_key))
                    .map(|b| b.host_key.fingerprint(HashAlg::Sha256).to_string());
                UsePurpose::SshLogin { user, fingerprint }
            }
            Purpose::Sshsig { namespace } if namespace == "git" => UsePurpose::GitSignature,
            Purpose::Sshsig { namespace } => UsePurpose::Sshsig { namespace },
            Purpose::Unknown => UsePurpose::Unknown,
        };
        let forwarded = session.bindings.iter().any(|b| b.forwarding);
        let remembered = lock(&self.remembered)
            .get(&id)
            .is_some_and(|until| Instant::now() < *until);
        // Un agent transféré sur un hôte distant demande toujours : là-bas,
        // n'importe quel processus root peut s'en servir.
        if !remembered || forwarded {
            let request = UseRequest {
                key_id: id.clone(),
                key_name: name,
                key_fingerprint: fingerprint,
                purpose,
                client: session.client.clone(),
                forwarded,
            };
            let decision = self.confirmer.confirm(request).await;
            if !decision.allow {
                return Err("refusée par l'utilisateur".into());
            }
            if decision.remember && !forwarded {
                lock(&self.remembered).insert(id.clone(), Instant::now() + REMEMBER_FOR);
            }
        }
        // La clé a pu être retirée (verrouillage) pendant la question.
        let keys = lock(&self.keys);
        let key = keys
            .iter()
            .find(|k| k.id == id)
            .ok_or("coffre verrouillé entre-temps")?;
        sign(&key.private, data, flags)
    }
}

// ─── L'application : la question dans la fenêtre, les commandes ─────────────

/// La question envoyée à la fenêtre (`ssh-agent-confirm`) ; la réponse
/// revient par `ssh_agent_answer` avec le même `id`.
#[derive(Clone, Serialize)]
struct Question {
    id: u64,
    request: UseRequest,
}

type Answers = Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Decision>>>>;

struct WindowConfirmer {
    app: AppHandle,
    answers: Answers,
    next: AtomicU64,
}

impl Confirmer for WindowConfirmer {
    fn confirm(&self, request: UseRequest) -> Pending<Decision> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = tokio::sync::oneshot::channel();
        lock(&self.answers).insert(id, tx);
        let app = self.app.clone();
        let answers = self.answers.clone();
        Box::pin(async move {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
            }
            if app.emit("ssh-agent-confirm", Question { id, request }).is_err() {
                lock(&answers).remove(&id);
                return Decision::default();
            }
            match tokio::time::timeout(CONFIRM_TIMEOUT, rx).await {
                Ok(Ok(d)) => d,
                _ => {
                    lock(&answers).remove(&id);
                    let _ = app.emit("ssh-agent-cancel", id);
                    Decision::default()
                }
            }
        })
    }
}

/// L'état de l'agent dans l'application.
#[derive(Default)]
pub struct SshAgent {
    agent: OnceLock<Arc<Agent>>,
    answers: Answers,
    running: Mutex<Option<server::Running>>,
}

impl SshAgent {
    fn agent(&self, app: &AppHandle) -> Arc<Agent> {
        self.agent
            .get_or_init(|| {
                let confirmer = WindowConfirmer {
                    app: app.clone(),
                    answers: self.answers.clone(),
                    next: AtomicU64::new(1),
                };
                Arc::new(Agent::new(Box::new(confirmer)))
            })
            .clone()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    running: bool,
    endpoint: String,
}

/// Démarre l'agent (s'il ne tourne pas déjà) : rend où il écoute.
#[tauri::command]
pub async fn ssh_agent_start(app: AppHandle, state: tauri::State<'_, SshAgent>) -> Result<AgentStatus, String> {
    if let Some(r) = lock(&state.running).as_ref() {
        return Ok(AgentStatus {
            running: true,
            endpoint: r.endpoint.clone(),
        });
    }
    let endpoint = server::default_endpoint()?;
    let running = server::start(&endpoint, state.agent(&app)).await?;
    *lock(&state.running) = Some(running);
    Ok(AgentStatus {
        running: true,
        endpoint,
    })
}

#[tauri::command]
pub fn ssh_agent_stop(state: tauri::State<'_, SshAgent>) {
    lock(&state.running).take();
}

#[tauri::command]
pub fn ssh_agent_status(state: tauri::State<'_, SshAgent>) -> Result<AgentStatus, String> {
    Ok(match lock(&state.running).as_ref() {
        Some(r) => AgentStatus {
            running: true,
            endpoint: r.endpoint.clone(),
        },
        None => AgentStatus {
            running: false,
            endpoint: server::default_endpoint()?,
        },
    })
}

/// Les clés du coffre ouvert (vide : verrouillé). Rend, par clé, son
/// empreinte ou pourquoi elle n'a pas pu être lue.
#[tauri::command]
pub fn ssh_agent_set_keys(app: AppHandle, state: tauri::State<'_, SshAgent>, keys: Vec<KeyInput>) -> Vec<KeyStatus> {
    state.agent(&app).set_keys(keys)
}

#[tauri::command]
pub fn ssh_agent_answer(state: tauri::State<'_, SshAgent>, id: u64, decision: Decision) {
    if let Some(tx) = lock(&state.answers).remove(&id) {
        let _ = tx.send(decision);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ssh_key::Algorithm;
    use ssh_key::rand_core::OsRng;

    fn random(alg: Algorithm) -> PrivateKey {
        PrivateKey::random(&mut OsRng, alg).unwrap()
    }

    struct Answer(Decision, Arc<Mutex<Vec<UseRequest>>>);
    impl Confirmer for Answer {
        fn confirm(&self, request: UseRequest) -> Pending<Decision> {
            lock(&self.1).push(request);
            let d = self.0;
            Box::pin(async move { d })
        }
    }

    fn input(id: &str, key: &PrivateKey, passphrase: Option<&str>) -> KeyInput {
        let content = match passphrase {
            Some(p) => key
                .encrypt(&mut OsRng, p)
                .unwrap()
                .to_openssh(ssh_key::LineEnding::LF)
                .unwrap()
                .to_string(),
            None => key.to_openssh(ssh_key::LineEnding::LF).unwrap().to_string(),
        };
        KeyInput {
            id: id.into(),
            name: format!("clé {id}"),
            content,
            passphrase: passphrase.map(String::from),
        }
    }

    fn sign_request(key: &PublicKey, data: &[u8], flags: u32) -> Vec<u8> {
        let put = |out: &mut Vec<u8>, b: &[u8]| {
            out.extend((b.len() as u32).to_be_bytes());
            out.extend(b);
        };
        let mut req = vec![protocol::SIGN_REQUEST];
        put(&mut req, &key.to_bytes().unwrap());
        put(&mut req, data);
        req.extend(flags.to_be_bytes());
        req
    }

    #[test]
    fn loads_openssh_keys_encrypted_or_not_and_says_why_not() {
        let agent = Agent::new(Box::new(Answer(Decision::default(), Default::default())));
        let ed = random(Algorithm::Ed25519);
        let status = agent.set_keys(vec![
            input("a", &ed, None),
            input("b", &ed, Some("phrase")),
            {
                let mut c = input("c", &ed, Some("phrase"));
                c.passphrase = Some("autre".into());
                c
            },
            KeyInput {
                id: "d".into(),
                name: "d".into(),
                content: "-----BEGIN RSA PRIVATE KEY-----\n…".into(),
                passphrase: None,
            },
        ]);
        let fp = ed.public_key().fingerprint(HashAlg::Sha256).to_string();
        assert_eq!(
            status[0],
            KeyStatus {
                id: "a".into(),
                fingerprint: Some(fp.clone()),
                error: None
            }
        );
        assert_eq!(status[1].fingerprint, Some(fp));
        assert_eq!(status[2].error.as_deref(), Some("phrase de passe incorrecte"));
        assert!(status[3].error.as_deref().unwrap().contains("ssh-keygen -p"));
        assert_eq!(lock(&agent.keys).len(), 2);
    }

    #[tokio::test]
    async fn signs_after_asking_and_remembers_for_ten_minutes() {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let agent = Agent::new(Box::new(Answer(
            Decision {
                allow: true,
                remember: true,
            },
            asked.clone(),
        )));
        let ed = random(Algorithm::Ed25519);
        agent.set_keys(vec![input("a", &ed, None)]);
        let mut session = Session::default();
        let data = [b"SSHSIG".to_vec(), 3u32.to_be_bytes().to_vec(), b"git".to_vec()].concat();
        for _ in 0..2 {
            let reply = agent
                .handle(&sign_request(ed.public_key(), &data, 0), &mut session)
                .await;
            assert_eq!(reply[0], protocol::SIGN_RESPONSE);
            let mut r = protocol::Reader::new(&reply[1..]);
            let sig = Signature::try_from(r.bytes().unwrap()).unwrap();
            assert!(Verifier::verify(ed.public_key().key_data(), &data, &sig).is_ok());
        }
        // Une seule question : la seconde signature était couverte.
        {
            let asked = lock(&asked);
            assert_eq!(asked.len(), 1);
            assert_eq!(asked[0].purpose, UsePurpose::GitSignature);
        }
        // Verrouiller oublie l'accord et retire la clé.
        agent.set_keys(vec![]);
        let reply = agent
            .handle(&sign_request(ed.public_key(), &data, 0), &mut session)
            .await;
        assert_eq!(reply, vec![protocol::FAILURE]);
    }

    #[tokio::test]
    async fn a_refusal_signs_nothing() {
        let agent = Agent::new(Box::new(Answer(Decision::default(), Default::default())));
        let ed = random(Algorithm::Ed25519);
        agent.set_keys(vec![input("a", &ed, None)]);
        let reply = agent
            .handle(&sign_request(ed.public_key(), b"x", 0), &mut Session::default())
            .await;
        assert_eq!(reply, vec![protocol::FAILURE]);
    }

    /// Une clé chiffrée par `ssh-keygen` lui-même (phrase « phrase »).
    #[test]
    fn reads_a_key_encrypted_by_ssh_keygen() {
        let content = include_str!("testdata/ed25519_phrase").to_string();
        let k = load_key(&KeyInput {
            id: "k".into(),
            name: "k".into(),
            content,
            passphrase: Some("phrase".into()),
        });
        assert!(k.is_ok(), "{:?}", k.err());
    }

    #[test]
    fn rsa_signs_with_the_hash_the_client_asks_for_and_never_sha1() {
        // Une clé fixe (`ssh-keygen -t rsa -b 2048`, sans phrase de passe) :
        // en générer une prend des minutes sans optimisations.
        let rsa = PrivateKey::from_openssh(include_str!("testdata/rsa_2048")).unwrap();
        for (flags, alg) in [
            (protocol::RSA_SHA2_512, "rsa-sha2-512"),
            (protocol::RSA_SHA2_256, "rsa-sha2-256"),
        ] {
            let blob = sign(&rsa, b"donnees", flags).unwrap_or_else(|e| panic!("{alg} : {e}"));
            let sig = Signature::try_from(blob.as_slice()).unwrap();
            assert_eq!(sig.algorithm().as_str(), alg);
            assert!(Verifier::verify(rsa.public_key().key_data(), b"donnees", &sig).is_ok());
        }
        assert!(sign(&rsa, b"donnees", 0).is_err());
    }

    /// Le vrai OpenSSH contre l'agent : `ssh-add -L` voit les clés confiées,
    /// `ssh-keygen -Y sign` signe par lui (RSA et Ed25519), et la signature se
    /// vérifie avec `ssh-keygen -Y verify`.
    #[cfg(unix)]
    #[tokio::test]
    async fn openssh_lists_and_signs_through_the_agent() {
        use std::process::Command;
        if Command::new("ssh-keygen").arg("-?").output().is_err() {
            eprintln!("ssh-keygen absent : test ignoré");
            return;
        }
        let dir = std::env::temp_dir().join(format!("guivault-agent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("agent.sock").to_string_lossy().into_owned();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let agent = Arc::new(Agent::new(Box::new(Answer(
            Decision {
                allow: true,
                remember: false,
            },
            asked.clone(),
        ))));
        let ed = random(Algorithm::Ed25519);
        let rsa = PrivateKey::from_openssh(include_str!("testdata/rsa_2048")).unwrap();
        agent.set_keys(vec![input("ed", &ed, Some("phrase")), input("rsa", &rsa, None)]);
        let running = server::start(&socket, agent).await.unwrap();

        let run = |args: &[&str]| {
            let socket = socket.clone();
            let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            async move {
                tokio::task::spawn_blocking(move || {
                    Command::new(&args[0])
                        .args(&args[1..])
                        .env("SSH_AUTH_SOCK", socket)
                        .output()
                        .unwrap()
                })
                .await
                .unwrap()
            }
        };
        let listed = run(&["ssh-add", "-L"]).await;
        let listed = String::from_utf8_lossy(&listed.stdout).into_owned();
        assert!(listed.contains("clé ed") && listed.contains("clé rsa"), "{listed}");

        std::fs::write(dir.join("message"), b"un commit").unwrap();
        for (id, key) in [("ed", &ed), ("rsa", &rsa)] {
            let public = dir.join(format!("{id}.pub"));
            std::fs::write(&public, key.public_key().to_openssh().unwrap()).unwrap();
            let signed = run(&[
                "ssh-keygen",
                "-Y",
                "sign",
                "-n",
                "git",
                "-f",
                &public.to_string_lossy(),
                &dir.join("message").to_string_lossy(),
            ])
            .await;
            assert!(
                signed.status.success(),
                "{id} : {}",
                String::from_utf8_lossy(&signed.stderr)
            );
            let signers = dir.join("allowed");
            std::fs::write(&signers, format!("moi {}\n", key.public_key().to_openssh().unwrap())).unwrap();
            let verify = Command::new("ssh-keygen")
                .args([
                    "-Y",
                    "verify",
                    "-n",
                    "git",
                    "-I",
                    "moi",
                    "-f",
                    &signers.to_string_lossy(),
                    "-s",
                    &dir.join("message.sig").to_string_lossy(),
                ])
                .stdin(std::fs::File::open(dir.join("message")).unwrap())
                .output()
                .unwrap();
            assert!(
                verify.status.success(),
                "{id} : {}",
                String::from_utf8_lossy(&verify.stderr)
            );
            std::fs::remove_file(dir.join("message.sig")).unwrap();
        }
        assert!(lock(&asked).iter().all(|r| r.purpose == UsePurpose::GitSignature));
        assert_eq!(lock(&asked).len(), 2);
        drop(running);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_binding_needs_the_host_signature() {
        let host = random(Algorithm::Ed25519);
        let blob = host.public_key().to_bytes().unwrap();
        let sig = sign(&host, b"session-id", 0).unwrap();
        assert!(verify_binding(&blob, b"session-id", &sig).is_some());
        assert!(verify_binding(&blob, b"autre-session", &sig).is_none());
        let forged = sign(&random(Algorithm::Ed25519), b"session-id", 0).unwrap();
        assert!(verify_binding(&blob, b"session-id", &forged).is_none());
    }
}
