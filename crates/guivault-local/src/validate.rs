//! Tailles plausibles des blobs : les mêmes règles que le serveur
//! (`guivault-server/src/validate.rs`, à garder alignées). Ici, personne
//! d'autre ne lit le coffre, mais un item que le serveur refuserait ne
//! pourrait plus être poussé vers un compte.
use crate::error::{Error, Result};
use guivault_protocol::KdfParams;

/// `0x01 ‖ nonce(24) ‖ tag(16)` : le plus petit blob symétrique valide.
const MIN_SYM_BLOB: usize = 1 + 24 + 16;
const SEALED_KEY_LEN: usize = 1 + 32 + 32 + 16;
const AUTHENTICATED_KEY_LEN: usize = 1 + 32 + 1 + 24 + 32 + 16;
const MAX_KEY_BLOB: usize = 1024;

pub fn kdf(params: &KdfParams, salt: &[u8]) -> Result<()> {
    if !params.is_sane() {
        return Err(Error::bad_request(
            "invalid_kdf",
            "paramètres de dérivation hors bornes",
        ));
    }
    if !(16..=64).contains(&salt.len()) {
        return Err(Error::bad_request(
            "invalid_kdf",
            "sel de dérivation de taille invalide",
        ));
    }
    Ok(())
}

pub fn public_key(bytes: &[u8]) -> Result<()> {
    if bytes.len() != 32 {
        return Err(Error::bad_request(
            "invalid_public_key",
            "clé publique de taille invalide",
        ));
    }
    Ok(())
}

pub fn key_blob(name: &str, bytes: &[u8]) -> Result<()> {
    if bytes.len() <= MIN_SYM_BLOB || bytes.len() > MAX_KEY_BLOB {
        return Err(Error::bad_request("invalid_blob", format!("{name} : taille invalide")));
    }
    Ok(())
}

pub fn wrapped_vault_key(bytes: &[u8]) -> Result<()> {
    let expected = match bytes.first() {
        Some(0x01) => Some(SEALED_KEY_LEN),
        Some(0x02) => Some(AUTHENTICATED_KEY_LEN),
        _ => None,
    };
    if expected != Some(bytes.len()) {
        return Err(Error::bad_request(
            "invalid_blob",
            "clé de vault enveloppée : taille invalide",
        ));
    }
    Ok(())
}

pub fn name_enc(bytes: &[u8]) -> Result<()> {
    if bytes.len() <= MIN_SYM_BLOB || bytes.len() > 4096 {
        return Err(Error::bad_request("invalid_blob", "nom chiffré : taille invalide"));
    }
    Ok(())
}

pub fn item(item_type: &str, ciphertext: &[u8], max: usize) -> Result<()> {
    let type_ok = !item_type.is_empty()
        && item_type.len() <= 64
        && item_type
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if !type_ok || item_type == guivault_crypto::MANIFEST_TYPE {
        return Err(Error::bad_request("invalid_item_type", "type d'item invalide"));
    }
    if ciphertext.len() <= MIN_SYM_BLOB {
        return Err(Error::bad_request("invalid_blob", "chiffré d'item : trop court"));
    }
    if ciphertext.len() > max {
        return Err(Error::new(
            413,
            "item_too_large",
            format!("item de {} octets, maximum {max}", ciphertext.len()),
        ));
    }
    Ok(())
}

pub fn manifest(ciphertext: &[u8], max_item: usize) -> Result<()> {
    if ciphertext.len() <= MIN_SYM_BLOB {
        return Err(Error::bad_request("invalid_blob", "manifeste : trop court"));
    }
    let max = max_item.saturating_mul(8);
    if ciphertext.len() > max {
        return Err(Error::new(
            413,
            "manifest_too_large",
            format!("manifeste de {} octets, maximum {max}", ciphertext.len()),
        ));
    }
    Ok(())
}

pub fn settings_blob(bytes: &[u8]) -> Result<()> {
    if bytes.len() <= MIN_SYM_BLOB || bytes.len() > 64 * 1024 {
        return Err(Error::bad_request(
            "invalid_blob",
            "réglages chiffrés : taille invalide",
        ));
    }
    Ok(())
}
