//! Erreur unique de l'API : un statut HTTP, un code stable pour le client, un
//! message pour l'humain. Les erreurs internes sont journalisées côté serveur
//! et rendues opaques côté client (pas de détail SQL dans une réponse).
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use guivault_protocol::ApiError;
use serde_json::Value;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// Corps supplémentaire (ex. l'item courant sur un 409).
    pub extra: Option<Value>,
}

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            extra: None,
        }
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentification requise ou invalide",
        )
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn not_found(what: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", format!("{what} introuvable"))
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn with_extra(mut self, extra: Value) -> Self {
        self.extra = Some(extra);
        self
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = ApiError {
            code: self.code.to_string(),
            message: self.message,
        };
        let mut value = serde_json::to_value(body).unwrap_or(Value::Null);
        if let (Some(obj), Some(Value::Object(extra))) = (value.as_object_mut(), self.extra) {
            obj.extend(extra);
        }
        (self.status, axum::Json(value)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "erreur base de données");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "erreur interne")
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "erreur interne");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "erreur interne")
    }
}

impl From<guivault_crypto::CryptoError> for AppError {
    fn from(e: guivault_crypto::CryptoError) -> Self {
        tracing::error!(error = %e, "erreur cryptographique côté serveur");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "erreur interne")
    }
}

pub type ApiResult<T> = Result<T, AppError>;
