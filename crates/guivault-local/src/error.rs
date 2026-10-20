//! Les erreurs du coffre local : **mêmes codes que le serveur** (`AppError`,
//! `docs/API.md`), même statut HTTP, mêmes champs supplémentaires (`current`
//! sur `revision_mismatch`). Le transport de l'app les rend telles quelles à
//! l'interface, qui ne voit pas la différence : un conflit se fusionne
//! (`MergeDialog`) comme s'il venait du serveur.
//!
//! Codes propres au local : `local_not_found`, `local_exists`,
//! `local_format_unsupported`, `local_corrupt`, `local_io`.
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub extra: Option<Value>,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            extra: None,
        }
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(400, code, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, "forbidden", message)
    }

    pub fn not_found(what: &str) -> Self {
        Self::new(404, "not_found", format!("{what} introuvable"))
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(409, code, message)
    }

    pub fn with_extra(mut self, extra: Value) -> Self {
        self.extra = Some(extra);
        self
    }

    pub(crate) fn io(what: impl std::fmt::Display, e: std::io::Error) -> Self {
        Self::new(500, "local_io", format!("{what} : {e}"))
    }

    /// Le corps JSON qu'aurait renvoyé le serveur : `code`, `message`, et les
    /// champs supplémentaires à plat.
    pub fn body(&self) -> Value {
        let mut body = serde_json::json!({ "code": self.code, "message": self.message });
        if let (Some(obj), Some(Value::Object(extra))) = (body.as_object_mut(), &self.extra) {
            obj.extend(extra.clone());
        }
        body
    }
}
