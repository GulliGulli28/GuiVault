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
`unknown_item`, `unknown_grant`, `not_owner`, `send_unavailable`, `invalid_send_key`,
`send_id_taken`, `send_too_large`, `too_many_sends`, `already_designated`,
`already_accepted`, `not_accepted`, `already_requested`, `not_requested`,
`already_granted`, `emergency_not_granted`, `self_grant`, `no_vaults`,
`duplicate_vault`, `lookups_disabled`, `lookup_failed`, `totp_required`, `owns_shared_vaults`,
`account_disabled`, `quota_exceeded`, `ip_not_allowed`, `self_action`, `target_is_admin`,
`backups_disabled`, `backup_running`, `mail_disabled`, `mail_failed`, `manifest_required`,
`manifest_conflict`, `manifest_too_large`, `invalid_*`, `internal`.

Partout : `403 ip_not_allowed` si l'adresse du client n'est pas dans
`GUIVAULT_ALLOWED_IPS` (sauf `GET /health`).

## Santé

| | |
|---|---|
| `GET /health` | `{ status, protocol_version, server_version, registration, send_max_days, health_lookups }` — `send_max_days` : durée de vie maximale d'un lien de partage, `0` (ou absent, serveur plus ancien) si les liens sont désactivés ; `health_lookups` : le serveur relaie les recherches du rapport de santé |

## Authentification (rate-limitées par IP)

| | |
|---|---|
| `POST /auth/prelogin` | `{ email }` → `{ kdf, kdf_salt }` (déterministe même pour un inconnu) |
| `POST /auth/register` | matériel de compte + `personal_vault` → `201` `LoginResponse`. Hors `open` : adresse de `GUIVAULT_ALLOWED_EMAILS`, inscription ouverte par un administrateur (consommée), ou — en `invite_only` — invitation de vault en attente ; sinon `403 invitation_required` (ou `forbidden` en `closed`) |
| `POST /auth/login` | `{ email, auth_key, device_name? }` → `200` `LoginResponse` (`access_token`, `refresh_token`, `user`, `protected_user_key`, `protected_private_key`) — ou `202` `TotpChallenge { totp_token }` si le compte a un second facteur ; `403 account_disabled` si un administrateur l'a désactivé (dit seulement avec le bon mot de passe) |
| `POST /auth/totp/verify` | `{ totp_token, code }` → `LoginResponse` (code à 6 chiffres ou code de récupération ; 5 essais, 5 min) |
| `POST /auth/refresh` | `{ refresh_token }` → `TokenPair` (rotation) |
| `GET /sends/{id}/access` | sans compte : `SendInfo { password?: { kdf, salt }, expires_at, views_left }`, ou `404 send_unavailable` (inconnu, expiré, épuisé, supprimé — ou liens désactivés). Ne consomme rien |
| `POST /sends/{id}/access` | sans compte : `{ access_key }` → `SendContent { ciphertext, expires_at, views_left }` et une vue consommée (la dernière efface le chiffré), ou `403 invalid_send_key` (lien incomplet, mauvais mot de passe) |

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
| `GET /events` | flux SSE de `ServerEvent` (`vault_changed`, `invitation_received`, `membership_changed`, `settings_changed`, `emergency_changed`) — dit *que* quelque chose a changé, le client resynchronise |
| `GET /users/me` | `UserProfile` (`is_admin` : administrateur du serveur, absent sinon) |
| `DELETE /users/me` | `{ auth_key, totp_code? }` → `204`. Supprime le compte, ses vaults (personnel et partagés dont il est le seul membre), sessions, réglages, second facteur, liens de partage, accès d'urgence (dans les deux sens) et les invitations qu'il a envoyées ; révoque celles adressées à son e-mail. Le journal d'audit garde ses lignes, sans IP. `401 invalid_credentials` (mot de passe), `400 totp_required` / `401 invalid_code` si le second facteur est actif, `409 owns_shared_vaults` `{ vaults: [id] }` tant qu'il possède un vault partagé avec d'autres membres (transférer la propriété ou le supprimer d'abord) |
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
| `POST /vaults/{id}/rotate-key` | admin | `RotateVaultKeyRequest` → `Vault` ; `versions` : l'historique et la corbeille re-chiffrés, **tous** (`GET /vaults/{id}/versions`), sinon `400 incomplete_rotation` — absent, ils sont effacés ; `emergency` (propriétaire seulement, sinon `400 not_owner`) : `[{ grant_id, wrapped_vault_key }]` pour **tous** les contacts d'urgence qui couvrent le vault — absent, leurs enveloppes sont marquées à renouveler (`has_key: false`) |
| `GET /vaults/{id}/audit?limit=&before=` | admin | journal |

## Membres

| | Rôle | |
|---|---|---|
| `GET /vaults/{id}/members` | membre | `[VaultMember]` (avec `fingerprint`) |
| `POST /vaults/{id}/members` | admin | `{ user_id, role, wrapped_vault_key }` (ajout direct d'un utilisateur existant) |
| `PATCH /vaults/{id}/members/{user_id}` | admin | `{ role }` |
| `DELETE /vaults/{id}/members/{user_id}` | admin | (puis rotation conseillée) |
| `POST /vaults/{id}/members/{user_id}/transfer` | owner | transfère la propriété (l'ancien propriétaire ne confie plus ce vault à ses contacts d'urgence) |

## Invitations

| | Rôle | |
|---|---|---|
| `POST /vaults/{id}/invitations` | admin | `{ email, role, wrapped_vault_key? }` → `201` `Invitation` |
| `GET /vaults/{id}/invitations` | admin | toutes (avec `invitee_public_key` / `invitee_fingerprint` si inscrit) |
| `GET /invitations` | invité | mes invitations en attente, avec `wrapped_vault_key` (l'enveloppe qui m'est adressée, pour voir qui me remet la clé avant d'accepter) quand l'inviteur l'a jointe — aussi dans `/sync` |
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
| `DELETE /vaults/{id}/items/{item_id}[?moved=true]` | writer | tombale ; la dernière version va dans la corbeille, sauf `moved=true` (l'item part vers un autre vault, même id) |
| `GET /vaults/{id}/items/{item_id}/versions` | membre | `[ItemVersion]`, du plus récent au plus ancien (`GUIVAULT_ITEM_HISTORY` gardées) |
| `GET /vaults/{id}/versions` | membre | toutes les `ItemVersion` du vault (ce qu'une rotation re-chiffre) |
| `GET /vaults/{id}/trash` | membre | `[TrashedItem]` : supprimés depuis moins de `GUIVAULT_TRASH_DAYS` jours, avec leur dernière version et `expires_at` |
| `DELETE /vaults/{id}/trash/{item_id}` | writer | supprime définitivement un item de la corbeille (404 s'il est vivant) |
| `DELETE /vaults/{id}/trash` | writer | vide la corbeille |

Restaurer une version (historique ou corbeille) : la renvoyer **telle
quelle** par `PUT` — même clé, même AAD —, avec la révision courante de
l'item en `base_revision`, ou sans pour un item de la corbeille (recréé).
L'élément remplacé passe à son tour dans l'historique.

## Administration du serveur

Réservé aux comptes `is_admin` (`403 forbidden` sinon), rôle donné depuis le
shell du serveur (`guivault admin grant|revoke|list`), jamais par l'API ;
`403 ip_not_allowed` hors de `GUIVAULT_ADMIN_ALLOWED_IPS`. Des métadonnées,
jamais un contenu. Chaque action écrit une ligne d'audit `admin.*`.

| | |
|---|---|
| `GET /admin/overview` | `AdminOverview` : comptes (désactivés, admins), vaults (partagés), items et octets vivants, liens, sessions actives, inscriptions ouvertes, mode d'inscription, quota par défaut, plages d'IP, `mail_enabled` / `mail_error` |
| `GET /admin/users` | `[AdminUserInfo]` : e-mail, dates, `disabled_at`, `is_admin`, `totp_enabled`, `last_seen_at`, sessions actives, vaults possédés / rejoints, items et octets dans les vaults possédés, `quota_bytes` (propre, `null` = celui du serveur, `0` = aucun), `effective_quota_bytes` |
| `POST /admin/users/{id}/disable` | → `AdminUserInfo`. Plus de connexion (`account_disabled`), sessions révoquées ; rien d'effacé. `400 self_action` sur soi, `409 target_is_admin` sur un administrateur |
| `POST /admin/users/{id}/enable` | → `AdminUserInfo` |
| `PUT /admin/users/{id}/quota` | `{ quota_bytes: n \| 0 \| null }` → `AdminUserInfo` (soi compris) |
| `DELETE /admin/users/{id}` | → `204`. Comme `DELETE /users/me`, sans mot de passe ; ses vaults partagés avec d'autres passent au membre le mieux placé (compte actif, rôle le plus haut, le plus ancien — `vault.transfer`) au lieu de bloquer. Mêmes refus que `disable` |
| `GET /admin/registrations` | `[RegistrationInvite { email, invited_by, created_at, expires_at }]` (non expirées) |
| `POST /admin/registrations` | `{ email, days? }` (1–90, 14 par défaut) → `201`. Autorise cette adresse à s'inscrire une fois, quel que soit le mode ; renouvelle si elle l'était. `409 email_taken` si le compte existe |
| `DELETE /admin/registrations/{email}` | → `204` |
| `GET /admin/backups` | `BackupsStatus { enabled, dir, interval_hours, keep, restore_check, running, runs: [BackupRun] }` — les 20 derniers passages (`triggered_by` `schedule`/`admin`/`shell`, fichier, octets, lignes, SHA-256, `verified` `file`/`restore`, `error`) |
| `POST /admin/mail-test` | → `204` : un e-mail d'essai à l'administrateur, **attendu** (le seul) ; `502 mail_failed` avec la réponse du serveur SMTP, `400 mail_disabled` sans e-mails (ou réglage illisible) |
| `POST /admin/backups` | → `202` : une sauvegarde démarre en arrière-plan (suivre `GET`). `400 backups_disabled` sans `GUIVAULT_BACKUP_DIR`, `409 backup_running` |

**E-mails** (facultatifs, `GUIVAULT_SMTP_URL`) : aucune route n'attend un
envoi ni n'échoue à cause de lui, sauf l'essai ci-dessus. Partent après la
transaction : `POST /vaults/{id}/invitations` (à l'invité),
`POST /admin/registrations` (à l'adresse), `POST /auth/login` et
`/auth/totp/verify` depuis une IP jamais vue du compte en 90 jours (au
titulaire), `POST /auth/password`, `/auth/totp/enable|disable`,
`/admin/users/{id}/disable`, les suppressions de compte (au titulaire),
`/emergency` et ses étapes `accept`, `request`, `approve`, `reject` (à
l'autre partie) — et, sans route, l'ouverture d'un accès d'urgence au bout
du délai (aux deux, une fois, vérifiée toutes les cinq minutes). Au plus 30 e-mails par heure vers d'autres adresses par
compte.

**Quota** : `PUT …/items/{id}` qui ferait dépasser au propriétaire du vault
son quota (chiffrés vivants de tous ses vaults, ni historique ni tombales)
répond `507 quota_exceeded` `{ used, quota }` — quel que soit le membre qui
écrit. Une écriture qui ne grossit pas passe toujours ; la rotation de clé
n'est jamais bloquée.

## Manifeste de vault

La liste authentifiée des items d'un vault (`docs/MANIFESTE.md`,
`guivault_crypto::manifest`) : un blob chiffré sous la clé du vault que le
serveur garde sans le lire, avec sa révision. Un vault sans manifeste se
comporte comme avant ; dès qu'il en a un, **toute écriture doit
l'accompagner**.

| | |
|---|---|
| `GET /vaults/{id}/items` | `ItemsPage` gagne `manifest?: { ciphertext, revision }`, lu dans le même instantané que les items et la révision (idem `GET /emergency/{id}/vaults/{vault}/items`) |
| `PUT /vaults/{id}/items/{item}` | `manifest?: { ciphertext, base_revision }` : le manifeste avec cet item, appliqué dans la même transaction. `409 manifest_required` s'il manque sur un vault qui en a un ; `409 manifest_conflict` `{ current }` si `base_revision` n'est plus la révision du manifeste ; `413 manifest_too_large` au-delà de 8 × `GUIVAULT_MAX_ITEM_BYTES`. Le type d'item `manifest` est réservé (`400 invalid_item_type`) |
| `DELETE /vaults/{id}/items/{item}` | corps JSON facultatif `{ manifest? }` : le manifeste sans cet item ; mêmes refus |
| `GET /vaults/{id}/manifest` | `{ ciphertext, revision }` ou `null` (membre) |
| `PUT /vaults/{id}/manifest` | `{ ciphertext, base_revision, vault_revision }` → `{ ciphertext, revision }` : créer (base 0) ou réécrire d'après ce que sert le serveur. Écrivain et plus ; `409 revision_mismatch` si le vault a bougé depuis `vault_revision`, `409 manifest_conflict` si la base est dépassée. Monte la révision du vault (les autres clients relisent) |
| `POST /vaults/{id}/rotate-key` | `manifest?` : re-scellé sous la nouvelle clé ; obligatoire si le vault en a un |

## Rapport de santé (relais)

Le rapport se calcule dans le client ; deux recherches seulement passent par
le serveur, qui les relaie (CSP de l'interface fermée aux tiers, adresse
des utilisateurs cachée aux services). `404 lookups_disabled` avec
`GUIVAULT_HEALTH_LOOKUPS=false`, `502 lookup_failed` si le service ne répond
pas.

| | |
|---|---|
| `GET /lookups/pwned-passwords/{prefix}` | authentifié ; `prefix` = les 5 premiers caractères hexadécimaux du SHA-1 d'un mot de passe (`400 invalid_prefix` sinon) → `text/plain`, la réponse « range » de Have I Been Pwned telle quelle (`SUFFIXE:NOMBRE` par ligne, avec remplissage : `Add-Padding`) — le client y cherche son suffixe |
| `GET /lookups/2fa-directory` | authentifié → `[TwoFactorSite { name, domains, documentation? }]` : les sites qui acceptent un code TOTP (2fa.directory, gardée 24 h) |

## Liens de partage

Un contenu chiffré côté client sous une clé tirée d'un secret qui ne voyage
que dans le fragment de l'URL : `https://<serveur>/#/send/<id>/<secret>`
(16 octets, base64url). Voir « Chiffrement d'un lien » plus bas ; les deux
routes d'ouverture, sans compte, sont plus haut (rate-limitées par IP).

| | |
|---|---|
| `POST /sends` | `CreateSendRequest { id, ciphertext, access_hash, owner_blob, password?, max_views?, expires_in_secs }` → `201` `SendSummary`. Une heure à `GUIVAULT_SEND_MAX_DAYS` jours (`400 invalid_expiry`), 1 à 1000 vues (`invalid_max_views`), taille d'un item au plus (`413 send_too_large`), 100 liens ouvrables par compte (`409 too_many_sends`) ; `403` si les liens sont désactivés |
| `GET /sends` | mes liens, du plus récent au plus ancien : `[SendSummary { id, owner_blob, has_password, max_views, views, created_at, expires_at, last_viewed_at, available }]` — expirés compris jusqu'à leur effacement (horaire) |
| `DELETE /sends/{id}` | supprime (`404` si ce n'est pas le mien) |

## Accès d'urgence

Le donneur désigne un contact inscrit et lui enveloppe la clé de vaults dont
il est **propriétaire** (`wrap_emergency_key`, ci-dessous). Le contact
accepte, puis peut demander l'accès : il l'obtient au bout de `wait_days`
jours sans refus, ou dès que le donneur accorde. `EmergencyGrant { id,
grantor, grantee, wait_days, status, requested_at, access_at, vaults:
[{ vault_id, has_key }], created_at }`, `status` ∈ `invited`, `accepted`,
`requested`, `granted`. Chaque changement prévient les deux parties
(`emergency_changed`).

| | Qui | |
|---|---|---|
| `GET /emergency` | tous | `{ granted_by_me, granted_to_me }` |
| `POST /emergency` | donneur | `{ grantee_id, wait_days, vaults: [{ vault_id, wrapped_vault_key }] }` → `201` ; 1 à 90 jours (`invalid_wait`), au moins un vault (`no_vaults`), tous possédés (`403`), un seul par contact (`409 already_designated`) |
| `PATCH /emergency/{id}` | donneur | `{ wait_days?, vaults? }` — `vaults` remplace l'ensemble (c'est aussi ainsi qu'on renouvelle une enveloppe marquée `has_key: false`) |
| `DELETE /emergency/{id}` | l'un ou l'autre | retirer le contact, ou renoncer |
| `POST /emergency/{id}/accept` | contact | `invited` → `accepted` |
| `POST /emergency/{id}/request` | contact | `accepted` → `requested` (`access_at` = maintenant + délai) |
| `POST /emergency/{id}/approve` | donneur | accorde sans attendre |
| `POST /emergency/{id}/reject` | l'un ou l'autre | le donneur refuse une demande ou reprend la main sur un accès accordé ; le contact retire sa demande — retour à `accepted` |
| `GET /emergency/{id}/vaults` | contact, `granted` | `[EmergencyVault { id, kind, name_enc, wrapped_vault_key, revision, … }]` : les vaults confiés dont le donneur est encore propriétaire et dont l'enveloppe est à jour ; sinon `403 emergency_not_granted`. La première lecture de chaque vault après la demande laisse `emergency.access` dans son journal |
| `GET /emergency/{id}/vaults/{vault_id}/items` | contact, `granted` | `{ items, revision }` (vivants), lecture seule |

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

Pour l'accès d'urgence, même format 2 sous un autre contexte :
`"guivault/v2/emergency-key"` à la place de `"guivault/v2/vault-key"`, dans
le HKDF comme dans l'AAD. Une enveloppe d'urgence ne s'ouvre pas comme
enveloppe de membre (ni l'inverse) : le serveur ne peut pas l'installer en
appartenance pour ouvrir le vault sans attendre. Le contact vérifie que
`sender_pk` est bien celle du donneur, dont il a épinglé l'empreinte en
acceptant.

### Chiffrement d'un lien de partage (côté client)

```
secret      = 16 octets aléatoires, dans le fragment de l'URL (base64url)
pw_key      = HKDF-SHA256(Argon2id(mot de passe, salt, kdf), info = "guivault/v1/send/password")   (facultatif)
ikm         = secret ‖ pw_key?
enc_key     = HKDF-SHA256(ikm, info = "guivault/v1/send/enc")
access_key  = HKDF-SHA256(ikm, info = "guivault/v1/send/access")      → présentée à POST /sends/{id}/access
access_hash = SHA-256(access_key)                                      → seul gardé par le serveur
ciphertext  = 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(enc_key, nonce, json, aad = "guivault/v1/send\0" ‖ id)
owner_blob  = même enveloppe sous la user key, aad = "guivault/v1/send-owner\0" ‖ id   ({ name, secret, kind })
```

Le contenu (`json`) est `{ "v": 1, "kind": "text", "name", "text" }` ou
`{ "v": 1, "kind": "item", "payload": <Payload d'un secret> }` (sans dossier,
tags ni favori). Les paramètres `kdf` viennent du serveur : le client refuse
ceux hors de `KdfParams::is_sane`.
