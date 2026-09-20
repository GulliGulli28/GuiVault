# Items : formats en clair

Le serveur ne voit d'un item que son `item_type` et un blob. Ce que le blob
contient est une affaire de clients : cette page fixe les formats que
l'interface web écrit, pour que Guiterm (et tout autre client) les lise.

Règles communes à tous les types :

- Le JSON est en camelCase, enveloppé : `{ "kind": "<item_type>", "<kind>": { … } }`
  (plus, selon le type, des champs à côté de l'entité : `secrets`, `content`…).
- `kind` **est** l'`item_type` de l'API, et l'`id` de l'entité **est** l'id
  de l'item (il est dans l'AAD : un client ignore un item dont les deux
  divergent).
- `groupId` désigne un item `group` du même vault (les dossiers de Guiterm) ;
  `null` = racine. `tags` est une liste de chaînes.
- Un client conserve les champs qu'il ne connaît pas et les réécrit tels
  quels (`[extra: string]: unknown` côté TypeScript, `#[serde(flatten)]
  extra` côté Rust). Un champ absent prend sa valeur par défaut.

## Entités Guiterm

`host`, `group`, `key`, `snippet`, `sql-connection`, `icon` : le JSON de
`termius_core::guivault::entity::Payload`, décrit dans le dépôt Guiterm.
L'interface web les lit et les écrit (`web/src/lib/types.ts`, formulaires
dans `web/src/components/forms/`) ; ce dépôt vérifie que ce qu'elle produit
est relu par `termius-core` (voir `CLAUDE.md`, section vérification).

## Secrets (gestionnaire de mots de passe)

`login`, `note`, `card`, `identity` : définis dans
[`crates/guivault-items`](../crates/guivault-items/src/lib.rs) (Rust) et
`web/src/lib/types.ts` (TypeScript). Modelés sur les types de Bitwarden pour
que l'import et l'export soient sans perte. Les fixtures
`crates/guivault-items/tests/web-items.json` sont écrites par les tests du
web et relues par le crate : les deux définitions ne peuvent pas diverger
sans qu'un test le dise.

Champs communs (`SecretBase`) : `id`, `name`, `groupId`, `tags`,
`favorite?`, `notes?`, `fields?` (champs libres `{ name, value, type:
text|hidden|boolean }`).

| `kind` | Champs propres |
|---|---|
| `login` | `username`, `password`, `uris[] { uri, match? }`, `totp` (URI `otpauth://` ou secret base32), `passkeys[]`, `passwordHistory[] { password, changedAt }` |
| `note` | `content` |
| `card` | `cardholderName`, `brand`, `number`, `expMonth`, `expYear`, `code` |
| `identity` | `title`, `firstName`, `middleName`, `lastName`, `username`, `company`, `ssn`, `passportNumber`, `licenseNumber`, `email`, `phone`, `address1..3`, `city`, `state`, `postalCode`, `country` |

Une **passkey** est le `fido2Credentials` de Bitwarden : `credentialId`,
`keyType`, `keyAlgorithm`, `keyCurve`, `keyValue` (clé privée PKCS#8 en
base64 — le secret), `rpId`, `rpName?`, `userHandle`, `userName?`,
`userDisplayName?`, `counter`, `discoverable`, `createdAt`. L'interface web
les stocke, les importe, les exporte et les affiche ; une page web ne peut
pas jouer l'authentificateur WebAuthn, donc ni en créer ni s'en servir.
C'est le rôle d'un client natif (Guiterm) ou d'une extension.

## Exports

- **GuiVault JSON** (`format: "guivault-export"`, `version: 1`) : `vault
  { id, name }`, `groups[]` (les dossiers, pour reconstruire l'arborescence)
  et `items[]` (des payloads tels quels, tous types confondus).
- **GuiVault JSON chiffré** (`format: "guivault-export-encrypted"`) : `kdf`,
  `kdf_salt` (base64), `blob` (base64) = `seal(key, json, "guivault/v1/export")`
  avec `key = HKDF(Argon2id(mot de passe, sel), "guivault/v1/export")`.
  Réimportable ici ; lisible par tout client qui a `guivault-crypto`.
- **CSV Bitwarden** : identifiants et notes seulement (le format n'a pas de
  colonnes pour le reste).

Imports reconnus : les deux formats ci-dessus, Bitwarden JSON (en clair ou
protégé par mot de passe — PBKDF2 ou Argon2id, `EncString` type 2) et CSV,
et les CSV de Chrome, Firefox, LastPass, KeePassXC ou tout CSV dont les
colonnes se reconnaissent (`web/src/lib/importers.ts`).

## Intégrer à Guiterm

Le jour où Guiterm affiche les secrets, dans l'ordre :

1. **Fait** (Guiterm dépend de `guivault-items`) : `sync.rs` reconnaît
   `SecretItem::is_secret_type` et passe sans bruit — ni avertissement,
   ni état de synchro. Le point qui compte : un item qui entrerait dans
   `state.items` sans exister localement serait pris pour une suppression
   locale et **effacé côté serveur** à la synchro suivante. Tant que
   Guiterm ne stocke pas les secrets, il ne doit pas les voir ; le test
   `web_secrets_are_left_alone_by_sync` le garantit.
2. **Ajouter à `Payload`** des variantes qui délèguent : `Login { login:
   guivault_items::Login }`, etc. `to_json`/`from_json` marchent tels quels
   (`serde(tag = "kind")` des deux côtés) — mais seulement une fois
   l'étape 3 en place, pour la raison ci-dessus : `collect` doit alors les
   émettre et `apply` les ranger.
3. **Stocker localement** : les secrets n'ont pas leur place dans
   `workspace.json` (en clair sur disque) — les garder dans le coffre local
   (`core::vault`) ou dans un fichier chiffré à part, à l'image de ce qui
   est fait pour les mots de passe d'hôtes.
4. **Panneau « Coffre »** dans la barre latérale : liste, fiche, formulaire,
   TOTP, générateur — l'interface web (`web/src/components/`) est le modèle,
   mêmes libellés et mêmes composants (`EntityRow`, `list-row`…).
5. **Passkeys** : Guiterm est un client natif, il peut s'enregistrer comme
   authentificateur (Windows Hello / passkey provider) et utiliser
   `keyValue`. Les compteurs (`counter`) doivent alors être réécrits dans
   l'item après chaque assertion.
6. **Remplissage automatique** : `uris[].match` suit la sémantique de
   Bitwarden (`domain` par défaut) — c'est ce qu'une extension navigateur
   lirait.
