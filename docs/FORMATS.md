# Formats

De quoi relire ses données **sans GuiVault** : la cryptographie, les blobs,
et les trois fichiers où ils se trouvent (coffre local, sauvegarde du
serveur, export). Un développeur qui n'a que ce document et une
bibliothèque standard (Argon2id, HKDF-SHA-256, XChaCha20-Poly1305, X25519,
SHA-256) doit pouvoir écrire un lecteur. `gv recover`
(`crates/guivault-cli/src/recover.rs`, [`CLI.md`](CLI.md)) en est un, écrit
à partir de ce document.

Références de code : `crates/guivault-crypto/src/lib.rs` (Rust) et
`web/src/lib/crypto.ts` (TypeScript) produisent les mêmes octets ; des
vecteurs croisés le vérifient à chaque build (`examples/vectors.rs`,
`tests/web_interop.rs`, `crypto.test.ts`).

**Engagement de compatibilité** : un format publié reste lisible. Un
changement ajoute un nouvel octet de version (ou un nouveau `format`) ; il
ne change jamais le sens d'un existant.

## Notations

- `‖` : concaténation d'octets. Chaînes en UTF-8, sans terminateur.
- `\0` : l'octet nul, séparateur dans les AAD.
- `HKDF(ikm, info)` : HKDF-SHA-256, **sans sel**, 32 octets de sortie.
- Identifiants (vaults, items, pièces jointes) : des UUID choisis par le
  client, en minuscules avec tirets, tels qu'écrits dans le JSON — ce
  texte entre dans les AAD.
- `b64` : base64 standard avec remplissage ; `b64url` : base64 « URL »
  sans remplissage.

## Primitives

### Enveloppe symétrique (format `0x01`)

```
seal(clé, clair, aad) = 0x01 ‖ nonce (24 o, aléatoire) ‖ XChaCha20-Poly1305(clé, nonce, clair, aad)
```

Le chiffré inclut le tag de 16 octets à la fin. Tout ce qui suit est une
enveloppe de ce format, sauf mention contraire. Un octet de tête inconnu
est refusé sans tenter de déchiffrer.

### Dérivation depuis le mot de passe maître

```
master  = Argon2id v1.3 (mot de passe, sel 16 o, m_cost Kio, t_cost, p_cost, sortie 32 o)
auth    = HKDF(master, "guivault/v1/auth")   — envoyée au serveur, jamais utile pour déchiffrer
stretch = HKDF(master, "guivault/v1/enc")    — ouvre la user key
```

Paramètres par défaut : `m_cost = 65536` (64 Mio), `t_cost = 3`,
`p_cost = 1`. Bornes acceptées par les clients : `19456 ≤ m_cost ≤ 1048576`,
`2 ≤ t_cost ≤ 10`, `1 ≤ p_cost ≤ 8` — un lecteur devrait refuser de dériver
hors de ces bornes (un fichier trafiqué pourrait sinon imposer une
dérivation au rabais).

### Le compte

| Blob | Contenu | Sous |
|---|---|---|
| `protected_user_key` | user key (32 o, aléatoire) | `seal(stretch, user_key, "guivault/v1/user-key")` |
| `protected_private_key` | clé privée X25519 (32 o) | `seal(user_key, privée, "guivault/v1/private-key")` |
| `public_key` | clé publique X25519 (32 o), en clair | — |

Empreinte d'une clé publique : les 16 premiers octets de `SHA-256(clé)`,
en hexadécimal par groupes de 4 caractères séparés par `-`.

### Clé d'un vault (une enveloppe par membre)

Format 2, authentifié (106 octets) :

```
0x02 ‖ clé publique de l'expéditeur (32 o) ‖ seal(k, vault_key, "guivault/v2/vault-key\0" ‖ vault_id)
k = HKDF(X25519(privée du destinataire, publique de l'expéditeur),
         "guivault/v2/vault-key" ‖ publique de l'expéditeur ‖ publique du destinataire)
```

Un secret X25519 nul (clé d'ordre faible) est refusé. Pour son propre
vault, l'expéditeur et le destinataire sont la même clé.

Format 1, ancien (encore lu) : `0x01 ‖ boîte scellée libsodium`
(`crypto_box_seal` : X25519 éphémère, XSalsa20-Poly1305) de la vault key
vers la clé publique du membre.

Accès d'urgence : même format 2 sous le contexte
`"guivault/v2/emergency-key"` (dans le HKDF et l'AAD).

### Items et nom du vault

```
item      = seal(vault_key, JSON, "guivault/v1/item\0" ‖ vault_id ‖ "\0" ‖ item_id ‖ "\0" ‖ item_type)
nom       = seal(vault_key, nom UTF-8, "guivault/v1/item\0" ‖ vault_id ‖ "\0" ‖ "\0" ‖ "vault-name")
```

Le JSON d'un item : `{ "kind": <item_type>, <entité>: { "id": <item_id>, … } }`,
où l'entité porte le nom du type (`login`, `note`, `card`, `identity`,
`aws`, `host`, `group`, `snippet`, `key`, `icon`, `runbook`), sauf `apiKey`
pour `api-key` et `connection` pour `sql-connection`. Champs de chaque type :
[`ITEMS.md`](ITEMS.md) ; un lecteur doit conserver ce qu'il ne connaît pas.
Un item dont `kind` ou `id` ne correspond pas à sa ligne est à rejeter.

### Manifeste d'un vault

Scellé comme un item d'id `00000000-0000-0000-0000-000000000000` et de type
`manifest` ; JSON `{ "v": 1, "counter": n, "items": { <item_id>: b64url(SHA-256(chiffré de l'item)) } }`.
Il liste les items vivants et l'empreinte exacte de leur chiffré : un item
absent, en trop ou différent trahit un serveur (ou un fichier) qui a rejoué
ou retenu quelque chose ([`MANIFESTE.md`](MANIFESTE.md)).

### Pièces jointes

Chaque fichier a sa propre clé (32 o, aléatoire), écrite dans l'item :
`entité.attachments[] = { id, name, size (en clair), mime?, key: b64 }`.
Le fichier est découpé en morceaux de 1 048 576 octets en clair (le dernier
plus court ; un fichier vide fait un morceau vide) :

```
morceau i = seal(clé du fichier, octets, "guivault/v1/attachment\0" ‖ id ‖ "\0" ‖ i ‖ "\0" ‖ (1 si dernier, sinon 0))
```

`i` et le drapeau sont écrits en décimal ASCII. Nombre de morceaux :
`max(1, ⌈size / 1048576⌉)`.

### Autres blobs

| Blob | Clé | AAD |
|---|---|---|
| Réglages synchronisés (JSON) | user key | `guivault/v1/user-settings` |
| Fiche de l'auteur d'un lien de partage | user key | `guivault/v1/send-owner\0` ‖ send_id |
| Contenu d'un lien de partage | `HKDF(secret ‖ [clé du mot de passe], "guivault/v1/send/enc")` | `guivault/v1/send\0` ‖ send_id |
| Morceau du fichier d'un lien | même clé | `guivault/v1/send-file\0` ‖ send_id ‖ `\0` ‖ i ‖ `\0` ‖ dernier |
| User key sous une passkey | `HKDF(sortie PRF, "guivault/v1/passkey-key")` | `guivault/v1/passkey-user-key\0` ‖ credential_id |

Le secret d'un lien (16 o) est dans le fragment de l'URL,
`#/send/<id>/<b64url(secret)>` ; la clé de son mot de passe facultatif est
`HKDF(Argon2id(mot de passe, sel du lien), "guivault/v1/send/password")`.

## Coffre local

Un dossier :

```
coffre.json                         tout, sauf les fichiers
attachments/<vault>/<pièce>/<i>.bin les morceaux chiffrés des pièces jointes
backups/                            copies datées de coffre.json (même format)
.lock                               verrou ; vide
```

`coffre.json` (format `1`) :

```json
{
  "format": 1,
  "id": "<uuid du coffre>",
  "created_at": "2026-10-25T12:00:00Z",
  "account": { "kdf": { "m_cost": 65536, "t_cost": 3, "p_cost": 1 }, "kdf_salt": "<b64>",
               "protected_user_key": "<b64>", "public_key": "<b64>", "protected_private_key": "<b64>" },
  "settings": { "blob": "<b64>", "revision": 1, "updated_at": "…" },
  "vaults": [{
    "id": "<uuid>", "kind": "personal", "name_enc": "<b64>", "wrapped_vault_key": "<b64>",
    "revision": 12, "created_at": "…", "updated_at": "…",
    "manifest": "<b64, facultatif>", "manifest_revision": 0,
    "items": [{ "id": "<uuid>", "item_type": "login", "revision": 3, "ciphertext": "<b64>",
                "created_at": "…", "updated_at": "…", "deleted_at": null }],
    "versions": [{ "item_id": "…", "revision": 2, "item_type": "login", "ciphertext": "<b64>",
                   "written_at": "…", "replaced_at": "…" }],
    "attachments": [{ "id": "…", "item_id": "…", "size": 1048617, "chunks": 1, "complete": true, "created_at": "…" }]
  }]
}
```

Pas de clé d'authentification : le mot de passe se vérifie à l'ouverture de
la user key (tag AEAD). Un item avec `deleted_at` est une pierre tombale
(`ciphertext` vide) ou un élément de la corbeille ; `versions` est
l'historique. Les champs inconnus sont à conserver. Un `format` plus grand
que celui qu'on connaît est à refuser.

## Sauvegarde du serveur

`guivault backup create` écrit `guivault-AAAAMMJJ-….jsonl.gz` : un gzip de
lignes `table\tJSON`, une ligne par ligne de la base.

- Première ligne : `GUIVAULT-BACKUP\t{ "format": 1, "server_version", "schema", "created_at", "tables": […] }`.
- Puis chaque table, dans l'ordre des clés étrangères (`users`, `vaults`,
  `vault_members`, `items`, `item_versions`, `attachments`,
  `attachment_chunks`, …), chaque ligne telle que PostgreSQL la rend
  (`row_to_json`) : un `bytea` est une chaîne `\x` suivie de l'hexadécimal,
  un `timestamptz` une date RFC 3339.
- Dernière ligne : `END\t{ <table>: { "rows": n, "sha256": "…" } }`.

Pour relire le coffre d'un compte :

1. `users` : la ligne de son `email` donne `id`, `kdf_m_cost`,
   `kdf_t_cost`, `kdf_p_cost`, `kdf_salt`, `protected_user_key`,
   `protected_private_key`.
2. `vault_members` : les lignes de son `user_id` donnent `vault_id` et
   `wrapped_vault_key`.
3. `vaults` : `name_enc`, `kind`, `manifest`, `manifest_revision`.
4. `items` : `vault_id`, `id`, `item_type`, `ciphertext`, `deleted_at`.
5. `attachment_chunks` : `vault_id`, `attachment_id`, `idx`, `ciphertext`.

Les vaults reçus par un accès d'urgence sont dans `emergency_vault_keys`
(format 2, contexte d'urgence) ; `gv recover` ne les relit pas.

## Exports

**En clair** (`Outils › Exporter`, JSON) :

```json
{ "format": "guivault-export", "version": 1, "exportedAt": "…",
  "vault": { "id": "…", "name": "Personnel" },
  "groups": [ <entités group> ], "items": [ <JSON d'item, sans "attachments"> ] }
```

**Protégé par mot de passe** :

```json
{ "format": "guivault-export-encrypted", "version": 1,
  "kdf": { "m_cost": 65536, "t_cost": 3, "p_cost": 1 }, "kdf_salt": "<b64>", "blob": "<b64>" }
```

`blob = seal(HKDF(Argon2id(mot de passe, kdf_salt, kdf), "guivault/v1/export"), export en clair, "guivault/v1/export")`.
Les pièces jointes ne sont pas dans les exports.

CSV : colonnes de Bitwarden, identifiants et notes seulement
([`ITEMS.md`](ITEMS.md)).
