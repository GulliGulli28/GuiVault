# Connexion par passkey

Statut : **fait** dans l'interface web (29 septembre 2026). Ce qui reste est
en fin de page.

## Ce que ça donne

Paramètres › Sécurité › Passkeys : « Ajouter une passkey » (le mot de passe
maître est redemandé), puis, à l'écran de connexion, « Se connecter avec une
passkey » : ni e-mail, ni mot de passe maître, ni code TOTP — la passkey (sa
possession, et son code ou votre empreinte) en tient lieu. Passkey de
système (Windows Hello, trousseau Apple, Google) ou clé de sécurité, pourvu
qu'elle sache **dériver une clé** : l'extension PRF de WebAuthn.

Proposée seulement si le serveur connaît son adresse publique
(`GUIVAULT_PUBLIC_URL`) : elle fixe le site pour lequel les passkeys sont
créées (le domaine, identifiant WebAuthn) et l'origine acceptée.

## Décisions (29 septembre 2026)

1. **Une connexion, pas un déverrouillage local.** Verrouiller efface tout
   (jetons compris) ; « déverrouiller » est déjà une connexion. La passkey
   ouvre donc une session au serveur, sur n'importe quel appareil où elle
   est disponible (passkeys synchronisées) — comme chez Bitwarden.
2. **La PRF garde la clé.** À l'ajout, l'authentificateur calcule, pour un
   sel fixe, un secret propre à la passkey ; `passkey_key` (HKDF) en tire une
   clé qui enveloppe la user key, liée à l'identifiant de la passkey
   (`seal_passkey_user_key`). Le serveur garde l'enveloppe sans pouvoir
   l'ouvrir ; à la connexion il la rend, et seule la PRF la rouvre. Une
   passkey sans PRF est refusée à l'ajout.
3. **Le serveur vérifie les signatures WebAuthn** (`src/webauthn.rs`), en
   Rust pur — `webauthn-rs` tire OpenSSL. Une primitive de plus dans la
   règle n°1 : il **vérifie**, il ne déchiffre rien. Étroit exprès :
   attestation non vérifiée (on ne filtre pas les modèles), **vérification
   de l'utilisateur exigée** (drapeau UV), ES256, EdDSA et RS256, origine et
   site fixés, `crossOrigin` refusé, compteur de signatures qui doit monter
   s'il est tenu (clone détecté), défis à usage unique de cinq minutes.
4. **Ajouter redemande le mot de passe maître** (sa clé d'auth, vérifiée par
   le serveur) : une session volée ne suffit pas à planter une porte
   d'entrée durable. Retirer une passkey, non (c'est fermer une porte).
5. **Pas de second facteur en plus** d'une passkey : elle est elle-même
   possession + vérification de l'utilisateur.

## Le chemin

- Ajouter : `POST /auth/passkeys/register/start` (défi, site, compte,
  passkeys à exclure, sel PRF) → `navigator.credentials.create` avec
  `prf.eval` (et, si l'authentificateur ne rend la PRF qu'à la connexion, un
  `get` aussitôt sur cette passkey) → `POST /auth/passkeys` avec la réponse,
  l'enveloppe et la clé d'auth.
- Se connecter : `POST /auth/passkeys/login/start` (défi, sans compte :
  passkeys découvrables) → `navigator.credentials.get` avec `prf.eval` →
  `POST /auth/passkeys/login` → une session comme `/auth/login` et
  l'enveloppe ; la user key se rouvre avec la PRF, la clé privée avec elle.

## Où c'est

- Crypto : `passkey_prf_salt`, `passkey_key`, `seal_passkey_user_key` /
  `open_passkey_user_key` (`guivault-crypto`, port web dans `crypto.ts`,
  vecteurs dans les deux sens) ; `unlockAccountWithUserKey` côté web.
- Serveur : `src/webauthn.rs` (vérification, et `testing::SoftAuthenticator`
  pour les tests), `routes/passkeys.rs`, migration `0013` (`passkeys`,
  `webauthn_challenges`, dans `backup::TABLES`), `health.passkeys`.
- Web : `lib/accountPasskeys.ts`, `components/PasskeySettings.tsx`, bouton
  de `LoginScreen`.
- Tests : unitaires de `webauthn.rs` (création puis signature ; mauvais
  défi, origine, site, type, clé, sans vérification ; Ed25519),
  `passkeys_log_in_without_the_master_password` (`tests/api.rs` : mot de
  passe redemandé, défi à usage unique, doublon, connexion et session,
  rejeu, autre site, clone, passkey inconnue ou retirée, serveur sans
  `GUIVAULT_PUBLIC_URL`), et un aller-retour dans Chromium avec un
  authentificateur virtuel (PRF, vérification de l'utilisateur).

## Clé de sécurité (second facteur)

Une passkey **sans enveloppe** de la user key : elle ne peut pas ouvrir le
coffre, seulement prouver, après le mot de passe maître, qu'on la tient — à
la place du code TOTP. YubiKey, Titan, ou celle du système.

- **À côté du TOTP, jamais seule** : elle ne s'ajoute que s'il est actif
  (`409 totp_required`), et part avec lui quand on le désactive. Le code et
  ses codes de récupération restent le recours : perdre la clé ne bloque
  jamais le compte. Rien ne change pour qui n'en ajoute pas.
- **Au second facteur**, le défi TOTP (`202` de `/auth/login`) annonce
  `webauthn: true` si le compte a une clé ou une passkey ; le navigateur
  signe alors un défi (`/auth/2fa/webauthn/start`, `allowCredentials` = les
  clés du compte) et le serveur ouvre la session (`/auth/2fa/webauthn`).
  N'importe quelle clé ou passkey du compte convient ; mêmes cinq essais et
  cinq minutes que le code.
- **Seule, elle ne connecte pas** (`401 security_key_only` sur
  `/auth/passkeys/login`).
- Interface web seulement (comme la connexion par passkey) : l'application
  et l'extension ont leur propre origine et gardent le code.

Code : migration `0014` (`protected_user_key` facultative, défi
`second_factor`), `routes/passkeys.rs` (`second_factor_start`,
`second_factor`), `routes/totp.rs` (`pending`, `complete_login` partagés
avec le code) ; web : `lib/securityKey.ts`, `registerSecurityKey`
(`lib/accountPasskeys.ts`), Paramètres › Sécurité, bouton du second facteur
de `LoginScreen`. Tests : `security_keys_as_second_factor` (`tests/api.rs` :
TOTP exigé, clé de sécurité ajoutée, connexion mot de passe + clé, clé
inconnue ou autre site refusés, jeton consommé, connexion seule refusée,
retirée avec le TOTP) ; aller-retour dans Chromium avec un authentificateur
virtuel (compte, TOTP, clé, reconnexion par la clé).

## Reste

- **Extension** : ses pages ont leur propre origine (`chrome-extension://…`),
  qui ne peut pas utiliser les passkeys du domaine du serveur. Piste :
  ouvrir la connexion dans un onglet de l'interface web et reprendre la
  session.
- **Code PIN dans l'extension** (déverrouillage rapide local).
- Une clé de sécurité **imposée** (refuser le code TOTP une fois une clé
  ajoutée, contre l'hameçonnage) : à proposer en option, avec ses codes de
  récupération comme seul recours.
- La **copie hors ligne** ne se rafraîchit pas après une connexion par
  passkey (ses paramètres Argon2id viennent d'une connexion par mot de
  passe) : elle attend la suivante.
- Guiterm et `gv` : mot de passe maître, comme avant.
