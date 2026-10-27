//! E-mails, facultatifs (`GUIVAULT_SMTP_URL`). **Rien n'en dépend** : sans
//! SMTP, avec un SMTP mal réglé ou injoignable, l'action qui aurait envoyé un
//! message réussit quand même — tout ce qu'il dirait est déjà visible dans
//! les clients (invitations, demandes d'accès d'urgence, sessions). L'envoi
//! part en arrière-plan après la transaction, avec un délai borné ; un échec
//! est journalisé, jamais renvoyé.
//!
//! Un message ne contient aucun secret (le serveur n'en a pas), jamais le nom
//! d'un vault (chiffré), et pas d'autre lien que l'adresse publique du
//! serveur (`GUIVAULT_PUBLIC_URL`) — rien qui ressemble à un lien de
//! connexion qu'un hameçonneur pourrait imiter.
//!
//! Chaque message est écrit dans les deux langues de l'interface (`Text`) :
//! le destinataire reçoit la sienne (`users.language`, réglée par
//! l'interface), les deux s'il n'a pas de compte ou ne l'a jamais dite.
use crate::config::MailConfig;
use crate::state::AppState;
use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use sqlx::PgPool;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Au plus tant d'e-mails vers d'autres adresses par compte et par heure :
/// inviter n'importe qui ne doit pas faire du serveur un relais de spam.
pub const HOURLY_BUDGET: u32 = 30;
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// La langue d'un destinataire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Fr,
    En,
    /// Inconnue : les deux, le français d'abord.
    Both,
}

impl Lang {
    pub fn parse(v: Option<&str>) -> Lang {
        match v {
            Some("fr") => Lang::Fr,
            Some("en") => Lang::En,
            _ => Lang::Both,
        }
    }
}

/// Un texte dans les deux langues de l'interface.
#[derive(Clone, Debug)]
pub struct Text {
    pub fr: String,
    pub en: String,
}

pub fn text(fr: impl Into<String>, en: impl Into<String>) -> Text {
    Text {
        fr: fr.into(),
        en: en.into(),
    }
}

impl Text {
    fn render(&self, lang: Lang, sep: &str) -> String {
        match lang {
            Lang::Fr => self.fr.clone(),
            Lang::En => self.en.clone(),
            Lang::Both => format!("{}{sep}{}", self.fr, self.en),
        }
    }
}

pub struct Mail {
    pub to: String,
    pub subject: Text,
    pub body: Text,
}

/// La langue du compte à cette adresse ; `Both` s'il n'y en a pas.
async fn lang_of(db: &PgPool, email: &str) -> Lang {
    let v: Option<Option<String>> = sqlx::query_scalar("SELECT language FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(db)
        .await
        .unwrap_or(None);
    Lang::parse(v.flatten().as_deref())
}

struct Smtp {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

pub struct Mailer {
    smtp: Option<Smtp>,
    /// Pourquoi il n'y a pas d'e-mails alors qu'on en a demandé.
    error: Option<String>,
    public_url: Option<String>,
    budget: Mutex<HashMap<Uuid, (Instant, u32)>>,
}

impl Mailer {
    /// Jamais d'erreur : une configuration illisible est journalisée et
    /// laisse le serveur sans e-mails, pas sans serveur.
    pub fn new(cfg: Option<&MailConfig>) -> Self {
        let mut mailer = Mailer {
            smtp: None,
            error: None,
            public_url: cfg.and_then(|c| c.public_url.clone()),
            budget: Mutex::new(HashMap::new()),
        };
        let Some(cfg) = cfg else { return mailer };
        let built = (|| -> anyhow::Result<Smtp> {
            anyhow::ensure!(
                !cfg.from.is_empty(),
                "GUIVAULT_SMTP_FROM manquant (ex. « GuiVault <coffre@exemple.fr> »)"
            );
            let from: Mailbox = cfg
                .from
                .parse()
                .map_err(|e| anyhow::anyhow!("GUIVAULT_SMTP_FROM « {} » illisible : {e}", cfg.from))?;
            let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(&cfg.smtp_url)
                .map_err(|e| anyhow::anyhow!("GUIVAULT_SMTP_URL illisible : {e}"))?
                .timeout(Some(Duration::from_secs(20)))
                .build();
            Ok(Smtp { transport, from })
        })();
        match built {
            Ok(smtp) => mailer.smtp = Some(smtp),
            Err(e) => {
                tracing::error!(error = %e, "e-mails désactivés");
                mailer.error = Some(e.to_string());
            }
        }
        mailer
    }

    pub fn enabled(&self) -> bool {
        self.smtp.is_some()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn from_address(&self) -> Option<String> {
        self.smtp.as_ref().map(|s| s.from.to_string())
    }

    fn message(&self, smtp: &Smtp, mail: &Mail, lang: Lang) -> anyhow::Result<Message> {
        compose(&smtp.from, self.public_url.as_deref(), mail, lang)
    }

    /// Envoie en arrière-plan, dans la langue du destinataire ; ne rend
    /// rien, n'échoue jamais pour l'appelant.
    pub fn send(&self, db: &PgPool, mail: Mail) {
        let Some(smtp) = &self.smtp else { return };
        let transport = smtp.transport.clone();
        let from = smtp.from.clone();
        let public_url = self.public_url.clone();
        let db = db.clone();
        tokio::spawn(async move {
            let lang = lang_of(&db, &mail.to).await;
            let message = match compose(&from, public_url.as_deref(), &mail, lang) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "e-mail impossible à composer");
                    return;
                }
            };
            let subject = mail.subject.fr;
            match tokio::time::timeout(SEND_TIMEOUT, transport.send(message)).await {
                Ok(Ok(_)) => tracing::debug!(subject, "e-mail envoyé"),
                Ok(Err(e)) => tracing::warn!(error = %e, subject, "e-mail non envoyé"),
                Err(_) => tracing::warn!(subject, "e-mail non envoyé : délai dépassé"),
            }
        });
    }

    /// Un e-mail qu'un compte fait envoyer à quelqu'un d'autre : dans la
    /// limite de `HOURLY_BUDGET` par heure, au-delà rien (journalisé).
    pub fn send_for(&self, db: &PgPool, actor: Uuid, mail: Mail) {
        if !self.enabled() {
            return;
        }
        if !take_budget(&mut self.budget.lock().unwrap(), actor, Instant::now()) {
            tracing::warn!(%actor, "e-mails : plafond horaire atteint, message non envoyé");
            return;
        }
        self.send(db, mail);
    }

    /// Envoi attendu, l'erreur rendue : l'e-mail d'essai de l'administration.
    pub async fn send_now(&self, db: &PgPool, mail: Mail) -> anyhow::Result<()> {
        let smtp = self
            .smtp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!(self.error.clone().unwrap_or_else(|| "pas de GUIVAULT_SMTP_URL".into())))?;
        let lang = lang_of(db, &mail.to).await;
        let message = self.message(smtp, &mail, lang)?;
        tokio::time::timeout(SEND_TIMEOUT, smtp.transport.send(message))
            .await
            .map_err(|_| anyhow::anyhow!("délai dépassé"))??;
        Ok(())
    }

    /// « Ouvrez GuiVault » — avec l'adresse du serveur quand on la connaît.
    pub fn where_to(&self) -> Text {
        match &self.public_url {
            Some(url) => text(
                format!("GuiVault ({url}, Guiterm ou l'extension)"),
                format!("GuiVault ({url}, Guiterm or the extension)"),
            ),
            None => text(
                "GuiVault (l'interface web, Guiterm ou l'extension)",
                "GuiVault (the web interface, Guiterm or the extension)",
            ),
        }
    }
}

/// Le message tel qu'il part, dans `lang`.
fn compose(from: &Mailbox, public_url: Option<&str>, mail: &Mail, lang: Lang) -> anyhow::Result<Message> {
    let footer = match public_url {
        Some(url) => text(
            format!("Envoyé par le serveur GuiVault {url}."),
            format!("Sent by the GuiVault server {url}."),
        ),
        None => text("Envoyé par votre serveur GuiVault.", "Sent by your GuiVault server."),
    };
    let note = text(
        "Ce message ne contient aucun secret : le serveur n'en connaît aucun. GuiVault ne vous demandera jamais \
         votre mot de passe maître.",
        "This message contains no secret: the server knows none. GuiVault will never ask for your master password.",
    );
    let full = text(
        format!("{}\n\n—\n{}\n{}\n", mail.body.fr.trim_end(), footer.fr, note.fr),
        format!("{}\n\n—\n{}\n{}\n", mail.body.en.trim_end(), footer.en, note.en),
    );
    Ok(Message::builder()
        .from(from.clone())
        .to(mail.to.parse()?)
        .subject(mail.subject.render(lang, " · "))
        .header(ContentType::TEXT_PLAIN)
        .body(full.render(lang, "\n\n━━━━━━━━━━━━━━━━━━━━ English ━━━━━━━━━━━━━━━━━━━━\n\n"))?)
}

/// Fenêtre glissante d'une heure par compte.
fn take_budget(budget: &mut HashMap<Uuid, (Instant, u32)>, actor: Uuid, now: Instant) -> bool {
    budget.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(3600));
    let entry = budget.entry(actor).or_insert((now, 0));
    if entry.1 >= HOURLY_BUDGET {
        return false;
    }
    entry.1 += 1;
    true
}

fn when(at: chrono::DateTime<chrono::Utc>) -> Text {
    text(
        at.format("%d/%m/%Y à %H:%M UTC").to_string(),
        at.format("%Y-%m-%d at %H:%M UTC").to_string(),
    )
}

/// Un nombre de jours, accordé.
fn days(n: u32) -> Text {
    text(
        if n > 1 {
            format!("{n} jours")
        } else {
            format!("{n} jour")
        },
        if n == 1 {
            format!("{n} day")
        } else {
            format!("{n} days")
        },
    )
}

// ─── Les messages ───────────────────────────────────────────────────────────

/// Une invitation dans un vault partagé. `registered` : l'invité a déjà un
/// compte sur ce serveur.
pub fn invitation(
    state: &AppState,
    inviter: (Uuid, &str),
    invitee: &str,
    role: guivault_protocol::Role,
    registered: bool,
    expires_at: chrono::DateTime<chrono::Utc>,
) {
    let m = &state.mail;
    let (actor, inviter_email) = inviter;
    let (w, until, role) = (m.where_to(), when(expires_at), role_label(role));
    let next = if registered {
        text(
            format!("Ouvrez {} : l'invitation vous y attend.", w.fr),
            format!("Open {}: the invitation is waiting for you there.", w.en),
        )
    } else {
        text(
            format!(
                "Vous n'avez pas encore de compte sur ce serveur : créez-le avec cette adresse depuis {} — l'invitation vous y attendra.",
                w.fr
            ),
            format!(
                "You don't have an account on this server yet: create it with this address from {} — the invitation will be waiting for you.",
                w.en
            ),
        )
    };
    m.send_for(
        &state.db,
        actor,
        Mail {
            to: invitee.into(),
            subject: text(
                format!("{inviter_email} vous invite dans un vault GuiVault"),
                format!("{inviter_email} invites you to a GuiVault vault"),
            ),
            body: text(
                format!(
                    "{inviter_email} vous invite à rejoindre un vault partagé, avec le rôle « {} ».\n\n{}\n\n\
                     Avant d'accepter, comparez l'empreinte de {inviter_email} affichée dans l'invitation avec celle qu'il ou elle vous \
                     donne de vive voix : c'est ce qui garantit que personne ne s'est glissé entre vous.\n\n\
                     L'invitation expire le {}.",
                    role.fr, next.fr, until.fr
                ),
                format!(
                    "{inviter_email} invites you to join a shared vault, with the “{}” role.\n\n{}\n\n\
                     Before accepting, compare {inviter_email}'s fingerprint shown in the invitation with the one they give \
                     you in person: that's what guarantees nobody slipped in between you.\n\n\
                     The invitation expires on {}.",
                    role.en, next.en, until.en
                ),
            ),
        },
    );
}

/// Un administrateur a ouvert l'inscription à cette adresse.
pub fn registration_opened(
    state: &AppState,
    admin: (Uuid, &str),
    email: &str,
    expires_at: chrono::DateTime<chrono::Utc>,
) {
    let m = &state.mail;
    let (w, until) = (m.where_to(), when(expires_at));
    m.send_for(
        &state.db,
        admin.0,
        Mail {
            to: email.into(),
            subject: text("Votre compte GuiVault vous attend", "Your GuiVault account is waiting for you"),
            body: text(
                format!(
                    "{} vous a ouvert l'inscription sur ce serveur GuiVault.\n\nCréez votre compte avec cette adresse depuis {}, \
                     avant le {}. Choisissez un mot de passe maître que vous n'utilisez nulle part ailleurs : \
                     personne — pas même l'administrateur — ne pourra le réinitialiser.",
                    admin.1, w.fr, until.fr
                ),
                format!(
                    "{} opened sign-up for you on this GuiVault server.\n\nCreate your account with this address from {}, \
                     before {}. Choose a master password you don't use anywhere else: nobody — not even the \
                     administrator — will be able to reset it.",
                    admin.1, w.en, until.en
                ),
            ),
        },
    );
}

/// Une connexion depuis une adresse jamais vue pour ce compte (90 jours) :
/// on le dit à son titulaire.
pub async fn login_alert(
    state: &AppState,
    user_id: Uuid,
    email: &str,
    ip: Option<IpAddr>,
    device: Option<&str>,
    user_agent: Option<&str>,
) {
    let m = &state.mail;
    let Some(ip) = ip else { return };
    if !m.enabled() {
        return;
    }
    // La connexion en cours a déjà sa ligne : « déjà vue » = au moins deux.
    let seen: sqlx::Result<i64> = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log
         WHERE actor_id = $1 AND action IN ('user.login', 'user.register') AND ip = $2
           AND at > now() - interval '90 days'",
    )
    .bind(user_id)
    .bind(ipnet::IpNet::from(ip))
    .fetch_one(&state.db)
    .await;
    match seen {
        Ok(n) if n <= 1 => {}
        Ok(_) => return,
        Err(e) => {
            tracing::warn!(error = %e, "alerte de connexion : historique illisible");
            return;
        }
    }
    let now = when(chrono::Utc::now());
    let mut details = text(
        format!("Le {}, depuis l'adresse {ip}", now.fr),
        format!("On {}, from the address {ip}", now.en),
    );
    if let Some(d) = device {
        details.fr.push_str(&format!(", appareil « {d} »"));
        details.en.push_str(&format!(", device “{d}”"));
    }
    if let Some(ua) = user_agent {
        details.fr.push_str(&format!(" ({ua})"));
        details.en.push_str(&format!(" ({ua})"));
    }
    m.send(
        &state.db,
        Mail {
            to: email.into(),
            subject: text("Nouvelle connexion à votre compte GuiVault", "New sign-in to your GuiVault account"),
            body: text(
                format!(
                    "Quelqu'un vient de se connecter à votre compte avec votre mot de passe maître.\n\n{}.\n\n\
                     Si c'est vous, rien à faire. Sinon : changez votre mot de passe maître tout de suite, révoquez cette \
                     session (Paramètres › Sessions) et activez le second facteur si ce n'est pas déjà fait.",
                    details.fr
                ),
                format!(
                    "Someone just signed in to your account with your master password.\n\n{}.\n\n\
                     If it was you, nothing to do. Otherwise: change your master password right away, revoke this \
                     session (Settings › Sessions) and turn on the second factor if it isn't already.",
                    details.en
                ),
            ),
        },
    );
}

/// Les mots de l'interface, comme dans Guiterm.
pub fn role_label(role: guivault_protocol::Role) -> Text {
    use guivault_protocol::Role;
    match role {
        Role::Reader => text("lecteur", "reader"),
        Role::Writer => text("éditeur", "editor"),
        Role::Admin => text("admin", "admin"),
        Role::Owner => text("propriétaire", "owner"),
    }
}

/// Un avis à son titulaire (compte désactivé, supprimé).
pub fn notice(state: &AppState, email: &str, subject: Text, what: Text) {
    state.mail.send(
        &state.db,
        Mail {
            to: email.into(),
            subject,
            body: what,
        },
    );
}

/// Une alerte de sécurité à son titulaire (mot de passe, second facteur).
pub fn security(state: &AppState, email: &str, subject: Text, what: Text) {
    state.mail.send(
        &state.db,
        Mail {
            to: email.into(),
            subject,
            body: text(
                format!(
                    "{}\n\nSi ce n'est pas vous : quelqu'un a votre mot de passe maître. Changez-le depuis un appareil \
                     de confiance et révoquez les sessions que vous ne reconnaissez pas (Paramètres › Sessions).",
                    what.fr
                ),
                format!(
                    "{}\n\nIf it wasn't you: someone has your master password. Change it from a trusted device and \
                     revoke the sessions you don't recognize (Settings › Sessions).",
                    what.en
                ),
            ),
        },
    );
}

/// Les étapes d'un accès d'urgence, à l'autre partie.
pub fn emergency(state: &AppState, action: &str, g: &guivault_protocol::EmergencyGrant) {
    let m = &state.mail;
    let (grantor, grantee) = (&g.grantor.email, &g.grantee.email);
    let (w, wait) = (m.where_to(), days(g.wait_days));
    let (to, subject, body) = match action {
        "emergency.create" => (
            grantee,
            text(
                format!("{grantor} vous désigne comme contact d'urgence"),
                format!("{grantor} designates you as emergency contact"),
            ),
            text(
                format!(
                    "{grantor} vous a désigné comme contact d'urgence sur GuiVault : en cas de besoin, vous pourrez demander \
                     l'accès à une partie de son coffre, qui vous sera ouvert {} plus tard sauf refus de sa part.\n\n\
                     Pour accepter : {}, Paramètres › Accès d'urgence.",
                    wait.fr, w.fr
                ),
                format!(
                    "{grantor} designated you as emergency contact on GuiVault: if needed, you'll be able to request \
                     access to part of their vault, opened to you {} later unless they refuse.\n\n\
                     To accept: {}, Settings › Emergency access.",
                    wait.en, w.en
                ),
            ),
        ),
        "emergency.accept" => (
            grantor,
            text(
                format!("{grantee} a accepté d'être votre contact d'urgence"),
                format!("{grantee} accepted to be your emergency contact"),
            ),
            text(
                format!(
                    "{grantee} a accepté d'être votre contact d'urgence (délai : {}).",
                    wait.fr
                ),
                format!(
                    "{grantee} accepted to be your emergency contact (waiting period: {}).",
                    wait.en
                ),
            ),
        ),
        "emergency.request" => {
            let open = match g.access_at {
                Some(at) => {
                    let at = when(at);
                    text(
                        format!("Sans refus de votre part, il lui sera ouvert le {}.", at.fr),
                        format!("Unless you refuse, it will open to them on {}.", at.en),
                    )
                }
                None => text(
                    format!("Sans refus de votre part, il lui sera ouvert dans {}.", wait.fr),
                    format!("Unless you refuse, it will open to them in {}.", wait.en),
                ),
            };
            (
                grantor,
                text(
                    format!("{grantee} demande l'accès d'urgence à votre coffre"),
                    format!("{grantee} requests emergency access to your vault"),
                ),
                text(
                    format!(
                        "{grantee} vient de demander l'accès d'urgence à votre coffre.\n\n{}\n\n\
                         Si vous n'êtes pas d'accord, refusez depuis {}, Paramètres › Accès d'urgence — ou accordez-le tout de suite.",
                        open.fr, w.fr
                    ),
                    format!(
                        "{grantee} just requested emergency access to your vault.\n\n{}\n\n\
                         If you don't agree, refuse from {}, Settings › Emergency access — or grant it right away.",
                        open.en, w.en
                    ),
                ),
            )
        }
        "emergency.approve" => (
            grantee,
            text(
                format!("{grantor} vous a ouvert l'accès d'urgence"),
                format!("{grantor} opened emergency access for you"),
            ),
            text(
                format!(
                    "{grantor} vous a ouvert l'accès d'urgence sans attendre la fin du délai. Les vaults confiés sont dans {}, \
                     Paramètres › Accès d'urgence.",
                    w.fr
                ),
                format!(
                    "{grantor} opened emergency access for you without waiting for the end of the waiting period. The \
                     entrusted vaults are in {}, Settings › Emergency access.",
                    w.en
                ),
            ),
        ),
        "emergency.opened" => {
            // Aux deux : le contact peut entrer, le donneur doit le savoir.
            m.send(
                &state.db,
                Mail {
                    to: grantor.clone(),
                    subject: text(
                        format!("{grantee} a maintenant accès à votre coffre (accès d'urgence)"),
                        format!("{grantee} now has access to your vault (emergency access)"),
                    ),
                    body: text(
                        format!(
                            "Le délai de {} s'est écoulé sans refus : {grantee} peut maintenant lire les vaults que vous lui \
                             avez confiés. Pour refermer l'accès : {}, Paramètres › Accès d'urgence.",
                            wait.fr, w.fr
                        ),
                        format!(
                            "The {} waiting period ended without a refusal: {grantee} can now read the vaults you \
                             entrusted to them. To close the access: {}, Settings › Emergency access.",
                            wait.en, w.en
                        ),
                    ),
                },
            );
            (
                grantee,
                text(
                    format!("L'accès d'urgence au coffre de {grantor} vous est ouvert"),
                    format!("Emergency access to {grantor}'s vault is open to you"),
                ),
                text(
                    format!(
                        "Le délai s'est écoulé sans refus de {grantor} : les vaults qu'il ou elle vous a confiés sont dans {}, \
                         Paramètres › Accès d'urgence.",
                        w.fr
                    ),
                    format!(
                        "The waiting period ended without a refusal from {grantor}: the vaults they entrusted to you are \
                         in {}, Settings › Emergency access.",
                        w.en
                    ),
                ),
            )
        }
        "emergency.reject" => (
            grantee,
            text(
                format!("{grantor} a refusé votre demande d'accès d'urgence"),
                format!("{grantor} refused your emergency access request"),
            ),
            text(
                format!("{grantor} a refusé (ou refermé) votre accès d'urgence. Vous restez son contact d'urgence."),
                format!("{grantor} refused (or closed) your emergency access. You remain their emergency contact."),
            ),
        ),
        "emergency.cancel" => (
            grantor,
            text(
                format!("{grantee} a retiré sa demande d'accès d'urgence"),
                format!("{grantee} withdrew their emergency access request"),
            ),
            text(
                format!("{grantee} a retiré sa demande d'accès d'urgence à votre coffre. Rien n'a été ouvert de plus."),
                format!("{grantee} withdrew their emergency access request to your vault. Nothing more was opened."),
            ),
        ),
        _ => return,
    };
    m.send(
        &state.db,
        Mail {
            to: to.clone(),
            subject,
            body,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered(lang: Lang, public_url: Option<&str>) -> String {
        let from: Mailbox = "GuiVault <vault@example.com>".parse().unwrap();
        let mail = Mail {
            to: "alice@example.com".into(),
            subject: text("Bonjour", "Hello"),
            body: text("Le corps.", "The body."),
        };
        String::from_utf8(compose(&from, public_url, &mail, lang).unwrap().formatted()).unwrap()
    }

    #[test]
    fn each_recipient_gets_their_language_or_both() {
        let fr = rendered(Lang::Fr, Some("https://coffre.example"));
        assert!(fr.contains("Subject: Bonjour") && fr.contains("Le corps."));
        assert!(!fr.contains("The body.") && !fr.contains("Hello"));
        let en = rendered(Lang::En, None);
        assert!(
            en.contains("Subject: Hello") && en.contains("The body.") && en.contains("Sent by your GuiVault server.")
        );
        assert!(!en.contains("Le corps."));
        let both = rendered(Lang::Both, None);
        assert!(both.contains("The body.") && both.contains("Le corps."));
        assert!(both.find("Le corps.") < both.find("The body."), "le français d'abord");
        assert_eq!(Lang::parse(Some("en")), Lang::En);
        assert_eq!(Lang::parse(None), Lang::Both);
    }

    #[test]
    fn hourly_budget_per_account() {
        let mut b = HashMap::new();
        let (a, other) = (Uuid::new_v4(), Uuid::new_v4());
        let t0 = Instant::now();
        for _ in 0..HOURLY_BUDGET {
            assert!(take_budget(&mut b, a, t0));
        }
        assert!(!take_budget(&mut b, a, t0), "plafond atteint");
        assert!(take_budget(&mut b, other, t0), "par compte");
        assert!(
            take_budget(&mut b, a, t0 + Duration::from_secs(3601)),
            "une heure plus tard"
        );
    }

    #[test]
    fn bad_config_disables_mail_without_failing() {
        let m = Mailer::new(Some(&MailConfig {
            smtp_url: "pas une url".into(),
            from: "GuiVault <vault@example.com>".into(),
            public_url: None,
        }));
        assert!(!m.enabled());
        assert!(m.error().unwrap().contains("GUIVAULT_SMTP_URL"));
        let m = Mailer::new(Some(&MailConfig {
            smtp_url: "smtp://127.0.0.1:2525".into(),
            from: "pas une adresse".into(),
            public_url: None,
        }));
        assert!(!m.enabled() && m.error().unwrap().contains("GUIVAULT_SMTP_FROM"));
        assert!(!Mailer::new(None).enabled() && Mailer::new(None).error().is_none());
    }
}
