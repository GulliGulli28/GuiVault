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
use crate::config::MailConfig;
use crate::state::AppState;
use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

/// Au plus tant d'e-mails vers d'autres adresses par compte et par heure :
/// inviter n'importe qui ne doit pas faire du serveur un relais de spam.
pub const HOURLY_BUDGET: u32 = 30;
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Mail {
    pub to: String,
    pub subject: String,
    pub body: String,
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

    fn message(&self, smtp: &Smtp, mail: &Mail) -> anyhow::Result<Message> {
        let footer = match &self.public_url {
            Some(url) => format!("Envoyé par le serveur GuiVault {url}."),
            None => "Envoyé par votre serveur GuiVault.".to_string(),
        };
        let body = format!(
            "{}\n\n—\n{footer}\nCe message ne contient aucun secret : le serveur n'en connaît aucun. \
             GuiVault ne vous demandera jamais votre mot de passe maître.\n",
            mail.body.trim_end()
        );
        Ok(Message::builder()
            .from(smtp.from.clone())
            .to(mail.to.parse()?)
            .subject(&mail.subject)
            .header(ContentType::TEXT_PLAIN)
            .body(body)?)
    }

    /// Envoie en arrière-plan ; ne rend rien, n'échoue jamais pour l'appelant.
    pub fn send(&self, mail: Mail) {
        let Some(smtp) = &self.smtp else { return };
        let message = match self.message(smtp, &mail) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, "e-mail impossible à composer");
                return;
            }
        };
        let transport = smtp.transport.clone();
        let subject = mail.subject;
        tokio::spawn(async move {
            match tokio::time::timeout(SEND_TIMEOUT, transport.send(message)).await {
                Ok(Ok(_)) => tracing::debug!(subject, "e-mail envoyé"),
                Ok(Err(e)) => tracing::warn!(error = %e, subject, "e-mail non envoyé"),
                Err(_) => tracing::warn!(subject, "e-mail non envoyé : délai dépassé"),
            }
        });
    }

    /// Un e-mail qu'un compte fait envoyer à quelqu'un d'autre : dans la
    /// limite de `HOURLY_BUDGET` par heure, au-delà rien (journalisé).
    pub fn send_for(&self, actor: Uuid, mail: Mail) {
        if !self.enabled() {
            return;
        }
        if !take_budget(&mut self.budget.lock().unwrap(), actor, Instant::now()) {
            tracing::warn!(%actor, "e-mails : plafond horaire atteint, message non envoyé");
            return;
        }
        self.send(mail);
    }

    /// Envoi attendu, l'erreur rendue : l'e-mail d'essai de l'administration.
    pub async fn send_now(&self, mail: Mail) -> anyhow::Result<()> {
        let smtp = self
            .smtp
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!(self.error.clone().unwrap_or_else(|| "pas de GUIVAULT_SMTP_URL".into())))?;
        let message = self.message(smtp, &mail)?;
        tokio::time::timeout(SEND_TIMEOUT, smtp.transport.send(message))
            .await
            .map_err(|_| anyhow::anyhow!("délai dépassé"))??;
        Ok(())
    }

    /// « Ouvrez GuiVault » — avec l'adresse du serveur quand on la connaît.
    pub fn where_to(&self) -> String {
        match &self.public_url {
            Some(url) => format!("GuiVault ({url}, Guiterm ou l'extension)"),
            None => "GuiVault (l'interface web, Guiterm ou l'extension)".into(),
        }
    }
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

fn when(at: chrono::DateTime<chrono::Utc>) -> String {
    at.format("%d/%m/%Y à %H:%M UTC").to_string()
}

// ─── Les messages ───────────────────────────────────────────────────────────

/// Une invitation dans un vault partagé. `registered` : l'invité a déjà un
/// compte sur ce serveur.
pub fn invitation(
    state: &AppState,
    inviter: (Uuid, &str),
    invitee: &str,
    role: &str,
    registered: bool,
    expires_at: chrono::DateTime<chrono::Utc>,
) {
    let m = &state.mail;
    let (actor, inviter_email) = inviter;
    let next = if registered {
        format!("Ouvrez {} : l'invitation vous y attend.", m.where_to())
    } else {
        format!(
            "Vous n'avez pas encore de compte sur ce serveur : créez-le avec cette adresse depuis {} — l'invitation vous y attendra.",
            m.where_to()
        )
    };
    m.send_for(
        actor,
        Mail {
            to: invitee.into(),
            subject: format!("{inviter_email} vous invite dans un vault GuiVault"),
            body: format!(
                "{inviter_email} vous invite à rejoindre un vault partagé, avec le rôle « {role} ».\n\n{next}\n\n\
                 Avant d'accepter, comparez l'empreinte de {inviter_email} affichée dans l'invitation avec celle qu'il ou elle vous \
                 donne de vive voix : c'est ce qui garantit que personne ne s'est glissé entre vous.\n\n\
                 L'invitation expire le {}.",
                when(expires_at)
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
    m.send_for(
        admin.0,
        Mail {
            to: email.into(),
            subject: "Votre compte GuiVault vous attend".into(),
            body: format!(
                "{} vous a ouvert l'inscription sur ce serveur GuiVault.\n\nCréez votre compte avec cette adresse depuis {}, \
                 avant le {}. Choisissez un mot de passe maître que vous n'utilisez nulle part ailleurs : \
                 personne — pas même l'administrateur — ne pourra le réinitialiser.",
                admin.1,
                m.where_to(),
                when(expires_at)
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
    let mut details = format!("Le {}, depuis l'adresse {ip}", when(chrono::Utc::now()));
    if let Some(d) = device {
        details.push_str(&format!(", appareil « {d} »"));
    }
    if let Some(ua) = user_agent {
        details.push_str(&format!(" ({ua})"));
    }
    m.send(Mail {
        to: email.into(),
        subject: "Nouvelle connexion à votre compte GuiVault".into(),
        body: format!(
            "Quelqu'un vient de se connecter à votre compte avec votre mot de passe maître.\n\n{details}.\n\n\
             Si c'est vous, rien à faire. Sinon : changez votre mot de passe maître tout de suite, révoquez cette \
             session (Paramètres › Sessions) et activez le second facteur si ce n'est pas déjà fait."
        ),
    });
}

/// Les mots de l'interface, comme dans Guiterm.
pub fn role_label(role: guivault_protocol::Role) -> &'static str {
    use guivault_protocol::Role;
    match role {
        Role::Reader => "lecteur",
        Role::Writer => "éditeur",
        Role::Admin => "admin",
        Role::Owner => "propriétaire",
    }
}

/// Un avis à son titulaire (compte désactivé, supprimé).
pub fn notice(state: &AppState, email: &str, subject: &str, what: &str) {
    state.mail.send(Mail {
        to: email.into(),
        subject: subject.into(),
        body: what.into(),
    });
}

/// Une alerte de sécurité à son titulaire (mot de passe, second facteur).
pub fn security(state: &AppState, email: &str, subject: &str, what: &str) {
    state.mail.send(Mail {
        to: email.into(),
        subject: subject.into(),
        body: format!(
            "{what}\n\nSi ce n'est pas vous : quelqu'un a votre mot de passe maître. Changez-le depuis un appareil \
             de confiance et révoquez les sessions que vous ne reconnaissez pas (Paramètres › Sessions)."
        ),
    });
}

/// Les étapes d'un accès d'urgence, à l'autre partie.
pub fn emergency(state: &AppState, action: &str, g: &guivault_protocol::EmergencyGrant) {
    let m = &state.mail;
    let (grantor, grantee) = (&g.grantor.email, &g.grantee.email);
    let (to, subject, body) = match action {
        "emergency.create" => (
            grantee,
            format!("{grantor} vous désigne comme contact d'urgence"),
            format!(
                "{grantor} vous a désigné comme contact d'urgence sur GuiVault : en cas de besoin, vous pourrez demander \
                 l'accès à une partie de son coffre, qui vous sera ouvert {} jour(s) plus tard sauf refus de sa part.\n\n\
                 Pour accepter : {}, Paramètres › Accès d'urgence.",
                g.wait_days,
                m.where_to()
            ),
        ),
        "emergency.accept" => (
            grantor,
            format!("{grantee} a accepté d'être votre contact d'urgence"),
            format!(
                "{grantee} a accepté d'être votre contact d'urgence (délai : {} jour(s)).",
                g.wait_days
            ),
        ),
        "emergency.request" => (
            grantor,
            format!("{grantee} demande l'accès d'urgence à votre coffre"),
            format!(
                "{grantee} vient de demander l'accès d'urgence à votre coffre.\n\n{}\n\n\
                 Si vous n'êtes pas d'accord, refusez depuis {}, Paramètres › Accès d'urgence — ou accordez-le tout de suite.",
                match g.access_at {
                    Some(at) => format!("Sans refus de votre part, il lui sera ouvert le {}.", when(at)),
                    None => format!(
                        "Sans refus de votre part, il lui sera ouvert dans {} jour(s).",
                        g.wait_days
                    ),
                },
                m.where_to()
            ),
        ),
        "emergency.approve" => (
            grantee,
            format!("{grantor} vous a ouvert l'accès d'urgence"),
            format!(
                "{grantor} vous a ouvert l'accès d'urgence sans attendre la fin du délai. Les vaults confiés sont dans {}, \
                 Paramètres › Accès d'urgence.",
                m.where_to()
            ),
        ),
        "emergency.opened" => {
            // Aux deux : le contact peut entrer, le donneur doit le savoir.
            m.send(Mail {
                to: grantor.clone(),
                subject: format!("{grantee} a maintenant accès à votre coffre (accès d'urgence)"),
                body: format!(
                    "Le délai de {} jour(s) s'est écoulé sans refus : {grantee} peut maintenant lire les vaults que vous lui \
                     avez confiés. Pour refermer l'accès : {}, Paramètres › Accès d'urgence.",
                    g.wait_days,
                    m.where_to()
                ),
            });
            (
                grantee,
                format!("L'accès d'urgence au coffre de {grantor} vous est ouvert"),
                format!(
                    "Le délai s'est écoulé sans refus de {grantor} : les vaults qu'il ou elle vous a confiés sont dans {}, \
                     Paramètres › Accès d'urgence.",
                    m.where_to()
                ),
            )
        }
        "emergency.reject" => (
            grantee,
            format!("{grantor} a refusé votre demande d'accès d'urgence"),
            format!("{grantor} a refusé (ou refermé) votre accès d'urgence. Vous restez son contact d'urgence."),
        ),
        "emergency.cancel" => (
            grantor,
            format!("{grantee} a retiré sa demande d'accès d'urgence"),
            format!("{grantee} a retiré sa demande d'accès d'urgence à votre coffre. Rien n'a été ouvert de plus."),
        ),
        _ => return,
    };
    m.send(Mail {
        to: to.clone(),
        subject,
        body,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
