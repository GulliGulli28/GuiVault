use crate::state::AppState;
use axum::Json;
use axum::extract::State;
use guivault_protocol::{HealthResponse, PROTOCOL_VERSION};

pub async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".into(),
        protocol_version: PROTOCOL_VERSION,
        server_version: env!("CARGO_PKG_VERSION").into(),
        registration: state.config.registration,
    })
}
