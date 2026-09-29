//! Le manifeste d'un vault : la liste authentifiée de ce qu'il contient.
//!
//! L'AAD d'un item le lie à son vault, son id et son type — pas à sa
//! révision. Sans manifeste, un serveur malveillant pourrait donc, sans
//! jamais rien déchiffrer, **rejouer** l'ancien chiffré d'un item (un ancien
//! mot de passe « revient »), **retenir** un item (le faire disparaître) ou
//! en **ressusciter** un supprimé. Le manifeste, chiffré sous la clé du vault
//! comme un item, dit quels items existent et l'empreinte (SHA-256) de leur
//! chiffré ; chaque écriture le réécrit dans la même transaction. Un client
//! vérifie ce que le serveur lui sert contre lui, et retient le plus grand
//! compteur vu : un manifeste rejoué se trahit.
//!
//! Il est scellé exactement comme un item (`seal_item`, format `0x01`), sous
//! un id et un type réservés : aucun nouveau format binaire, et un chiffré
//! d'item ne peut pas passer pour un manifeste (ni l'inverse), l'AAD diffère.
//!
//! Limite assumée (`docs/MANIFESTE.md`) : n'importe quel membre du vault peut
//! écrire un manifeste valide, lecteurs compris — il a déjà la clé.
//! L'historique et la corbeille n'y sont pas : ils ne servent qu'à restaurer,
//! et une restauration repasse par une écriture.
use crate::{CryptoError, SymmetricKey, open_item, seal_item};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// L'id et le type sous lesquels le manifeste est scellé (dans l'AAD).
pub const MANIFEST_ID: &str = "00000000-0000-0000-0000-000000000000";
pub const MANIFEST_TYPE: &str = "manifest";
pub const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub v: u32,
    /// Monte de 1 à chaque écriture ; égal à la révision du manifeste que le
    /// serveur annonce.
    pub counter: i64,
    /// Id d'item → empreinte de son chiffré (`item_digest`).
    pub items: BTreeMap<String, String>,
}

impl Manifest {
    pub fn empty() -> Self {
        Manifest {
            v: MANIFEST_VERSION,
            counter: 0,
            items: BTreeMap::new(),
        }
    }

    /// Le manifeste d'un ensemble d'items (id, chiffré), au compteur donné.
    pub fn of<'a>(counter: i64, items: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> Self {
        Manifest {
            v: MANIFEST_VERSION,
            counter,
            items: items
                .into_iter()
                .map(|(id, ct)| (id.to_string(), item_digest(ct)))
                .collect(),
        }
    }

    /// Le suivant, sur la révision `base` que le serveur annonce : même
    /// contenu, compteur `base + 1` ; à compléter par `put` / `remove`.
    pub fn next(&self, base: i64) -> Self {
        Manifest {
            v: MANIFEST_VERSION,
            counter: base + 1,
            items: self.items.clone(),
        }
    }

    pub fn put(&mut self, item_id: &str, ciphertext: &[u8]) {
        self.items.insert(item_id.to_string(), item_digest(ciphertext));
    }

    pub fn remove(&mut self, item_id: &str) {
        self.items.remove(item_id);
    }
}

/// L'empreinte d'un chiffré d'item : SHA-256, en base64url sans remplissage.
pub fn item_digest(ciphertext: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(ciphertext))
}

pub fn seal_manifest(vault_key: &SymmetricKey, vault_id: &str, manifest: &Manifest) -> Result<Vec<u8>, CryptoError> {
    let json = serde_json::to_vec(manifest).map_err(|_| CryptoError::Encrypt)?;
    seal_item(vault_key, vault_id, MANIFEST_ID, MANIFEST_TYPE, &json)
}

pub fn open_manifest(vault_key: &SymmetricKey, vault_id: &str, blob: &[u8]) -> Result<Manifest, CryptoError> {
    let json = open_item(vault_key, vault_id, MANIFEST_ID, MANIFEST_TYPE, blob)?;
    let manifest: Manifest = serde_json::from_slice(&json).map_err(|_| CryptoError::Format)?;
    if manifest.v != MANIFEST_VERSION {
        return Err(CryptoError::Format);
    }
    Ok(manifest)
}

/// Ce qu'une vérification peut trouver. Tout sauf `Missing` suppose un
/// manifeste servi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestProblem {
    /// Le serveur ne sert plus de manifeste, alors que cet appareil en a vu
    /// un (compteur `seen`).
    Missing { seen: i64 },
    /// Il ne s'ouvre pas avec la clé du vault : altéré, ou fabriqué.
    Unreadable,
    /// Son compteur n'est pas la révision que le serveur annonce.
    Mismatch { counter: i64, revision: i64 },
    /// Plus ancien que le dernier vu d'ici : rejoué.
    Rollback { counter: i64, seen: i64 },
    /// Un item servi que le manifeste ne connaît pas : ajouté hors des
    /// clients, ou ressuscité après suppression.
    Unexpected { item_id: String },
    /// Un item servi dont le chiffré n'est pas celui annoncé : une ancienne
    /// version rejouée.
    Altered { item_id: String },
    /// Un item du manifeste que le serveur ne sert pas : retiré en douce.
    Withheld { item_id: String },
}

impl std::fmt::Display for ManifestProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing { seen } => write!(
                f,
                "le serveur ne sert plus le manifeste de ce vault (vu ici jusqu'à la version {seen})"
            ),
            Self::Unreadable => write!(f, "le manifeste ne s'ouvre pas avec la clé du vault"),
            Self::Mismatch { counter, revision } => write!(
                f,
                "le manifeste (version {counter}) ne correspond pas à la révision annoncée ({revision})"
            ),
            Self::Rollback { counter, seen } => write!(
                f,
                "le manifeste est revenu à la version {counter}, alors que la {seen} a déjà été vue ici"
            ),
            Self::Unexpected { item_id } => write!(f, "l'élément {item_id} n'est pas dans le manifeste"),
            Self::Altered { item_id } => {
                write!(f, "l'élément {item_id} n'est pas la version annoncée par le manifeste")
            }
            Self::Withheld { item_id } => write!(
                f,
                "l'élément {item_id} est dans le manifeste mais le serveur ne le sert pas"
            ),
        }
    }
}

/// Ce que dit la vérification : le manifeste ouvert (à reprendre pour la
/// prochaine écriture) et les écarts.
#[derive(Debug, Clone)]
pub struct Verified {
    pub manifest: Option<Manifest>,
    pub problems: Vec<ManifestProblem>,
}

/// Vérifie ce que sert le serveur pour un vault : `served`, le manifeste
/// (révision annoncée, chiffré) ou rien ; `items`, **tous** les items vivants
/// servis (id, chiffré) — l'état complet, pas un delta ; `seen`, le plus
/// grand compteur vu d'ici pour ce vault. Sans manifeste servi ni jamais vu,
/// rien à vérifier (vault d'avant les manifestes).
pub fn verify_manifest<'a>(
    vault_key: &SymmetricKey,
    vault_id: &str,
    served: Option<(i64, &[u8])>,
    items: impl IntoIterator<Item = (&'a str, &'a [u8])>,
    seen: Option<i64>,
) -> Verified {
    let digests: Vec<(&str, String)> = items.into_iter().map(|(id, ct)| (id, item_digest(ct))).collect();
    verify_manifest_digests(
        vault_key,
        vault_id,
        served,
        digests.iter().map(|(id, d)| (*id, d.as_str())),
        seen,
    )
}

/// [`verify_manifest`] sur les empreintes des items (`item_digest`) plutôt
/// que leurs chiffrés : pour un client qui ne garde pas les chiffrés et tient
/// l'état complet à jour delta après delta (Guiterm).
pub fn verify_manifest_digests<'a>(
    vault_key: &SymmetricKey,
    vault_id: &str,
    served: Option<(i64, &[u8])>,
    digests: impl IntoIterator<Item = (&'a str, &'a str)>,
    seen: Option<i64>,
) -> Verified {
    let mut problems = Vec::new();
    let Some((revision, blob)) = served else {
        if let Some(seen) = seen.filter(|s| *s > 0) {
            problems.push(ManifestProblem::Missing { seen });
        }
        return Verified {
            manifest: None,
            problems,
        };
    };
    let manifest = match open_manifest(vault_key, vault_id, blob) {
        Ok(m) => m,
        Err(_) => {
            return Verified {
                manifest: None,
                problems: vec![ManifestProblem::Unreadable],
            };
        }
    };
    if manifest.counter != revision {
        problems.push(ManifestProblem::Mismatch {
            counter: manifest.counter,
            revision,
        });
    }
    if let Some(seen) = seen.filter(|s| *s > manifest.counter) {
        problems.push(ManifestProblem::Rollback {
            counter: manifest.counter,
            seen,
        });
    }
    let mut served_ids = std::collections::BTreeSet::new();
    let mut item_problems = Vec::new();
    for (id, digest) in digests {
        served_ids.insert(id.to_string());
        match manifest.items.get(id) {
            None => item_problems.push(ManifestProblem::Unexpected {
                item_id: id.to_string(),
            }),
            Some(d) if d != digest => item_problems.push(ManifestProblem::Altered {
                item_id: id.to_string(),
            }),
            Some(_) => {}
        }
    }
    for id in manifest.items.keys().filter(|id| !served_ids.contains(*id)) {
        item_problems.push(ManifestProblem::Withheld { item_id: id.clone() });
    }
    item_problems.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
    problems.extend(item_problems);
    Verified {
        manifest: Some(manifest),
        problems,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAULT: &str = "11111111-2222-3333-4444-555555555555";

    fn setup() -> (SymmetricKey, Vec<(String, Vec<u8>)>) {
        let key = SymmetricKey::random();
        let items = ["a", "b", "c"]
            .iter()
            .map(|n| {
                let id = format!("{n}aaaaaaa-0000-4000-8000-000000000000");
                let ct = seal_item(&key, VAULT, &id, "note", n.as_bytes()).unwrap();
                (id, ct)
            })
            .collect();
        (key, items)
    }

    fn view(items: &[(String, Vec<u8>)]) -> Vec<(&str, &[u8])> {
        items.iter().map(|(i, c)| (i.as_str(), c.as_slice())).collect()
    }

    #[test]
    fn a_faithful_server_passes() {
        let (key, items) = setup();
        let m = Manifest::of(3, view(&items));
        let blob = seal_manifest(&key, VAULT, &m).unwrap();
        let v = verify_manifest(&key, VAULT, Some((3, &blob)), view(&items), Some(2));
        assert!(v.problems.is_empty(), "{:?}", v.problems);
        assert_eq!(v.manifest.unwrap(), m);
        // Vault d'avant les manifestes, jamais vu avec : rien à dire.
        assert!(
            verify_manifest(&key, VAULT, None, view(&items), None)
                .problems
                .is_empty()
        );
    }

    #[test]
    fn replayed_withheld_resurrected_and_rolled_back_are_caught() {
        let (key, mut items) = setup();
        let m = Manifest::of(5, view(&items));
        let blob = seal_manifest(&key, VAULT, &m).unwrap();
        let old_b = seal_item(&key, VAULT, &items[1].0, "note", b"ancien").unwrap();
        let withheld = items.remove(2).0;
        items[1].1 = old_b;
        let intruder = "dddddddd-0000-4000-8000-000000000000".to_string();
        items.push((
            intruder.clone(),
            seal_item(&key, VAULT, &intruder, "note", b"x").unwrap(),
        ));
        let v = verify_manifest(&key, VAULT, Some((5, &blob)), view(&items), Some(7));
        assert_eq!(
            v.problems,
            vec![
                ManifestProblem::Rollback { counter: 5, seen: 7 },
                ManifestProblem::Altered {
                    item_id: items[1].0.clone()
                },
                ManifestProblem::Unexpected { item_id: intruder },
                ManifestProblem::Withheld { item_id: withheld },
            ]
        );
    }

    #[test]
    fn swapped_counter_missing_or_forged_manifest() {
        let (key, items) = setup();
        let blob = seal_manifest(&key, VAULT, &Manifest::of(4, view(&items))).unwrap();
        assert_eq!(
            verify_manifest(&key, VAULT, Some((6, &blob)), view(&items), None).problems,
            vec![ManifestProblem::Mismatch {
                counter: 4,
                revision: 6
            }]
        );
        assert_eq!(
            verify_manifest(&key, VAULT, None, view(&items), Some(4)).problems,
            vec![ManifestProblem::Missing { seen: 4 }]
        );
        // Un chiffré d'item servi comme manifeste : l'AAD diffère.
        assert_eq!(
            verify_manifest(&key, VAULT, Some((4, &items[0].1)), view(&items), None).problems,
            vec![ManifestProblem::Unreadable]
        );
        // Un manifeste d'un autre vault non plus.
        let other = seal_manifest(&key, "autre", &Manifest::of(4, view(&items))).unwrap();
        assert_eq!(
            verify_manifest(&key, VAULT, Some((4, &other)), view(&items), None).problems,
            vec![ManifestProblem::Unreadable]
        );
    }

    #[test]
    fn digests_verify_like_ciphertexts() {
        let (key, items) = setup();
        let blob = seal_manifest(&key, VAULT, &Manifest::of(2, view(&items))).unwrap();
        let digests: Vec<(String, String)> = items.iter().map(|(i, c)| (i.clone(), item_digest(c))).collect();
        let d = |n: usize| {
            digests[..n]
                .iter()
                .map(|(i, d)| (i.as_str(), d.as_str()))
                .collect::<Vec<_>>()
        };
        assert!(
            verify_manifest_digests(&key, VAULT, Some((2, &blob)), d(3), Some(2))
                .problems
                .is_empty()
        );
        assert_eq!(
            verify_manifest_digests(&key, VAULT, Some((2, &blob)), d(2), None).problems,
            vec![ManifestProblem::Withheld {
                item_id: items[2].0.clone()
            }]
        );
    }

    #[test]
    fn next_put_remove() {
        let (_, items) = setup();
        let m = Manifest::of(2, view(&items));
        let mut n = m.next(2);
        n.remove(&items[0].0);
        n.put("new", b"ct");
        assert_eq!(n.counter, 3);
        assert!(!n.items.contains_key(&items[0].0));
        assert_eq!(n.items["new"], item_digest(b"ct"));
        assert_eq!(item_digest(b"abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    }
}
