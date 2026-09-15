# GuiVault — notes pour travailler dans ce dépôt

Serveur de coffre zero-knowledge pour Guiterm (`~/gui-termius`, même auteur,
même stack : Rust 2024 / axum / sqlx / PostgreSQL, rustls uniquement). Voir
`README.md`, `docs/ARCHITECTURE.md` (fonctionnement), `docs/SECURITY.md`
(modèle de menace), `docs/API.md` (routes).

## Règle n°1

**Le serveur ne voit jamais un secret en clair et ne possède aucune clé.**
Toute fonctionnalité qui aurait besoin que le serveur déchiffre quelque
chose est à reconcevoir côté client. Les seules primitives crypto que le
serveur exécute : hachage Argon2id de la clé d'auth, SHA-256 des jetons,
HMAC pour les sels fictifs de prelogin.

## Structure

- `crates/guivault-crypto` — hiérarchie de clés et enveloppes. Consommé par
  Guiterm en dépendance git : **ne pas casser les formats binaires** (octet
  de version `0x01` en tête de chaque blob ; en ajouter un nouveau plutôt
  que changer le sens de l'existant). Versions des crates crypto alignées
  sur celles de Guiterm (`argon2 0.5`, `chacha20poly1305 0.10`, …) pour
  qu'elles s'unifient dans son binaire.
- `crates/guivault-protocol` — types JSON. Même contrainte de compatibilité.
- `crates/guivault-server` — `routes/` (une route par domaine), `db.rs`
  (lignes et requêtes partagées), `auth.rs` (extracteur `AuthUser`,
  jetons), `sessions.rs`, `validate.rs` (tailles des blobs), `audit.rs`,
  `migrations/` (sqlx, embarquées, appliquées au démarrage).

Requêtes sqlx sans macros `query!` (pas de `DATABASE_URL` à la compilation,
build Docker sans base). Les colonnes `citext` se lisent avec `::text`.

## Vérifier

```bash
scripts/test-db.sh                   # Postgres jetable (Docker, port 55432)
cargo test                           # unitaires + tests/api.rs bout en bout
cargo clippy --all-targets           # doit être vide
docker build -f docker/Dockerfile -t guivault:dev .
```

`tests/api.rs` lance un vrai serveur sur un port libre contre une base
créée pour l'occasion, avec des clients qui font la vraie crypto. C'est là
qu'ajouter un scénario quand on ajoute une route — sans base joignable, les
tests s'ignorent avec un avertissement, ils n'échouent pas.

## Conventions

- Erreurs via `AppError` (`error.rs`) : code stable + message humain, 404
  plutôt que 403 quand l'existence d'une ressource est elle-même une
  information. Documenter tout nouveau code dans `docs/API.md`.
- Chaque action sensible écrit une ligne d'audit (`Audit::new("…")`),
  dans la même transaction que l'écriture.
- Ids de vaults et d'items choisis par le client (ils sont dans l'AAD).
- Commentaires en français, code et identifiants en anglais, comme Guiterm.
