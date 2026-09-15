//! Notifications temps réel : un canal broadcast en mémoire, un flux SSE par
//! client connecté (`GET /events`). Chaque événement porte ses destinataires ;
//! le flux d'un utilisateur ne laisse passer que les siens.
//!
//! En mémoire seulement : un client déconnecté rate les événements émis
//! entre-temps, ce qui est sans conséquence — il resynchronise à la
//! reconnexion de toute façon (`GET /sync` compare les révisions).
use guivault_protocol::ServerEvent;
use sqlx::PgExecutor;
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct Outgoing {
    pub recipients: Vec<Uuid>,
    pub event: ServerEvent,
}

#[derive(Clone)]
pub struct Broadcaster {
    tx: broadcast::Sender<Outgoing>,
}

impl Default for Broadcaster {
    fn default() -> Self {
        Self::new()
    }
}

impl Broadcaster {
    pub fn new() -> Self {
        // Un client lent qui laisse 256 événements s'accumuler perd les plus
        // anciens (`RecvError::Lagged`) — son flux saute, il resynchronise.
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Outgoing> {
        self.tx.subscribe()
    }

    pub fn publish(&self, recipients: Vec<Uuid>, event: ServerEvent) {
        if recipients.is_empty() {
            return;
        }
        // Aucun abonné : `send` échoue, et ce n'est pas une erreur.
        let _ = self.tx.send(Outgoing { recipients, event });
    }

    /// Prévient tous les membres d'un vault.
    pub async fn vault<'e>(&self, db: impl PgExecutor<'e>, vault_id: Uuid, event: ServerEvent) -> sqlx::Result<()> {
        let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM vault_members WHERE vault_id = $1")
            .bind(vault_id)
            .fetch_all(db)
            .await?;
        self.publish(members.into_iter().map(|(u,)| u).collect(), event);
        Ok(())
    }
}
