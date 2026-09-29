//! Serveur GuiVault. Voir `docs/ARCHITECTURE.md` pour la vue d'ensemble et
//! `docs/SECURITY.md` pour le modèle de menace.
//!
//! `lib.rs` expose ce qu'il faut pour démarrer le serveur depuis `main.rs` et
//! depuis les tests d'intégration (`tests/`), qui lancent une vraie instance
//! sur un port libre contre une base Postgres jetable.
pub mod admin;
pub mod audit;
pub mod auth;
pub mod backup;
pub mod config;
pub mod db;
pub mod error;
pub mod events;
pub mod mail;
pub mod routes;
pub mod sessions;
pub mod state;
pub mod validate;
pub mod web;
pub mod webauthn;

use crate::config::Config;
use crate::state::AppState;
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use std::sync::Arc;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(config: &Config) -> anyhow::Result<sqlx::PgPool> {
    connect_url(&config.database_url).await
}

/// Connexion et migrations : le schéma est toujours à jour de ce binaire.
pub async fn connect_url(url: &str) -> anyhow::Result<sqlx::PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(url)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

pub fn app(config: Config, db: sqlx::PgPool) -> axum::Router {
    routes::router(app_state(config, db))
}

/// L'état partagé par les routes et les tâches de fond (public pour les
/// tests, qui déclenchent ces tâches sans attendre).
pub fn app_state(config: Config, db: sqlx::PgPool) -> AppState {
    let mail = Arc::new(mail::Mailer::new(config.mail.as_ref()));
    AppState {
        db,
        mail,
        config: Arc::new(config),
        events: events::Broadcaster::new(),
        lookups: Arc::new(routes::lookups::Lookups::new()),
    }
}

/// Démarre le serveur et rend la main quand il a fini de s'arrêter. `ready`
/// reçoit l'adresse effectivement liée (utile avec le port 0 dans les tests).
pub async fn serve(
    config: Config,
    ready: impl FnOnce(SocketAddr),
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let db = connect(&config).await?;
    // La corbeille garde un item supprimé `trash_days` jours, pas plus, et
    // un lien de partage expiré ne reste pas : vérifié toutes les heures,
    // que quelqu'un les ouvre ou non.
    let (pool, days) = (db.clone(), config.trash_days);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            tick.tick().await;
            match db::prune_trash(&pool, days).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(versions = n, "corbeille : versions expirées effacées"),
                Err(e) => tracing::warn!(error = %e, "corbeille : effacement des versions expirées impossible"),
            }
            match routes::attachments::prune(&pool, days).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(pieces_jointes = n, "pièces jointes orphelines ou expirées effacées"),
                Err(e) => tracing::warn!(error = %e, "pièces jointes : effacement des orphelines impossible"),
            }
            match routes::sends::prune(&pool).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(liens = n, "liens de partage expirés effacés"),
                Err(e) => tracing::warn!(error = %e, "liens de partage : effacement des expirés impossible"),
            }
        }
    });
    let state = app_state(config.clone(), db.clone());
    // Un accès d'urgence qui s'ouvre au bout de son délai : prévenu dans les
    // cinq minutes (e-mail aux deux parties, événement aux clients branchés).
    let st = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
        loop {
            tick.tick().await;
            if let Err(e) = routes::emergency::notify_opened(&st).await {
                tracing::warn!(error = %e, "accès d'urgence : échéances illisibles");
            }
        }
    });
    if let Some(cfg) = config.backup.clone() {
        tracing::info!(dir = %cfg.dir.display(), heures = cfg.interval.as_secs() / 3600, garder = cfg.keep,
            restauration = cfg.verify_database_url.is_some(), "sauvegardes automatiques");
        tokio::spawn(backup::schedule(db.clone(), cfg, config.database_url.clone()));
    }
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    ready(listener.local_addr()?);
    let router = routes::router(state);
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}
