//! `gv` — voir `gv help` et `docs/CLI.md`.
use anyhow::{Context, Result, anyhow, bail};
use guivault_cli::store::Home;
use guivault_cli::vault::{self, Opened};
use guivault_cli::{Prompt, SecretRef};
use std::io::{IsTerminal, Read};
use std::process::ExitCode;

const HELP: &str = "gv — le coffre GuiVault en ligne de commande

  gv login --server <URL> --email <E-MAIL>   se connecter (mot de passe maître, second facteur)
  eval \"$(gv unlock)\"                        déverrouiller dans cette coquille (--raw : la clé seule)
  gv lock                                    fermer la session (GUIVAULT_SESSION ne vaut plus rien)
  gv logout                                  se déconnecter et tout effacer de ce poste
  gv status                                  compte, session, fraîcheur du cache
  gv sync                                    relire le serveur maintenant

  gv list [--vault V] [--type T] [--json]    les éléments
  gv get <réf|élément> [champ] [--vault V] [-n]
                                             un secret sur la sortie (-n : sans retour à la ligne)
  gv run [--env-file F]… -- <commande…>      la commande, avec les variables gv:// remplacées
  gv aws credential-process <accès|réf>      pour `credential_process` dans ~/.aws/config
  gv git-credential get                      credential helper Git
                                             (git config --global credential.helper '!gv git-credential')

Références : gv://<vault>/<élément>[/<champ>] — noms ou ids, %20 pour une espace ;
champ par défaut : le secret (mot de passe, secret d'une clé d'API, clé AWS…).
Champs usuels : password, username, totp, uri, notes ; sinon tout champ de
l'élément (access-key-id, key-id…) ou un champ personnalisé par son nom.

Environnement : GUIVAULT_SESSION (clé de session), GV_HOME (dossier de gv).";

struct Terminal;

impl Prompt for Terminal {
    fn password(&self, prompt: &str) -> Result<String> {
        rpassword::prompt_password(prompt).context("lecture du mot de passe sur le terminal")
    }
    fn code(&self, prompt: &str) -> Result<String> {
        rpassword::prompt_password(prompt).context("lecture du code sur le terminal")
    }
}

/// Les options `--nom valeur` d'une sous-commande, et le reste.
struct Args {
    rest: Vec<String>,
    opts: Vec<(String, String)>,
    flags: Vec<String>,
}

fn parse(args: &[String], with_value: &[&str], flags: &[&str]) -> Result<Args> {
    let mut out = Args {
        rest: vec![],
        opts: vec![],
        flags: vec![],
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--" {
            out.rest.extend(it.by_ref().cloned());
            break;
        }
        if with_value.contains(&a.as_str()) {
            let v = it.next().ok_or_else(|| anyhow!("{a} attend une valeur"))?;
            out.opts.push((a.clone(), v.clone()));
        } else if flags.contains(&a.as_str()) {
            out.flags.push(a.clone());
        } else if a.starts_with('-') && a.len() > 1 {
            bail!("option inconnue : {a} (gv help)");
        } else {
            out.rest.push(a.clone());
        }
    }
    Ok(out)
}

impl Args {
    fn opt(&self, name: &str) -> Option<&str> {
        self.opts.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    fn all(&self, name: &str) -> Vec<&str> {
        self.opts
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect()
    }
    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }
}

fn session_env() -> Option<String> {
    std::env::var("GUIVAULT_SESSION").ok().filter(|s| !s.is_empty())
}

fn device_name() -> String {
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|h| h.trim().to_string())
        })
        .filter(|h| !h.is_empty());
    match host {
        Some(h) => format!("gv (CLI) — {h}"),
        None => "gv (CLI)".into(),
    }
}

/// Les vaults ouverts, cache à jour si possible. Sans session, le mot de
/// passe est demandé si un terminal est là.
fn open(home: &Home) -> Result<Opened> {
    let tty = std::io::stderr().is_terminal();
    let (mut account, unlocked) =
        guivault_cli::unlocked(home, session_env().as_deref(), if tty { Some(&Terminal) } else { None })?;
    let (cache, warning) = guivault_cli::cache(home, &mut account)?;
    if let Some(w) = warning {
        eprintln!("gv : {w}");
    }
    let opened = vault::open(&unlocked, &cache);
    for w in &opened.warnings {
        eprintln!("gv : {w}");
    }
    Ok(opened)
}

fn run() -> Result<ExitCode> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = argv.first() else {
        println!("{HELP}");
        return Ok(ExitCode::SUCCESS);
    };
    let args = &argv[1..];
    let home = Home::default_dir()?;
    match cmd.as_str() {
        "help" | "--help" | "-h" => println!("{HELP}"),
        "--version" | "version" => println!("gv {}", env!("CARGO_PKG_VERSION")),
        "login" => {
            let a = parse(args, &["--server", "--email"], &[])?;
            let prev = home.account()?;
            let server = a
                .opt("--server")
                .map(str::to_string)
                .or_else(|| prev.as_ref().map(|p| p.server.clone()));
            let email = a
                .opt("--email")
                .map(str::to_string)
                .or_else(|| prev.as_ref().map(|p| p.email.clone()));
            let (Some(server), Some(email)) = (server, email) else {
                bail!("gv login --server https://vault.example.com --email vous@example.com");
            };
            let key = guivault_cli::login(&home, &server, &email, &device_name(), &Terminal)?;
            eprintln!("Connecté. Pour cette coquille : eval \"$(gv unlock)\" — ou :");
            println!("export GUIVAULT_SESSION=\"{key}\"");
        }
        "unlock" => {
            let a = parse(args, &[], &["--raw"])?;
            let key = guivault_cli::unlock(&home, &Terminal)?;
            if a.flag("--raw") {
                println!("{key}");
            } else {
                println!("export GUIVAULT_SESSION=\"{key}\"");
            }
        }
        "lock" => {
            home.lock();
            eprintln!("Session fermée.");
        }
        "logout" => {
            guivault_cli::logout(&home)?;
            eprintln!("Déconnecté ; rien ne reste de ce compte sur ce poste.");
        }
        "status" => {
            let Some(account) = home.account()? else {
                println!("Aucun compte (gv login).");
                return Ok(ExitCode::SUCCESS);
            };
            let unlocked = guivault_cli::unlocked(&home, session_env().as_deref(), None).is_ok();
            let cache = home.cache()?;
            println!("Serveur   {}", account.server);
            println!("Compte    {}", account.email);
            println!("Session   {}", if unlocked { "déverrouillée" } else { "verrouillée" });
            match cache.and_then(|c| c.synced_at) {
                Some(at) => println!(
                    "Cache     {}",
                    at.with_timezone(&chrono::Local).format("%d/%m/%Y %H:%M")
                ),
                None => println!("Cache     vide"),
            }
        }
        "sync" => {
            let mut account = home.account()?.ok_or_else(|| anyhow!("aucun compte (gv login)"))?;
            let cache = guivault_cli::sync(&home, &mut account)?;
            let n: usize = cache.items.values().map(|v| v.items.len()).sum();
            eprintln!("{n} élément(s) dans {} vault(s).", cache.vaults.len());
        }
        "list" => {
            let a = parse(args, &["--vault", "--type"], &["--json"])?;
            let opened = open(&home)?;
            let rows: Vec<_> = opened
                .entries
                .iter()
                .filter(|e| e.kind != "group" && e.kind != "icon")
                .filter(|e| a.opt("--type").is_none_or(|t| t == e.kind))
                .filter(|e| {
                    a.opt("--vault").is_none_or(|v| {
                        let ov = &opened.vaults[e.vault];
                        ov.name.eq_ignore_ascii_case(v) || ov.id.to_string() == v
                    })
                })
                .collect();
            if a.flag("--json") {
                let list: Vec<_> = rows
                    .iter()
                    .map(|e| serde_json::json!({ "id": e.id, "name": e.name, "type": e.kind, "vault": opened.vaults[e.vault].name }))
                    .collect();
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else {
                for e in rows {
                    println!("{}\t{}\t{}\t{}", opened.vaults[e.vault].name, e.kind, e.name, e.id);
                }
            }
        }
        "get" => {
            let a = parse(args, &["--vault"], &["-n"])?;
            let r = match a.rest.as_slice() {
                [one] if one.starts_with("gv://") => guivault_cli::parse_ref(one)?,
                [item] => SecretRef {
                    vault: a.opt("--vault").map(str::to_string),
                    item: item.clone(),
                    field: None,
                },
                [item, field] => SecretRef {
                    vault: a.opt("--vault").map(str::to_string),
                    item: item.clone(),
                    field: Some(field.clone()),
                },
                _ => bail!("gv get <gv://vault/élément/champ | élément [champ]>"),
            };
            let value = guivault_cli::resolve(&open(&home)?, &r)?;
            if a.flag("-n") {
                print!("{value}");
            } else {
                println!("{value}");
            }
        }
        "run" => {
            let a = parse(args, &["--env-file"], &[])?;
            let (program, rest) = a
                .rest
                .split_first()
                .ok_or_else(|| anyhow!("gv run [--env-file F] -- <commande…>"))?;
            let mut env: Vec<(String, String)> = std::env::vars().collect();
            for f in a.all("--env-file") {
                let text = std::fs::read_to_string(f).with_context(|| format!("lecture de {f}"))?;
                env.extend(guivault_cli::parse_env_file(&text));
            }
            let mut cmd = std::process::Command::new(program);
            cmd.args(rest);
            for (k, v) in &env {
                cmd.env(k, v);
            }
            if env.iter().any(|(_, v)| v.starts_with("gv://")) {
                for (k, v) in guivault_cli::resolve_env(&open(&home)?, &env)? {
                    cmd.env(k, v);
                }
            }
            let status = cmd.status().with_context(|| format!("lancement de {program}"))?;
            return Ok(ExitCode::from(status.code().unwrap_or(1).clamp(0, 255) as u8));
        }
        "aws" => match args {
            [sub, target] if sub == "credential-process" => {
                println!("{}", guivault_cli::aws_credential_process(&open(&home)?, target)?);
            }
            _ => bail!("gv aws credential-process <accès AWS | gv://…>"),
        },
        "git-credential" => {
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input)?;
            // `store` et `erase` : le coffre s'écrit ailleurs (interface web,
            // Guiterm) ; on laisse Git continuer.
            if args.first().map(String::as_str) == Some("get")
                && let Some(out) = guivault_cli::git_credential(&open(&home)?, &input)
            {
                print!("{out}");
            }
        }
        other => bail!("commande inconnue : {other} (gv help)"),
    }
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(e) => {
            eprintln!("gv : {e:#}");
            ExitCode::from(1)
        }
    }
}
