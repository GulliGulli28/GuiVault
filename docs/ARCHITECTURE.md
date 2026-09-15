# Architecture

## Vue d'ensemble

```
┌──────────────────────┐        HTTPS (JSON)        ┌──────────────────────┐
│  Guiterm (client)    │ ◀────────────────────────▶ │  guivault-server     │
│                      │                            │  (axum)              │
│  mot de passe maître │   blobs chiffrés, jetons   │                      │
│  ▼ guivault-crypto   │   opaques, métadonnées     │  aucune clé          │
│  clés en mémoire     │                            │  ▼ sqlx              │
└──────────────────────┘                            │  PostgreSQL          │
                                                    └──────────────────────┘
```

Trois crates dans un workspace Cargo :

| Crate | Rôle | Qui l'utilise |
|---|---|---|
| `guivault-crypto` | dérivation de clés, enveloppes, boîtes scellées, cycle de vie du compte | client **et** serveur (le serveur n'en utilise que le hachage des jetons/clé d'auth) |
| `guivault-protocol` | structs JSON des requêtes/réponses | client et serveur |
| `guivault-server` | routes, base, sessions, audit | serveur |

## Hiérarchie de clés

```
mot de passe maître
  │  Argon2id(sel utilisateur, 64 MiB / 3 passes)         ← côté client
  ▼
master key (32 o) ─ jamais stockée, jamais envoyée
  ├─ HKDF "guivault/v1/auth" ─▶ auth key ──▶ envoyée au serveur
  │                                          re-hachée Argon2id (19 MiB / 2) → auth_hash
  └─ HKDF "guivault/v1/enc"  ─▶ stretched key
                                    │ enveloppe (XChaCha20-Poly1305)
                                    ▼
                               user key (32 o, aléatoire) ─ protected_user_key
                                    │ enveloppe
                                    ▼
                               clé privée X25519 ─ protected_private_key
                                    │ déscelle (boîte scellée libsodium)
                                    ▼
                               vault key (32 o, une par vault) ─ wrapped_vault_key (par membre)
                                    │ enveloppe, AAD = "guivault/v1/item" ‖ vault_id ‖ item_id ‖ type
                                    ▼
                               items (JSON chiffré), nom du vault
```

Conséquences pratiques :

- **Changer de mot de passe** ré-enveloppe la *user key* et rien d'autre.
  Aucun item n'est re-chiffré. Les autres sessions sont révoquées.
- **Partager un vault** = sceller sa *vault key* vers la clé publique du
  membre. Le serveur voit passer une enveloppe de 81 octets.
- **Retirer un membre** supprime son enveloppe, mais il a pu copier la clé :
  le client enchaîne sur une **rotation** (nouvelle vault key, tous les
  items re-chiffrés, nouvelles enveloppes pour chaque membre restant),
  appliquée atomiquement par le serveur.
- **AAD** : le serveur ne peut ni déplacer un item d'un vault à l'autre, ni
  en changer le type, ni échanger deux noms de vaults : le tag AEAD ne
  vérifierait plus.

## Modèle de données

```
users ──┬── sessions (jetons hachés, rotation, révocation)
        ├── vault_members ── vaults ──┬── items (blobs, révision, tombale)
        │                             └── invitations
        └── audit_log
```

- `users` : e-mail (citext), paramètres KDF + sel, `auth_hash` (PHC
  Argon2id), `protected_user_key`, `public_key`, `protected_private_key`.
- `vaults` : `kind` (`personal` : un par utilisateur, créé à l'inscription,
  non partageable ; `shared`), `name_enc`, `revision`.
- `vault_members` : rôle + `wrapped_vault_key`. Un seul `owner` par vault
  (index unique partiel).
- `items` : `item_type` en clair (pour filtrer sans déchiffrer — mais lié
  par l'AAD), `ciphertext`, `revision` (celle du vault au moment de
  l'écriture), `deleted_at` (pierre tombale, `ciphertext` vidé).
- `invitations` : `wrapped_vault_key` nullable (invité pas encore inscrit),
  statut `pending → accepted` ou `pending → awaiting_key → accepted`.

## Synchronisation

Chaque vault porte un compteur `revision`, incrémenté à chaque écriture
d'item (`FOR UPDATE` sur la ligne du vault : deux écrivains concurrents ne
partagent jamais une révision). Un item mémorise la révision de sa dernière
écriture.

Protocole client :

1. `GET /sync` → profil, vaults (avec `revision`), invitations en attente.
2. Pour chaque vault dont la révision a bougé depuis le cache local :
   `GET /vaults/{id}/items?since=<révision connue>` → items modifiés
   (tombales comprises), triés par révision.
3. Écriture : `PUT /vaults/{id}/items/{item_id}` avec `base_revision` = la
   révision de l'item telle que le client la connaît (`null` pour une
   création). Le serveur répond **409 `revision_mismatch`** avec l'item
   courant dans `current` si quelqu'un est passé avant : le client déchiffre
   les deux versions, fusionne (ou demande à l'utilisateur), réessaie.

Les ids d'items et de vaults sont choisis **par le client** (UUID v4) :
ils font partie de l'AAD, il faut les connaître avant de chiffrer. Un id
d'item n'a de sens que dans son vault (clé primaire `(vault_id, id)`) :
déplacer une entité d'un vault à l'autre = tombale dans l'ancien, création
dans le nouveau, même id — les références entre entités (groupe d'un hôte,
clé d'un hôte) restent valables.

## Sessions

Jetons opaques (32 octets aléatoires, base64url). La base ne contient que
leur SHA-256 : une lecture de la base ne donne aucune session utilisable.

- **Accès** : 15 min. Une requête = une lecture indexée sur `sessions`.
- **Rafraîchissement** : 30 jours, **tourné à chaque usage**. Le hash du
  jeton précédent est conservé : le représenter (rejeu d'un jeton volé)
  révoque la session entière — ni le voleur ni la victime ne continuent,
  la victime se reconnecte.
- Révocation immédiate : déconnexion, liste des sessions, changement de
  mot de passe (toutes les autres sessions).

Pas de JWT : rien à signer, pas d'algorithme à confondre, révocation
instantanée.

## Invitations

| Cas | Flux |
|---|---|
| L'invité a un compte | `GET /users/lookup?email=` → clé publique + empreinte → l'inviteur vérifie l'empreinte hors bande, enveloppe la vault key → `POST /vaults/{id}/invitations` avec la clé → l'invité accepte → membre. |
| L'invité n'a pas de compte | `POST /vaults/{id}/invitations` sans clé → l'invité s'inscrit (l'invitation l'y autorise en mode `invite_only`) → accepte → `awaiting_key` → l'inviteur voit sa clé publique dans la liste, vérifie l'empreinte, `POST /invitations/{id}/complete` → membre. |

Une invitation porte un rôle ≤ celui de l'inviteur, expire (14 j), et est
révoquée automatiquement par une rotation de clé (elle portait l'ancienne).

## Rôles

| | reader | writer | admin | owner |
|---|:-:|:-:|:-:|:-:|
| lire les items | ✓ | ✓ | ✓ | ✓ |
| écrire / supprimer des items | | ✓ | ✓ | ✓ |
| membres, invitations, renommer, rotation, audit | | | ✓ | ✓ |
| supprimer le vault, transférer la propriété | | | | ✓ |

Un admin ne confère pas un rôle supérieur au sien et ne touche pas au
propriétaire. Le propriétaire ne quitte pas un vault : il transfère ou
supprime.

## Ce que le serveur sait

Métadonnées visibles côté serveur, assumées : adresses e-mail, qui est
membre de quel vault avec quel rôle, nombre et types d'items, dates de
modification, IP et user-agent des sessions, journal d'audit. **Jamais** :
un nom de vault, un nom d'hôte, un identifiant, une clé, un mot de passe.

## Second facteur (TOTP)

Optionnel, par utilisateur. Le secret (RFC 6238, SHA-1, 6 chiffres, 30 s)
est chiffré au repos sous une clé HKDF du secret serveur (AAD = id
utilisateur) : un dump de base ne fabrique pas de codes. Huit codes de
récupération hachés (salés par le secret serveur), à usage unique.

Connexion en deux temps : `/auth/login` répond `202` avec un jeton de défi
(5 min, 5 essais) au lieu de la session ; `/auth/totp/verify` l'échange
contre la session. Activer le second facteur révoque les autres sessions.

Ce que ça protège : la **session**. Un attaquant avec le mot de passe
maître *et* un dump de base a tout, 2FA ou pas — voir `SECURITY.md`.

## Notifications temps réel

`GET /events` est un flux SSE. Un canal broadcast en mémoire (256
événements de profondeur) reçoit chaque écriture d'item, rotation,
changement d'appartenance et invitation, avec ses destinataires ; le flux
de chaque utilisateur filtre les siens. L'événement dit *que* quelque chose
a changé (`vault_changed` porte la révision), jamais quoi : le client
resynchronise. Rien n'est persisté — un client déconnecté rate des
événements et compare les révisions à la reconnexion, comme avant.

## Ce qui n'est pas encore là

- **WebAuthn / clés de sécurité** en second facteur.
- **Web UI d'administration** : tout passe par Guiterm.
- **Emails** d'invitation : l'invitation est visible dans le client de
  l'invité ; rien n'est envoyé par courrier.
- **Vérification d'e-mail** à l'inscription.
- **Vault personnel** : pas de suppression de compte (ni du vault) pour
  l'instant.
