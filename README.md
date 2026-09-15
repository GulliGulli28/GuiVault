# GuiVault

Serveur de coffre **zero-knowledge** pour [Guiterm](https://github.com/GulliGulli28/gui-termius) :
synchronisation des hôtes, clés SSH, mots de passe et snippets entre
appareils, et **vaults partagés** entre membres d'une équipe — sans que le
serveur puisse jamais lire un secret.

- **Zero-knowledge** : chiffrement côté client (XChaCha20-Poly1305, Argon2id,
  X25519). Le serveur ne stocke que des blobs et ne possède aucune clé.
- **Partage** : la clé d'un vault est scellée vers la clé publique de chaque
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
proxy TLS** avant de l'exposer : soit le vôtre (Traefik, nginx, Caddy…) avec
`GUIVAULT_TRUST_PROXY=true`, soit le profil intégré :

```bash
GUIVAULT_DOMAIN=vault.example.com docker compose --profile tls up -d
```

### Premier compte

Le serveur ne peut pas créer de compte (il n'a jamais le mot de passe
maître). En mode `invite_only` (défaut), mettez votre adresse dans
`GUIVAULT_ALLOWED_EMAILS`, inscrivez-vous depuis Guiterm, puis invitez les
autres depuis un vault partagé : une invitation autorise l'inscription.

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `GUIVAULT_DATABASE_URL` | — | URL PostgreSQL (obligatoire) |
| `GUIVAULT_SECRET` | — | ≥ 32 caractères (obligatoire) |
| `GUIVAULT_BIND` | `0.0.0.0:8080` | Adresse d'écoute |
| `GUIVAULT_REGISTRATION` | `invite_only` | `open` / `invite_only` / `closed` |
| `GUIVAULT_ALLOWED_EMAILS` | — | Adresses ou `@domaines` toujours autorisés à s'inscrire |
| `GUIVAULT_TRUST_PROXY` | `false` | Lire `X-Forwarded-For` (derrière un proxy de confiance seulement) |
| `GUIVAULT_ACCESS_TTL_SECS` | `900` | Durée du jeton d'accès |
| `GUIVAULT_REFRESH_TTL_SECS` | `2592000` | Durée du jeton de rafraîchissement (30 j) |
| `GUIVAULT_INVITATION_TTL_SECS` | `1209600` | Durée d'une invitation (14 j) |
| `GUIVAULT_MAX_ITEM_BYTES` | `1048576` | Taille max d'un item chiffré |
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
```

Structure :

- `crates/guivault-crypto` — primitives et hiérarchie de clés, partagées
  avec les clients. **Tout le chiffrement se passe ici, côté client.**
- `crates/guivault-protocol` — types JSON de l'API.
- `crates/guivault-server` — le serveur (axum + sqlx/PostgreSQL).

Guiterm consommera `guivault-crypto` et `guivault-protocol` en dépendances
git : une réponse qui change casse la compilation des deux côtés au lieu de
diverger.

## Licence

MIT.
