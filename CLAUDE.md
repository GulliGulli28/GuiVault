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
- `crates/guivault-items` — formats en clair des secrets (`login`, `note`,
  `card`, `identity`), miroir Rust de `web/src/lib/types.ts`, à consommer
  par Guiterm le jour de l'intégration (plan dans `docs/ITEMS.md`). Champs
  inconnus conservés (`flatten extra`), tout absent = défaut. Fixtures
  `tests/web-items.json` écrites par `GUIVAULT_WRITE_VECTORS=1 npx vitest
  run` : changer un type ici, c'est le changer là-bas, et régénérer.
- `crates/guivault-server` — `routes/` (une route par domaine), `db.rs`
  (lignes et requêtes partagées), `auth.rs` (extracteur `AuthUser`,
  jetons), `sessions.rs`, `validate.rs` (tailles des blobs), `audit.rs`,
  `migrations/` (sqlx, embarquées, appliquées au démarrage), `web.rs`
  (sert `web/dist` embarqué par `include_dir!`, CSP stricte ; `build.rs`
  crée le dossier vide s'il manque pour que ça compile sans Node).
- `web/` — l'interface web, Vite + React 19 + TypeScript + Tailwind 3,
  **même charte que Guiterm** : `src/index.css` (jetons et primitives
  `.btn`, `.input`, `.card`, `.list-row`…), `components/ui-icons.tsx`,
  `EntityRow.tsx`, `ConfirmDialog.tsx`, `hooks/useModalSurface.ts` et
  `lib/vaultTree.ts` sont **copiés de `~/gui-termius/src`** — les garder
  identiques (re-copier plutôt que diverger). Le reste :
  - `lib/crypto.ts` — port de `guivault-crypto` (`@noble/*`). Tout
    changement de format doit passer par les deux vecteurs d'interop :
    `cargo run -p guivault-crypto --example vectors > web/src/lib/crypto.vectors.json`
    et `GUIVAULT_WRITE_VECTORS=1 npx vitest run` (écrit
    `crates/guivault-crypto/tests/web-vectors.json`).
  - `lib/api.ts` (HTTP, rafraîchissement des jetons, SSE via `fetch`),
    `lib/session.ts` (compte déverrouillé, vaults, items, partage),
    `lib/types.ts` (protocole en snake_case + entités Guiterm en camelCase,
    **même JSON que `termius_core::guivault::entity::Payload`** : un item
    écrit ici doit être relu par Guiterm — les champs inconnus sont
    conservés via `[extra: string]: unknown`).
  - `lib/items.ts` (secrets vides, ligne secondaire, recherche),
    `lib/generator.ts` (+ `wordlist.ts`, liste EFF), `lib/totp.ts`,
    `lib/csv.ts`, `lib/bitwarden.ts` (JSON en clair ou protégé, CSV),
    `lib/importers.ts` / `lib/exporters.ts` (formats dans `docs/ITEMS.md`).
  - `components/` — une page par route (`VaultPage`, `VaultSettings`,
    `ToolsPage` import/export, `AccountPage`, `InvitationsPage`,
    `GeneratorPanel`), `forms/` un formulaire par type d'item
    (`SecretBits.tsx` = tronc commun des secrets), `secret-icons.tsx` pour
    les icônes qui ne sont pas dans Guiterm.

Requêtes sqlx sans macros `query!` (pas de `DATABASE_URL` à la compilation,
build Docker sans base). Les colonnes `citext` se lisent avec `::text`.

## Vérifier

```bash
scripts/test-db.sh                   # Postgres jetable (Docker, port 55432)
cargo test                           # unitaires + tests/api.rs bout en bout
cargo clippy --all-targets           # doit être vide
cargo fmt --all --check              # le CI le bloque (max_width = 120)
cd web && npm test && npm run lint && npm run build   # Node 20 via nvm (`source ~/.nvm/nvm.sh`)
docker build -f docker/Dockerfile -t guivault:dev .
```

`npm run build` produit `web/dist`, que `cargo build` embarque ensuite ;
pour voir l'interface, construire le web **avant** le serveur. En dev :
`cargo run` + `cd web && npm run dev` (port 1430, `/api` proxifié vers
8080). Pour un test navigateur réel, Playwright et son Chromium sont
installés dans `~/gui-termius/node_modules` (`import { chromium } from
"/home/glorin/gui-termius/node_modules/playwright/index.mjs"`).

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
- Côté web : libellés en français, mêmes mots que Guiterm (« vault »,
  « hôte », « épingler », rôles `lecteur/éditeur/admin/propriétaire`).
  L'aide d'un champ va *hors* du `<label>` (sinon elle entre dans son nom
  accessible) ; un éditeur composite prend `<Field group>`.
