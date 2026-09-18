//! Serveur GuiVault. Voir `docs/ARCHITECTURE.md` pour la vue d'ensemble et
//! `docs/SECURITY.md` pour le modèle de menace.
//!
//! `lib.rs` expose ce qu'il faut pour démarrer le serveur depuis `main.rs` et
//! depuis les tests d'intégration (`tests/`), qui lancent une vraie instance
//! sur un port libre contre une base Postgres jetable.
pub mod audit;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod events;
pub mod routes;
pub mod sessions;
pub mod state;
pub mod validate;
pub mod web;

use crate::config::Config;
use crate::state::AppState;
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use std::sync::Arc;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(config: &Config) -> anyhow::Result<sqlx::PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

pub fn app(config: Config, db: sqlx::PgPool) -> axum::Router {
    routes::router(AppState {
        db,
        config: Arc::new(config),
        events: events::Broadcaster::new(),
    })
}

/// Démarre le serveur et rend la main quand il a fini de s'arrêter. `ready`
/// reçoit l'adresse effectivement liée (utile avec le port 0 dans les tests).
pub async fn serve(
    config: Config,
    ready: impl FnOnce(SocketAddr),
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let db = connect(&config).await?;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    ready(listener.local_addr()?);
    let router = app(config, db);
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}
