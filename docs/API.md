# API

Base : `/api/v1`. JSON partout. Authentification : `Authorization: Bearer
<access_token>`. Les champs binaires sont en base64 standard. Les types
exacts sont dans `crates/guivault-protocol/src/lib.rs` — ce fichier est la
référence, la page-ci un résumé. Tout ce qui n'est pas sous `/api/` sert
l'interface web embarquée (`web/dist`, routage côté client), voir
`README.md`.

Erreurs : `{ "code": "…", "message": "…" }` (+ champs selon le code, ex.
`current` sur `revision_mismatch`). Codes stables :
`unauthorized`, `invalid_credentials`, `forbidden`, `not_found`,
`invitation_required`, `email_taken`, `vault_id_taken`, `revision_mismatch`,
`item_type_changed`, `item_too_large`, `already_member`,
`already_invited`, `not_pending`, `invitee_has_no_key`,
`invitee_not_registered`, `totp_already_enabled`, `totp_not_setup`,
`totp_not_enabled`, `invalid_code`, `challenge_expired`, `incomplete_rotation`, `unknown_member`,
`unknown_item`, `invalid_*`, `internal`.

## Santé

| | |
|---|---|
| `GET /health` | `{ status, protocol_version, server_version, registration }` |

## Authentification (rate-limitées par IP)

| | |
|---|---|
| `POST /auth/prelogin` | `{ email }` → `{ kdf, kdf_salt }` (déterministe même pour un inconnu) |
| `POST /auth/register` | matériel de compte + `personal_vault` → `201` `LoginResponse` |
| `POST /auth/login` | `{ email, auth_key, device_name? }` → `200` `LoginResponse` (`access_token`, `refresh_token`, `user`, `protected_user_key`, `protected_private_key`) — ou `202` `TotpChallenge { totp_token }` si le compte a un second facteur |
| `POST /auth/totp/verify` | `{ totp_token, code }` → `LoginResponse` (code à 6 chiffres ou code de récupération ; 5 essais, 5 min) |
| `POST /auth/refresh` | `{ refresh_token }` → `TokenPair` (rotation) |

## Session (authentifié)

| | |
|---|---|
| `POST /auth/logout` | révoque la session courante |
| `POST /auth/password` | `ChangePasswordRequest` → `204`, autres sessions révoquées |
| `GET /auth/sessions` | `[Session]` |
| `DELETE /auth/sessions/{id}` | révoque |
| `GET /auth/totp` | `{ enabled }` |
| `POST /auth/totp/setup` | → `{ secret, otpauth_url }` (en attente jusqu'à `enable`) |
| `POST /auth/totp/enable` | `{ code }` → `{ recovery_codes }` (8, montrés une seule fois ; autres sessions révoquées) |
| `POST /auth/totp/disable` | `{ code }` (TOTP ou récupération) → `204` |
| `GET /events` | flux SSE de `ServerEvent` (`vault_changed`, `invitation_received`, `membership_changed`, `settings_changed`) — dit *que* quelque chose a changé, le client resynchronise |
| `GET /users/me` | `UserProfile` |
| `GET /users/me/settings` | `UserSettings` (`{ blob, revision, updated_at }`) ou `null` si aucun appareil n'en a envoyé |
| `PUT /users/me/settings` | `{ blob, base_revision }` → `UserSettings`, ou `409` `{ code: "revision_mismatch", current }` si `base_revision` n'est pas la dernière (`null` = « je n'en ai lu aucune »). `blob` = `seal_user_settings(user_key, json)`, 64 Kio max. Prévient les autres sessions (`settings_changed`) |
| `GET /users/me/audit?limit=&before=` | mes actions |
| `GET /users/lookup?email=` | `{ id, email, public_key, fingerprint }` |
| `GET /sync` | `{ user, vaults, invitations, server_time }` |

## Vaults

| | Rôle | |
|---|---|---|
| `GET /vaults` | membre | `[Vault]` |
| `POST /vaults` | — | `{ id, name_enc, wrapped_vault_key }` → `201` `Vault` (créateur = owner) |
| `GET /vaults/{id}` | membre | `Vault` |
| `PATCH /vaults/{id}` | admin | `{ name_enc }` |
| `DELETE /vaults/{id}` | owner | supprime tout (pas le personnel) |
| `POST /vaults/{id}/leave` | membre non-owner | |
| `POST /vaults/{id}/rotate-key` | admin | `RotateVaultKeyRequest` → `Vault` |
| `GET /vaults/{id}/audit?limit=&before=` | admin | journal |

## Membres

| | Rôle | |
|---|---|---|
| `GET /vaults/{id}/members` | membre | `[VaultMember]` (avec `fingerprint`) |
| `POST /vaults/{id}/members` | admin | `{ user_id, role, wrapped_vault_key }` (ajout direct d'un utilisateur existant) |
| `PATCH /vaults/{id}/members/{user_id}` | admin | `{ role }` |
| `DELETE /vaults/{id}/members/{user_id}` | admin | (puis rotation conseillée) |
| `POST /vaults/{id}/members/{user_id}/transfer` | owner | transfère la propriété |

## Invitations

| | Rôle | |
|---|---|---|
| `POST /vaults/{id}/invitations` | admin | `{ email, role, wrapped_vault_key? }` → `201` `Invitation` |
| `GET /vaults/{id}/invitations` | admin | toutes (avec `invitee_public_key` / `invitee_fingerprint` si inscrit) |
| `GET /invitations` | invité | mes invitations en attente |
| `DELETE /invitations/{id}` | admin | révoque |
| `POST /invitations/{id}/accept` | invité | → `accepted` (clé présente) ou `awaiting_key` |
| `POST /invitations/{id}/decline` | invité | |
| `POST /invitations/{id}/complete` | admin | `{ wrapped_vault_key }` → membre si `awaiting_key` |

## Items

| | Rôle | |
|---|---|---|
| `GET /vaults/{id}/items[?since=N]` | membre | `{ items, revision }` — sans `since` : tous les vivants ; avec : modifiés après N, tombales comprises |
| `GET /vaults/{id}/items/{item_id}` | membre | `Item` |
| `PUT /vaults/{id}/items/{item_id}` | writer | `{ item_type, ciphertext, base_revision? }` → `201`/`200` `Item`, ou `409` `{ code: "revision_mismatch", current }` |
| `DELETE /vaults/{id}/items/{item_id}` | writer | tombale |

### Chiffrement d'un item (côté client)

```
aad        = "guivault/v1/item\0" ‖ vault_id ‖ "\0" ‖ item_id ‖ "\0" ‖ item_type
ciphertext = 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(vault_key, nonce, plaintext, aad)
```

`item_type` est libre (`[A-Za-z0-9._-]{1,64}`). Guiterm et l'interface web
utilisent `host`, `group`, `key`, `snippet`, `sql-connection`, `icon`, avec
pour contenu le JSON de `termius_core::guivault::entity::Payload`
(`{ "kind": "<item_type>", … }`, id de l'entité = id de l'item). Le serveur
ne le voit jamais.

### Enveloppe d'une clé de vault (`wrapped_vault_key`, côté client)

```
format 2 (écrit) : 0x02 ‖ sender_pk(32) ‖ 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(k, nonce, vault_key, aad)   → 106 octets
  k   = HKDF-SHA256(X25519(sender_sk, recipient_pk), info = "guivault/v2/vault-key" ‖ sender_pk ‖ recipient_pk)
  aad = "guivault/v2/vault-key\0" ‖ vault_id
format 1 (lu)    : 0x01 ‖ boîte scellée libsodium (pk éphémère ‖ XSalsa20-Poly1305)                       →  81 octets
```

Le serveur n'accepte que ces deux tailles (`invalid_blob` sinon) et ne peut
rien vérifier d'autre : c'est le destinataire qui authentifie l'expéditeur
(`sender_pk`, dont il compare l'empreinte à celles qu'il a vérifiées).
