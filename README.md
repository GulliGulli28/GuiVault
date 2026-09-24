# GuiVault

Serveur de coffre **zero-knowledge** pour [Guiterm](https://github.com/GulliGulli28/gui-termius) :
synchronisation des hôtes, clés SSH, mots de passe et snippets entre
appareils, et **vaults partagés** entre membres d'une équipe — sans que le
serveur puisse jamais lire un secret.

- **Zero-knowledge** : chiffrement côté client (XChaCha20-Poly1305, Argon2id,
  X25519). Le serveur ne stocke que des blobs et ne possède aucune clé.
- **Partage** : la clé d'un vault est enveloppée pour la clé publique de chaque
  membre. Rôles `reader` / `writer` / `admin` / `owner`, invitations (y
  compris vers quelqu'un qui n'a pas encore de compte), rotation de clé
  après un départ.
- **Synchronisation** : révisions monotones par vault, `?since=` pour ne
  télécharger que ce qui a changé, verrou optimiste (409) sur les conflits,
  pierres tombales pour les suppressions.
- **Sessions** : jetons opaques hachés, rotation des jetons de
  rafraîchissement avec détection de rejeu, révocation à distance, second
  facteur TOTP optionnel avec codes de récupération.
- **Temps réel** : un flux SSE prévient les clients qu'un vault a changé.
- **Audit** : journal en ajout seul par vault et par utilisateur.
- **Interface web** servie par le serveur lui-même (`/`), avec le même
  chiffrement dans le navigateur : consulter et modifier ses hôtes, clés,
  snippets et connexions, gérer les vaults partagés, les membres, les
  invitations, les sessions et le second facteur — depuis une machine sans
  Guiterm. Même charte que Guiterm, mêmes réglages d'apparence (mode
  sombre/clair/système, fond, couleur d'accent, police, tailles des
  lignes), mêmes icônes d'hôtes et de dossiers.
- **Gestionnaire de mots de passe** dans la même interface, à la manière de
  Bitwarden : identifiants (avec sites, codes TOTP, passkeys, historique),
  notes sécurisées, cartes, identités, favoris, champs personnalisés ;
  générateur de mots de passe, de phrases de passe et de clés SSH
  (Ed25519, RSA, ECDSA, format OpenSSH) ; import depuis
  Bitwarden (JSON en clair ou protégé, CSV), Chrome, Firefox, LastPass,
  KeePassXC ; export JSON (chiffré par mot de passe ou en clair) et CSV.
  Recherche dans tous les vaults (**Ctrl+K**), raccourcis clavier (`?`),
  tri par date, **historique** de chaque élément et **corbeille** (30 j),
  presse-papiers effacé après copie, **copie hors ligne** chiffrée pour
  lire son coffre (et remplir dans l'extension) quand le serveur ne répond
  pas.
  Formats décrits dans [`docs/ITEMS.md`](docs/ITEMS.md).
- **Extension de navigateur** (Chrome/Edge/Firefox) : les identifiants de
  la page courante, remplissage en un clic ou depuis le champ, codes TOTP,
  passkeys, authentificateur (codes TOTP), générateur —
  [`docs/EXTENSION.md`](docs/EXTENSION.md).
- **En ligne de commande** (`gv`) : lire un secret par référence
  (`gv://vault/élément/champ`), lancer une commande avec ses secrets en
  variables (`gv run`), `credential_process` AWS, credential helper Git —
  [`docs/CLI.md`](docs/CLI.md).
- **Une seule image Docker**, Rust/axum/PostgreSQL. Même stack que Guiterm.

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour le fonctionnement,
[`docs/SECURITY.md`](docs/SECURITY.md) pour le modèle de menace et
[`docs/API.md`](docs/API.md) pour les routes.

## Déploiement (Docker)

```bash
git clone https://github.com/GulliGulli28/GuiVault.git && cd GuiVault
cp .env.example .env
# Renseigner POSTGRES_PASSWORD, GUIVAULT_SECRET (openssl rand -base64 48)
# et GUIVAULT_ALLOWED_EMAILS (votre adresse : c'est le premier compte).
docker compose up -d --build   # `--build` tant que l'image n'est pas publiée sur ghcr.io
curl http://127.0.0.1:8080/api/v1/health
```

Le serveur parle HTTP sur `127.0.0.1:8080`. **Mettez-le derrière un reverse
proxy TLS** avant de l'exposer : soit le vôtre (Traefik, nginx, Caddy…) en
lui déclarant l'adresse de votre proxy (voir plus bas), soit le profil
intégré :

```bash
GUIVAULT_DOMAIN=vault.example.com docker compose --profile tls up -d
```

**HTTPS n'est pas optionnel pour l'interface web.** En clair, un navigateur
place la page hors « contexte sécurisé » et lui retire une partie de
l'API WebCrypto ; surtout, quiconque est sur le chemin peut remplacer son
JavaScript par une version qui vole le mot de passe maître. La page
affiche un avertissement rouge dans ce cas. Pour un essai rapide sans
certificat, passez par un tunnel SSH — `localhost` est un contexte
sécurisé :

```bash
ssh -N -L 8082:127.0.0.1:8082 mon-serveur
```

### Derrière votre propre reverse proxy

`GUIVAULT_TRUST_PROXY` dit **qui** a le droit d'annoncer l'IP du client via
`X-Forwarded-For` — ce qui décide du rate-limit des routes
d'authentification et de ce qu'écrit le journal d'audit. Donnez-lui
l'adresse (ou le réseau) de votre proxy :

```ini
GUIVAULT_TRUST_PROXY=172.18.0.0/16      # le réseau Docker du proxy
# ou 192.168.1.10, ou plusieurs séparés par des virgules
```

Le serveur ne lit alors l'en-tête que si la connexion vient de là — et une
adresse de connexion TCP, contrairement à un en-tête, ne se falsifie pas.
Quelqu'un qui joindrait le port directement se fait donc limiter sur sa
vraie IP.

`true` reste accepté : l'en-tête est cru quel qu'en soit l'émetteur. À ne
garder que si le port est réellement injoignable autrement (publié sur
`127.0.0.1` avec un proxy sur la même machine et *pas* en conteneur, ou pas
publié du tout). `false` (défaut) ignore l'en-tête.

### Premier compte

Le serveur ne peut pas créer de compte (il n'a jamais le mot de passe
maître). En mode `invite_only` (défaut), mettez votre adresse dans
`GUIVAULT_ALLOWED_EMAILS`, inscrivez-vous depuis Guiterm ou depuis
l'interface web (`https://vault.example.com/`), puis invitez les autres
depuis un vault partagé : une invitation autorise l'inscription.

### Interface web

Le binaire sert à `/` une application (React, même charte que Guiterm) qui
fait exactement ce que fait Guiterm avec le serveur : dériver les clés du
mot de passe maître dans le navigateur, déchiffrer les vaults, chiffrer ce
qu'elle écrit. Le serveur ne voit pas plus de choses qu'avec Guiterm. Rien
n'est conservé après fermeture de l'onglet (les
empreintes, les paramètres Argon2id épinglés et les dernières révisions vues
des vaults mis à part) ; le modèle de menace propre au web est
dans [`docs/SECURITY.md`](docs/SECURITY.md).

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `GUIVAULT_DATABASE_URL` | — | URL PostgreSQL (obligatoire) |
| `GUIVAULT_SECRET` | — | ≥ 32 caractères (obligatoire) |
| `GUIVAULT_BIND` | `0.0.0.0:8080` | Adresse d'écoute |
| `GUIVAULT_REGISTRATION` | `invite_only` | `open` / `invite_only` / `closed` |
| `GUIVAULT_ALLOWED_EMAILS` | — | Adresses ou `@domaines` toujours autorisés à s'inscrire |
| `GUIVAULT_TRUST_PROXY` | `false` | IP/CIDR des proxys autorisés à poser `X-Forwarded-For` (`true` = tous, voir ci-dessous) |
| `GUIVAULT_ACCESS_TTL_SECS` | `900` | Durée du jeton d'accès |
| `GUIVAULT_REFRESH_TTL_SECS` | `2592000` | Durée du jeton de rafraîchissement (30 j) |
| `GUIVAULT_INVITATION_TTL_SECS` | `1209600` | Durée d'une invitation (14 j) |
| `GUIVAULT_MAX_ITEM_BYTES` | `1048576` | Taille max d'un item chiffré |
| `GUIVAULT_ITEM_HISTORY` | `20` | Versions précédentes gardées par item (historique, chiffrées) ; `0` : ni historique ni corbeille |
| `GUIVAULT_TRASH_DAYS` | `30` | Jours qu'un élément supprimé reste dans la corbeille |
| `GUIVAULT_AUTH_RATE_PER_SECOND` / `_BURST` | `2` / `10` | Rate-limit par IP des routes d'auth |
| `GUIVAULT_LOG_JSON` | `false` | Journaux en JSON |
| `RUST_LOG` | `info,sqlx=warn` | Filtre de journalisation |

### Sauvegarde

Tout est dans PostgreSQL (`pg_dump`). Le dump ne contient aucun secret en
clair : sans le mot de passe maître de chaque utilisateur, il est inutile.
À l'inverse, **un mot de passe maître perdu est irrécupérable** — il n'y a
pas de « réinitialisation » possible côté serveur, par construction.

## Développement

```bash
scripts/test-db.sh        # Postgres jetable dans Docker (port 55432)
cargo test                # unitaires + intégration bout en bout
cargo clippy --all-targets
cd web && npm install && npm test && npm run build   # interface web
cd web && npm run build:ext                          # extension → web/dist-extension/
cargo build --release -p guivault-cli                # gv → target/release/gv
```

L'interface web est embarquée dans le binaire au moment de `cargo build`
(`web/dist`, créé par `npm run build`) ; sans ce build, le serveur compile
quand même et répond sur `/` que l'interface manque. Pour travailler dessus
avec rechargement à chaud : `cargo run` d'un côté, `cd web && npm run dev`
de l'autre (Vite sert sur `http://localhost:1430` et proxifie `/api` vers
le serveur).

Structure :

- `crates/guivault-crypto` — primitives et hiérarchie de clés, partagées
  avec les clients. **Tout le chiffrement se passe ici, côté client.**
- `crates/guivault-protocol` — types JSON de l'API.
- `crates/guivault-server` — le serveur (axum + sqlx/PostgreSQL), qui sert
  aussi l'interface web.
- `crates/guivault-items` — les formats en clair des secrets (identifiants,
  notes, cartes, identités, accès AWS, clés d'API), pour qu'un client Rust
  les lise sans les redéfinir. Testé contre ce que l'interface web écrit.
- `crates/guivault-cli` — `gv`, le coffre en ligne de commande
  ([`docs/CLI.md`](docs/CLI.md)).
- `web/` — l'interface web (Vite + React + TypeScript). `src/lib/crypto.ts`
  est le port de `guivault-crypto` ; des vecteurs générés par le crate
  Rust (et réciproquement) garantissent que les deux lisent les mêmes
  blobs. `web/extension/` : l'extension de navigateur, sur le même code.

Guiterm consomme `guivault-crypto`, `guivault-protocol` et `guivault-items`
en dépendances git, épinglées sur un commit : une réponse qui change casse
la compilation des deux côtés au lieu de diverger.

Les pistes d'amélioration, ce qui est fait et ce qui reste :
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Licence

MIT.
