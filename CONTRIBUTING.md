# Contribuer à GuiVault

Merci de l'intérêt. GuiVault garde des secrets : quelques règles ne se
négocient pas, le reste se discute volontiers.

- **Une faille** ne s'ouvre pas en issue : voir [`SECURITY.md`](SECURITY.md).
- **Un bogue, une idée** : une issue, en français ou en anglais.
- **Du code** : une pull request, de préférence après en avoir parlé dans une
  issue si le changement est gros.

## Ce qui ne se négocie pas

1. **Le serveur ne voit jamais un secret en clair et ne possède aucune
   clé.** Une fonctionnalité qui aurait besoin que le serveur déchiffre
   quelque chose est à reconcevoir côté client. Même règle pour le coffre
   local (`crates/guivault-local`) : il garde, il ne chiffre pas.
2. **Les formats publiés restent lisibles.** Un blob commence par un octet
   de version ; on en ajoute un nouveau, on ne change jamais le sens d'un
   existant. Tout format nouveau ou changé se décrit dans
   [`docs/FORMATS.md`](docs/FORMATS.md) et se relit par `gv recover`.
3. **Rust et TypeScript produisent les mêmes octets.** Un changement de
   `guivault-crypto` passe par les vecteurs d'interop, dans les deux sens
   (voir plus bas).
4. **Pas de crypto maison.** Les primitives viennent de RustCrypto et de
   `@noble` ; on compose, on n'invente pas.
5. **Pas de fonction payante.** Ce qui entre dans le logiciel libre y reste,
   pour tout le monde.

## Construire et tester

Prérequis : Rust stable, Node 20+, Docker (pour le Postgres des tests).

```bash
scripts/test-db.sh                   # Postgres jetable (port 55432)
cargo test                           # unitaires + bout en bout (vrai serveur, vraie crypto)
cargo clippy --all-targets           # doit être vide
cargo fmt --all --check              # max_width = 120
cd web && npm ci && npm test && npm run lint && npm run build
cd web && npm run build:ext && npm run test:ext   # l'extension et son corpus de remplissage
```

L'application (`app-tauri/`, workspace à part) et Android ont leurs propres
recettes : [`docs/APP.md`](docs/APP.md), [`docs/ANDROID.md`](docs/ANDROID.md).

Un changement de format crypto :

```bash
cargo run -p guivault-crypto --example vectors > web/src/lib/crypto.vectors.json
cd web && GUIVAULT_WRITE_VECTORS=1 npx vitest run   # écrit crates/guivault-crypto/tests/web-vectors.json
```

## Ce qu'on attend d'une pull request

- **Des tests** au niveau où le changement vit : une route nouvelle a son
  scénario dans `crates/guivault-server/tests/api.rs` (vrai serveur, vraie
  base, clients qui font la vraie crypto) ; un site où le remplissage
  échoue devient une page de `web/extension/e2e/fixtures/` ; une fonction de
  l'application, un scénario dans `web/app/e2e/run.mjs`.
- **La doc à jour** : [`docs/API.md`](docs/API.md) pour une route ou un code
  d'erreur, [`docs/SECURITY.md`](docs/SECURITY.md) pour tout ce qui change
  ce que voit le serveur, [`docs/ROADMAP.md`](docs/ROADMAP.md) cochée.
- **Les conventions** : commentaires en français, code et identifiants en
  anglais ; erreurs par `AppError` (code stable + message) ; chaque action
  sensible écrit une ligne d'audit dans la même transaction ; libellés de
  l'interface en français, selon [`docs/DESIGN.md`](docs/DESIGN.md).
- **Le CI vert** : tests, clippy, fmt, lint, builds, corpus de l'extension,
  E2E de l'application.

En contribuant, vous acceptez que votre contribution soit publiée sous la
licence du projet (MIT).

## Publier

Réservé aux mainteneurs :

- **Serveur** : chaque commit vert sur `main` publie l'image
  `ghcr.io/gulligulli28/guivault` signée et attestée ; un tag
  `server-v<version>` en fait une version nommée.
- **Application** : tag `app-v<version>`, puis
  `node scripts/verify-app-release.mjs app-v<version>` **avant** de publier
  le brouillon ([`docs/APP.md`](docs/APP.md), « Mises à jour »).
