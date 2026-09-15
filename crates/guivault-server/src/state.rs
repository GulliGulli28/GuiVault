use crate::config::Config;
use crate::events::Broadcaster;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub events: Broadcaster,
}
