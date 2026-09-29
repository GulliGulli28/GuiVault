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

## Reste

- **Extension** : ses pages ont leur propre origine (`chrome-extension://…`),
  qui ne peut pas utiliser les passkeys du domaine du serveur. Piste :
  ouvrir la connexion dans un onglet de l'interface web et reprendre la
  session.
- **Code PIN dans l'extension** (déverrouillage rapide local) et **2FA
  WebAuthn** (une clé de sécurité en second facteur du mot de passe) : la
  vérification WebAuthn côté serveur est là, il reste les routes et
  l'interface.
- La **copie hors ligne** ne se rafraîchit pas après une connexion par
  passkey (ses paramètres Argon2id viennent d'une connexion par mot de
  passe) : elle attend la suivante.
- Guiterm et `gv` : mot de passe maître, comme avant.
