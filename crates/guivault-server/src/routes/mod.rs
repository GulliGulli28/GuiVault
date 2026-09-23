//! Assemblage du routeur. Toutes les routes sont sous `/api/v1`.
use crate::auth::ClientIpKey;
use crate::state::AppState;
use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, StatusCode, header};
use axum::routing::{delete, get, post, put};
use std::sync::Arc;
use std::time::Duration;
use tower_governor::GovernorLayer;
use tower_governor::governor::GovernorConfigBuilder;
use tower_http::cors::{Any, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

pub mod audit;
pub mod auth;
pub mod events;
pub mod health;
pub mod invitations;
pub mod items;
pub mod sync;
pub mod totp;
pub mod users;
pub mod vaults;

pub fn router(state: AppState) -> Router {
    let cfg = &state.config;

    // Rate-limit par IP sur ce qui se devine (mots de passe, e-mails) ;
    // le reste est derrière un jeton et n'a pas besoin de ce frein.
    let governor = GovernorConfigBuilder::default()
        // `per_second(n)` de tower_governor = une requête toutes les n
        // secondes ; on veut n requêtes par seconde, d'où la période en ms.
        .per_millisecond((1000 / cfg.auth_rate_per_second.max(1)).max(1))
        .burst_size(cfg.auth_rate_burst)
        .key_extractor(ClientIpKey {
            trust_proxy: cfg.trust_proxy.clone(),
        })
        .finish()
        .expect("configuration de rate-limit valide");

    let auth_routes = Router::new()
        .route("/auth/prelogin", post(auth::prelogin))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/refresh", post(auth::refresh))
        .route("/auth/totp/verify", post(totp::verify))
        .layer(GovernorLayer::new(Arc::new(governor)));

    let api = Router::new()
        .route("/health", get(health::health))
        .merge(auth_routes)
        .route("/auth/logout", post(auth::logout))
        .route("/auth/password", post(auth::change_password))
        .route("/auth/sessions", get(auth::list_sessions))
        .route("/auth/sessions/{id}", delete(auth::revoke_session))
        .route("/auth/totp", get(totp::status))
        .route("/auth/totp/setup", post(totp::setup))
        .route("/auth/totp/enable", post(totp::enable))
        .route("/auth/totp/disable", post(totp::disable))
        .route("/events", get(events::events))
        .route("/users/me", get(users::me))
        .route("/users/me/settings", get(users::get_settings).put(users::put_settings))
        .route("/users/me/audit", get(audit::for_me))
        .route("/users/lookup", get(users::lookup))
        .route("/sync", get(sync::sync))
        .route("/vaults", get(vaults::list).post(vaults::create))
        .route(
            "/vaults/{id}",
            get(vaults::get).patch(vaults::rename).delete(vaults::delete),
        )
        .route("/vaults/{id}/leave", post(vaults::leave))
        .route("/vaults/{id}/rotate-key", post(vaults::rotate_key))
        .route("/vaults/{id}/audit", get(audit::for_vault))
        .route(
            "/vaults/{id}/members",
            get(vaults::list_members).post(vaults::add_member),
        )
        .route(
            "/vaults/{id}/members/{user_id}",
            axum::routing::patch(vaults::update_member).delete(vaults::remove_member),
        )
        .route(
            "/vaults/{id}/members/{user_id}/transfer",
            post(vaults::transfer_ownership),
        )
        .route(
            "/vaults/{id}/invitations",
            get(invitations::list_for_vault).post(invitations::create),
        )
        .route("/vaults/{id}/items", get(items::list))
        .route(
            "/vaults/{id}/items/{item_id}",
            put(items::put).get(items::get).delete(items::delete),
        )
        .route("/invitations", get(invitations::list_mine))
        .route("/invitations/{id}", delete(invitations::revoke))
        .route("/invitations/{id}/accept", post(invitations::accept))
        .route("/invitations/{id}/decline", post(invitations::decline))
        .route("/invitations/{id}/complete", post(invitations::complete));

    // Corps : la rotation de clé renvoie tous les items d'un vault d'un coup,
    // d'où une limite bien au-dessus de celle d'un item seul.
    let body_limit = cfg.max_item_bytes.saturating_mul(64).max(8 * 1024 * 1024);

    // CORS ouvert sur l'API : elle n'a ni cookie ni session ambiante, tout
    // passe par le jeton porteur, donc une page tierce ne peut rien faire
    // sans lui — et c'est ce qui permet à l'extension de navigateur
    // (`web/extension`) de parler à n'importe quel serveur GuiVault sans
    // permission d'hôte. `Any` sur l'origine n'expose pas les identifiants
    // (`credentials` reste faux).
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT])
        .max_age(Duration::from_secs(3600));

    // L'interface web est fusionnée *après* les couches : ses en-têtes de
    // cache et de sécurité sont les siens (`web.rs`), pas ceux de l'API.
    Router::new()
        .nest("/api/v1", api)
        .layer(cors)
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(TraceLayer::new_for_http())
        .merge(crate::web::router())
        .with_state(state)
}
