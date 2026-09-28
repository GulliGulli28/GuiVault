use crate::config::Config;
use crate::events::Broadcaster;
use crate::routes::lookups::Lookups;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub events: Broadcaster,
    /// Client HTTP et cache des relais du rapport de santé.
    pub lookups: Arc<Lookups>,
}
