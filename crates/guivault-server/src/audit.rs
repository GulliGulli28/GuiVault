//! Journal d'audit en ajout seul. Une ligne par action sensible ; jamais de
//! secret dedans (il n'y en a aucun côté serveur), mais des identifiants.
use sqlx::PgExecutor;
use std::net::IpAddr;
use uuid::Uuid;

pub struct Audit<'a> {
    pub actor: Option<Uuid>,
    pub vault: Option<Uuid>,
    pub action: &'a str,
    pub target: Option<String>,
    pub ip: Option<IpAddr>,
    pub metadata: Option<serde_json::Value>,
}

impl<'a> Audit<'a> {
    pub fn new(action: &'a str) -> Self {
        Self {
            actor: None,
            vault: None,
            action,
            target: None,
            ip: None,
            metadata: None,
        }
    }

    pub fn actor(mut self, id: Uuid) -> Self {
        self.actor = Some(id);
        self
    }

    pub fn vault(mut self, id: Uuid) -> Self {
        self.vault = Some(id);
        self
    }

    pub fn target(mut self, t: impl ToString) -> Self {
        self.target = Some(t.to_string());
        self
    }

    pub fn ip(mut self, ip: Option<IpAddr>) -> Self {
        self.ip = ip;
        self
    }

    pub fn meta(mut self, v: serde_json::Value) -> Self {
        self.metadata = Some(v);
        self
    }

    pub async fn write<'e, E: PgExecutor<'e>>(self, db: E) -> sqlx::Result<()> {
        sqlx::query(
            "INSERT INTO audit_log (actor_id, vault_id, action, target, ip, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(self.actor)
        .bind(self.vault)
        .bind(self.action)
        .bind(self.target)
        .bind(self.ip)
        .bind(self.metadata)
        .execute(db)
        .await?;
        Ok(())
    }
}
