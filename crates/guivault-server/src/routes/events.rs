use crate::auth::AuthUser;
use crate::state::AppState;
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::{Stream, StreamExt};
use std::convert::Infallible;
use tokio_stream::wrappers::BroadcastStream;

/// Flux SSE des événements qui concernent l'utilisateur. Un `: ping` toutes
/// les 30 s garde la connexion ouverte à travers les proxies.
pub async fn events(
    State(state): State<AppState>,
    user: AuthUser,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.events.subscribe();
    let user_id = user.id;
    let stream = BroadcastStream::new(rx).filter_map(move |item| async move {
        match item {
            Ok(out) if out.recipients.contains(&user_id) => Event::default().json_data(&out.event).ok().map(Ok),
            // Un événement pour quelqu'un d'autre, ou un retard (`Lagged`) :
            // rien à envoyer, le client resynchronisera.
            _ => None,
        }
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(30))
            .text("ping"),
    )
}
