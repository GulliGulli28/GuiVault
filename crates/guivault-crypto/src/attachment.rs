//! Les pièces jointes : un fichier chiffré en morceaux, rangé à part des
//! items (`docs/PIECES-JOINTES.md`).
//!
//! Chaque pièce jointe a **sa propre clé**, tirée au hasard, gardée dans le
//! JSON de l'item qui la porte (donc sous la clé du vault, et couverte par
//! son manifeste). Renouveler la clé d'un vault re-chiffre les items, jamais
//! les fichiers ; déplacer un item vers un autre vault ne demande pas de les
//! re-chiffrer non plus.
//!
//! Le fichier est découpé en morceaux de [`ATTACHMENT_CHUNK`] octets (le
//! dernier plus court, un fichier vide en fait un), chacun scellé comme le
//! reste (`seal`, format `0x01`) sous l'AAD
//! `guivault/v1/attachment\0<id>\0<index>\0<dernier>` : le serveur ne peut ni
//! les réordonner, ni tronquer le fichier (le dernier morceau le dit), ni
//! mêler les morceaux de deux pièces jointes.
use crate::{CryptoError, NONCE_LEN, SymmetricKey, TAG_LEN, open, seal};

/// La taille en clair d'un morceau (le dernier peut être plus court).
pub const ATTACHMENT_CHUNK: usize = 1024 * 1024;
/// Ce que le chiffrement ajoute à chaque morceau (version, nonce, tag).
pub const ATTACHMENT_CHUNK_OVERHEAD: usize = 1 + NONCE_LEN + TAG_LEN;

/// Le nombre de morceaux d'un fichier de `size` octets en clair.
pub fn attachment_chunk_count(size: u64) -> u32 {
    size.div_ceil(ATTACHMENT_CHUNK as u64).max(1) as u32
}

/// La taille chiffrée totale d'un fichier de `size` octets en clair : ce que
/// le serveur voit et compte.
pub fn attachment_sealed_size(size: u64) -> u64 {
    size + attachment_chunk_count(size) as u64 * ATTACHMENT_CHUNK_OVERHEAD as u64
}

fn chunk_aad(attachment_id: &str, index: u32, last: bool) -> Vec<u8> {
    format!("guivault/v1/attachment\0{attachment_id}\0{index}\0{}", u8::from(last)).into_bytes()
}

pub fn seal_attachment_chunk(
    key: &SymmetricKey,
    attachment_id: &str,
    index: u32,
    last: bool,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    seal(key, plaintext, &chunk_aad(attachment_id, index, last))
}

pub fn open_attachment_chunk(
    key: &SymmetricKey,
    attachment_id: &str,
    index: u32,
    last: bool,
    blob: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    open(key, blob, &chunk_aad(attachment_id, index, last))
}

/// Un fichier entier, en morceaux scellés dans l'ordre.
pub fn seal_attachment(key: &SymmetricKey, attachment_id: &str, data: &[u8]) -> Result<Vec<Vec<u8>>, CryptoError> {
    let count = attachment_chunk_count(data.len() as u64);
    (0..count)
        .map(|i| {
            let start = i as usize * ATTACHMENT_CHUNK;
            let end = (start + ATTACHMENT_CHUNK).min(data.len());
            seal_attachment_chunk(key, attachment_id, i, i + 1 == count, &data[start..end])
        })
        .collect()
}

/// L'inverse : tous les morceaux, dans l'ordre. Un morceau manquant, en trop
/// ou déplacé ne s'ouvre pas.
pub fn open_attachment(key: &SymmetricKey, attachment_id: &str, chunks: &[Vec<u8>]) -> Result<Vec<u8>, CryptoError> {
    if chunks.is_empty() {
        return Err(CryptoError::Format);
    }
    let mut out = Vec::new();
    for (i, c) in chunks.iter().enumerate() {
        out.extend(open_attachment_chunk(
            key,
            attachment_id,
            i as u32,
            i + 1 == chunks.len(),
            c,
        )?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "aaaaaaaa-0000-4000-8000-000000000000";

    #[test]
    fn a_file_round_trips_in_chunks() {
        let key = SymmetricKey::random();
        for size in [
            0,
            1,
            ATTACHMENT_CHUNK - 1,
            ATTACHMENT_CHUNK,
            ATTACHMENT_CHUNK + 1,
            2 * ATTACHMENT_CHUNK + 7,
        ] {
            let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let chunks = seal_attachment(&key, ID, &data).unwrap();
            assert_eq!(
                chunks.len() as u32,
                attachment_chunk_count(size as u64),
                "taille {size}"
            );
            let total: usize = chunks.iter().map(Vec::len).sum();
            assert_eq!(total as u64, attachment_sealed_size(size as u64), "taille {size}");
            assert_eq!(open_attachment(&key, ID, &chunks).unwrap(), data, "taille {size}");
        }
    }

    #[test]
    fn reordered_truncated_or_foreign_chunks_do_not_open() {
        let key = SymmetricKey::random();
        let data = vec![7u8; 2 * ATTACHMENT_CHUNK + 10];
        let chunks = seal_attachment(&key, ID, &data).unwrap();
        // Tronqué : l'avant-dernier morceau n'est pas « le dernier ».
        assert!(open_attachment(&key, ID, &chunks[..2]).is_err());
        // Réordonné.
        let swapped = vec![chunks[1].clone(), chunks[0].clone(), chunks[2].clone()];
        assert!(open_attachment(&key, ID, &swapped).is_err());
        // D'une autre pièce jointe, ou sous une autre clé.
        assert!(open_attachment(&key, "bbbbbbbb-0000-4000-8000-000000000000", &chunks).is_err());
        assert!(open_attachment(&SymmetricKey::random(), ID, &chunks).is_err());
        assert!(open_attachment(&key, ID, &[]).is_err());
    }
}
