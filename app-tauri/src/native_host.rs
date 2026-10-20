//! L'hôte natif de l'extension de navigateur (`docs/EXTENSION.md`, « Coffre
//! local ») : l'exécutable de l'application, lancé par le navigateur sans
//! fenêtre, qui sert à l'extension **les mêmes blobs** que l'app sert à son
//! interface (`guivault_local::rpc`) — rien en clair : l'extension déchiffre
//! elle-même, avec le mot de passe maître, comme face à un serveur.
//!
//! Qui peut l'appeler : seule l'extension GuiVault (le navigateur ne lance
//! l'hôte que pour les origines de son manifeste, `browser.rs`). Ce qu'il
//! ouvre : seulement les coffres déjà ouverts dans l'application
//! (`coffres.json`) — une extension compromise ne lui ferait pas sonder un
//! dossier quelconque. Ce qu'un processus local obtiendrait par ce canal, il
//! l'a déjà en lisant le dossier du coffre ; les écritures passent par le
//! verrou de `guivault-local`, comme celles de l'app et de `gv`.
//!
//! Le protocole du navigateur : des messages JSON précédés de leur longueur
//! (u32, ordre de la machine). Un message **vers** le navigateur ne dépasse
//! pas 1 Mo : chaque réponse est découpée en parties `{ id, part, of, data }`
//! (`data` : un morceau du JSON de la réponse), recollées par l'extension.
use guivault_local::LocalVault;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Le nom de l'hôte pour les navigateurs.
pub const HOST_NAME: &str = "dev.guivault.client";
/// L'extension (clé publique de `web/extension/public/manifest.json`).
pub const CHROMIUM_ORIGIN: &str = "chrome-extension://dpfgcnelnadjmggpdchgekenoebmljpc/";
pub const FIREFOX_EXTENSION: &str = "guivault@guiterm.app";
/// Sous la limite de 1 Mo du navigateur, de la marge pour l'enveloppe.
const PART: usize = 700 * 1024;
const MAX_REQUEST: usize = 64 * 1024 * 1024;
const MAX_KNOWN: usize = 20;

/// Lancé par un navigateur ? Chrome passe l'origine de l'extension, Firefox
/// le chemin du manifeste puis l'id de l'extension ; `--native-host` pour
/// les tests.
pub fn invoked(args: &[String]) -> bool {
    args.iter()
        .skip(1)
        .any(|a| a == "--native-host" || a.starts_with("chrome-extension://") || a == FIREFOX_EXTENSION)
}

// ─── Les coffres connus ─────────────────────────────────────────────────────

/// Le dossier de configuration de l'application, le même que Tauri
/// (`app_config_dir`), calculé sans lui : l'hôte ne charge pas Tauri.
pub fn config_dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if let Some(x) = std::env::var_os("XDG_CONFIG_HOME").filter(|x| !x.is_empty()) {
        Some(PathBuf::from(x))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))
    }?;
    Some(base.join(HOST_NAME))
}

fn known_file() -> Option<PathBuf> {
    // `GUIVAULT_CONFIG_DIR` : les tests de bout en bout, sans toucher au
    // profil de la personne qui les lance.
    if let Some(d) = std::env::var_os("GUIVAULT_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d).join("coffres.json"));
    }
    config_dir().map(|d| d.join("coffres.json"))
}

pub fn known_coffres() -> Vec<String> {
    known_file()
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .unwrap_or_default()
}

/// Note un coffre ouvert dans l'application : le plus récent d'abord.
pub fn remember(path: &str) {
    let Some(file) = known_file() else { return };
    let mut list = known_coffres();
    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    list.truncate(MAX_KNOWN);
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&list) {
        let _ = std::fs::write(file, bytes);
    }
}

// ─── Les requêtes ───────────────────────────────────────────────────────────

fn err(status: u16, code: &str, message: impl Into<String>) -> Value {
    json!({ "status": status, "code": code, "message": message.into() })
}

fn local_err(e: guivault_local::Error) -> Value {
    let mut b = e.body();
    b["status"] = e.status.into();
    b
}

/// Un coffre que l'extension peut ouvrir : connu de l'application, et
/// toujours là.
fn allowed(path: &str) -> Result<PathBuf, Value> {
    if !known_coffres().iter().any(|p| p == path) {
        return Err(err(
            403,
            "local_unknown_coffre",
            "ce coffre n'a pas été ouvert dans l'application GuiVault de cet ordinateur",
        ));
    }
    Ok(PathBuf::from(path))
}

/// Une requête : `{ op, path?, args? }`.
pub fn handle(req: &Value) -> Result<Value, Value> {
    let op = req["op"].as_str().unwrap_or_default();
    match op {
        "hello" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        // Les coffres que l'extension peut proposer : ceux de l'application.
        "coffres" => Ok(json!(
            known_coffres()
                .into_iter()
                .filter(|p| Path::new(p).join(guivault_local::FILE_NAME).exists())
                .collect::<Vec<_>>()
        )),
        "open" => {
            let path = allowed(req["path"].as_str().unwrap_or_default())?;
            LocalVault::open(path).map(|_| Value::Null).map_err(local_err)
        }
        "call" => {
            let path = allowed(req["path"].as_str().unwrap_or_default())?;
            let vault = LocalVault::open(path).map_err(local_err)?;
            let inner = req["call"].as_str().unwrap_or_default();
            let args = req.get("args").cloned().unwrap_or(Value::Null);
            guivault_local::rpc::call(&vault, inner, &args).map_err(local_err)
        }
        _ => Err(err(
            501,
            "local_unsupported",
            format!("« {op} » inconnu de l'hôte natif"),
        )),
    }
}

/// La réponse à `id`, en parties de moins de 1 Mo.
pub fn frames(id: &Value, result: Result<Value, Value>) -> Vec<Value> {
    let body = match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    let text = body.to_string();
    let mut parts = Vec::new();
    let mut rest = text.as_str();
    while !rest.is_empty() {
        let mut cut = rest.len().min(PART);
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        let (head, tail) = rest.split_at(cut);
        parts.push(head);
        rest = tail;
    }
    if parts.is_empty() {
        parts.push("");
    }
    let of = parts.len();
    parts
        .into_iter()
        .enumerate()
        .map(|(part, data)| json!({ "id": id, "part": part, "of": of, "data": data }))
        .collect()
}

fn read_message(input: &mut impl Read) -> Option<Value> {
    let mut len = [0u8; 4];
    input.read_exact(&mut len).ok()?;
    let len = u32::from_ne_bytes(len) as usize;
    if len > MAX_REQUEST {
        return None;
    }
    let mut buf = vec![0u8; len];
    input.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn write_message(out: &mut impl Write, msg: &Value) -> std::io::Result<()> {
    let bytes = msg.to_string().into_bytes();
    out.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    out.write_all(&bytes)?;
    out.flush()
}

/// La boucle de l'hôte : jusqu'à ce que le navigateur ferme le canal.
pub fn serve(input: &mut impl Read, out: &mut impl Write) {
    while let Some(req) = read_message(input) {
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        for frame in frames(&id, handle(&req)) {
            if write_message(out, &frame).is_err() {
                return;
            }
        }
    }
}

pub fn run() {
    serve(&mut std::io::stdin().lock(), &mut std::io::stdout().lock());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_browser_launches() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(invoked(&a(&[
            "app",
            "chrome-extension://dpfgcnelnadjmggpdchgekenoebmljpc/",
            "--parent-window=0"
        ])));
        assert!(invoked(&a(&["app", "C:\\manifest.json", "guivault@guiterm.app"])));
        assert!(invoked(&a(&["app", "--native-host"])));
        assert!(!invoked(&a(&["app"])));
        assert!(!invoked(&a(&["app", "--minimized"])));
    }

    #[test]
    fn large_answers_are_split_under_the_browser_limit() {
        let big = "é".repeat(800 * 1024); // 1,6 Mo d'UTF-8
        let frames = frames(&json!(7), Ok(json!(big)));
        assert!(frames.len() >= 3);
        let mut joined = String::new();
        for (i, f) in frames.iter().enumerate() {
            assert_eq!(f["id"], 7);
            assert_eq!(f["part"], i);
            assert_eq!(f["of"], frames.len());
            assert!(
                f.to_string().len() < 1024 * 1024,
                "partie trop grosse pour le navigateur"
            );
            joined.push_str(f["data"].as_str().unwrap());
        }
        let back: Value = serde_json::from_str(&joined).unwrap();
        assert_eq!(back["ok"], true);
        assert_eq!(back["value"].as_str().unwrap().len(), big.len());
    }

    #[test]
    fn the_protocol_round_trips_and_refuses_unknown_coffres() {
        let req = json!({ "id": 1, "op": "hello" });
        let bytes = req.to_string().into_bytes();
        let mut input = (bytes.len() as u32).to_ne_bytes().to_vec();
        input.extend_from_slice(&bytes);
        let refused = json!({ "id": 2, "op": "call", "path": "/nulle/part", "call": "sync" }).to_string();
        input.extend_from_slice(&(refused.len() as u32).to_ne_bytes());
        input.extend_from_slice(refused.as_bytes());
        let mut out = Vec::new();
        serve(&mut input.as_slice(), &mut out);
        let mut rest = out.as_slice();
        let mut replies = Vec::new();
        while rest.len() >= 4 {
            let len = u32::from_ne_bytes(rest[..4].try_into().unwrap()) as usize;
            let frame: Value = serde_json::from_slice(&rest[4..4 + len]).unwrap();
            replies.push(serde_json::from_str::<Value>(frame["data"].as_str().unwrap()).unwrap());
            rest = &rest[4 + len..];
        }
        assert_eq!(replies[0]["ok"], true);
        assert_eq!(replies[1]["error"]["code"], "local_unknown_coffre");
    }
}
