//! Validation des entrées. Le serveur ne comprend pas les blobs, mais il
//! vérifie qu'ils ont une taille plausible : un blob vide ou de 50 Mo n'est
//! jamais légitime, et le refuser tôt protège la base et les autres clients.
use crate::error::AppError;
use guivault_protocol::KdfParams;

/// `0x01 ‖ nonce(24) ‖ tag(16)` : le plus petit blob symétrique valide.
const MIN_SYM_BLOB: usize = 1 + 24 + 16;
/// `0x01 ‖ pk éphémère(32) ‖ clé(32) ‖ tag(16)` : une clé de vault scellée
/// (format 1, anonyme — encore accepté des clients d'avant le format 2).
const SEALED_KEY_LEN: usize = 1 + 32 + 32 + 16;
/// `0x02 ‖ pk expéditeur(32) ‖ 0x01 ‖ nonce(24) ‖ clé(32) ‖ tag(16)` : une
/// clé de vault enveloppée par un membre (format 2, authentifié).
const AUTHENTICATED_KEY_LEN: usize = 1 + 32 + 1 + 24 + 32 + 16;
/// Enveloppes de clés : quelques centaines d'octets tout au plus.
const MAX_KEY_BLOB: usize = 1024;

pub fn normalize_email(email: &str) -> Result<String, AppError> {
    let e = email.trim().to_lowercase();
    let ok = e.len() <= 254
        && e.len() >= 3
        && e.contains('@')
        && !e.starts_with('@')
        && !e.ends_with('@')
        && !e.chars().any(|c| c.is_whitespace() || c.is_control());
    if !ok {
        return Err(AppError::bad_request("invalid_email", "adresse e-mail invalide"));
    }
    Ok(e)
}

pub fn kdf(params: &KdfParams, salt: &[u8]) -> Result<(), AppError> {
    if !params.is_sane() {
        return Err(AppError::bad_request(
            "invalid_kdf",
            "paramètres de dérivation hors bornes",
        ));
    }
    if !(16..=64).contains(&salt.len()) {
        return Err(AppError::bad_request(
            "invalid_kdf",
            "sel de dérivation de taille invalide",
        ));
    }
    Ok(())
}

pub fn auth_key(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.len() != 32 {
        return Err(AppError::bad_request(
            "invalid_auth_key",
            "clé d'authentification de taille invalide",
        ));
    }
    Ok(())
}

pub fn public_key(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.len() != 32 {
        return Err(AppError::bad_request(
            "invalid_public_key",
            "clé publique de taille invalide",
        ));
    }
    Ok(())
}

/// Une clé (user key, clé privée) enveloppée symétriquement.
pub fn key_blob(name: &str, bytes: &[u8]) -> Result<(), AppError> {
    if bytes.len() <= MIN_SYM_BLOB || bytes.len() > MAX_KEY_BLOB {
        return Err(AppError::bad_request(
            "invalid_blob",
            format!("{name} : taille invalide"),
        ));
    }
    Ok(())
}

/// Une clé de vault enveloppée pour un membre : taille fixe selon le format.
/// Le serveur ne peut rien vérifier de plus — c'est le destinataire qui
/// authentifie l'expéditeur d'une enveloppe de format 2.
pub fn wrapped_vault_key(bytes: &[u8]) -> Result<(), AppError> {
    let expected = match bytes.first() {
        Some(0x01) => Some(SEALED_KEY_LEN),
        Some(0x02) => Some(AUTHENTICATED_KEY_LEN),
        _ => None,
    };
    if expected != Some(bytes.len()) {
        return Err(AppError::bad_request(
            "invalid_blob",
            "clé de vault enveloppée : taille invalide",
        ));
    }
    Ok(())
}

/// Nom de vault chiffré : court.
pub fn name_enc(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.len() <= MIN_SYM_BLOB || bytes.len() > 4096 {
        return Err(AppError::bad_request("invalid_blob", "nom chiffré : taille invalide"));
    }
    Ok(())
}

pub fn item(item_type: &str, ciphertext: &[u8], max: usize) -> Result<(), AppError> {
    let type_ok = !item_type.is_empty()
        && item_type.len() <= 64
        && item_type
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if !type_ok {
        return Err(AppError::bad_request("invalid_item_type", "type d'item invalide"));
    }
    if ciphertext.len() <= MIN_SYM_BLOB {
        return Err(AppError::bad_request("invalid_blob", "chiffré d'item : trop court"));
    }
    if ciphertext.len() > max {
        return Err(AppError::new(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            "item_too_large",
            format!("item de {} octets, maximum {max}", ciphertext.len()),
        ));
    }
    Ok(())
}

/// Réglages synchronisés : un blob symétrique de 64 Kio au plus — de quoi
/// tenir l'apparence, le générateur et des motifs, pas un fichier.
pub fn settings_blob(bytes: &[u8]) -> Result<(), AppError> {
    if bytes.len() <= MIN_SYM_BLOB || bytes.len() > 64 * 1024 {
        return Err(AppError::bad_request(
            "invalid_blob",
            "réglages chiffrés : taille invalide",
        ));
    }
    Ok(())
}

pub fn device_name(name: Option<String>) -> Option<String> {
    name.map(|n| n.trim().chars().take(100).collect::<String>())
        .filter(|n| !n.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapped_vault_key_accepts_both_formats_at_their_size() {
        let v1 = [vec![0x01], vec![0; SEALED_KEY_LEN - 1]].concat();
        let v2 = [vec![0x02], vec![0; AUTHENTICATED_KEY_LEN - 1]].concat();
        assert!(wrapped_vault_key(&v1).is_ok());
        assert!(wrapped_vault_key(&v2).is_ok());
        // Chaque format à sa taille, pas à celle de l'autre.
        assert!(wrapped_vault_key(&[&[0x01], &v2[1..]].concat()).is_err());
        assert!(wrapped_vault_key(&[&[0x02], &v1[1..]].concat()).is_err());
        assert!(wrapped_vault_key(&v1[..SEALED_KEY_LEN - 1]).is_err());
        assert!(wrapped_vault_key(&[&[0x03], &v2[1..]].concat()).is_err());
        assert!(wrapped_vault_key(&[]).is_err());
    }
}
