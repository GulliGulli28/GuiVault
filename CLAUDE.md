# GuiVault — notes pour travailler dans ce dépôt

Serveur de coffre zero-knowledge pour Guiterm (`~/gui-termius`, même auteur,
même stack : Rust 2024 / axum / sqlx / PostgreSQL, rustls uniquement). Voir
`README.md`, `docs/ARCHITECTURE.md` (fonctionnement), `docs/SECURITY.md`
(modèle de menace), `docs/API.md` (routes), `docs/ROADMAP.md` (pistes
d'amélioration, à cocher au fur et à mesure).

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
  `card`, `identity`, `aws`, `api-key`), miroir Rust de `web/src/lib/types.ts`, à consommer
  par Guiterm le jour de l'intégration (plan dans `docs/ITEMS.md`). Champs
  inconnus conservés (`flatten extra`), tout absent = défaut. Fixtures
  `tests/web-items.json` écrites par `GUIVAULT_WRITE_VECTORS=1 npx vitest
  run` : changer un type ici, c'est le changer là-bas, et régénérer.
- `crates/guivault-cli` — `gv`, le coffre en ligne de commande
  (`docs/CLI.md`) : une bibliothèque (`login`, `unlock`, `sync`, `resolve`,
  `aws_credential_process`, `git_credential` ; `store.rs` ce qui est gardé
  sur le disque, `vault.rs` les champs lus génériquement dans le JSON des
  items) et `main.rs` (arguments à la main, invites sur le terminal). Son
  test `tests/cli.rs` lance un vrai serveur, comme `tests/api.rs`.
- `crates/guivault-server` — `routes/` (une route par domaine), `db.rs`
  (lignes et requêtes partagées), `auth.rs` (extracteur `AuthUser`,
  jetons), `sessions.rs`, `validate.rs` (tailles des blobs), `audit.rs`,
  `migrations/` (sqlx, embarquées, appliquées au démarrage), `web.rs`
  (sert `web/dist` embarqué par `include_dir!`, CSP stricte ; `build.rs`
  crée le dossier vide s'il manque pour que ça compile sans Node).
- `web/` — l'interface web, Vite + React 19 + TypeScript + Tailwind 3,
  **même charte que Guiterm** : `src/index.css` (jetons et primitives
  `.btn`, `.input`, `.card`, `.list-row`…), `components/ui-icons.tsx`,
  `components/icons.tsx` (banque d'icônes d'hôte), `EntityRow.tsx`,
  `ConfirmDialog.tsx`, `hooks/useModalSurface.ts`, `hooks/useResizablePane.ts`
  (poignées de redimensionnement ; `usePersistedPane.tsx` le complète en
  retenant la largeur dans `localStorage`), `lib/focusTrap.ts`
  et `lib/hostKinds.ts` sont **copiés de `~/gui-termius/src`** — les garder
  identiques (re-copier plutôt que diverger). `lib/vaultTree.ts` en est
  une copie avec deux écarts documentés en tête. `lib/preferences.ts`
  reprend le sous-ensemble « Apparence » des préférences de Guiterm
  (fonds, accents, polices, tailles de ligne : mêmes tables, à recopier
  quand elles changent là-bas) et pose les mêmes variables CSS sur
  `<html>` ; `components/AppearanceSettings.tsx` est sa page de réglages,
  partagée par `SettingsPage` et le popup de l'extension. Le logo est
  `src/assets/logo.png` (+ `logo-gray.png`, la version « verrouillé »),
  généré avec les icônes de l'extension depuis `logo_GuiVault.png` à la
  racine. Le reste :
  - `lib/crypto.ts` — port de `guivault-crypto` (`@noble/*`). Tout
    changement de format doit passer par les deux vecteurs d'interop :
    `cargo run -p guivault-crypto --example vectors > web/src/lib/crypto.vectors.json`
    et `GUIVAULT_WRITE_VECTORS=1 npx vitest run` (écrit
    `crates/guivault-crypto/tests/web-vectors.json`).
  - `lib/offline.ts` — la copie hors ligne (IndexedDB, par appareil,
    désactivée par défaut) : ce que le serveur garde, ouvert par
    `session.openOffline` en lecture seule (rôles `reader`) ; `public/sw.js`
    garde l'interface web pour qu'elle s'ouvre sans le serveur (réseau
    d'abord, jamais l'API). `OfflineSetting` : le réglage, web et popup.
  - `lib/persist.ts` — la session mise à plat, même format pour l'extension
    (`chrome.storage.session`) et le web (`sessionStorage` : survit au
    rechargement, pas à l'onglet), avec le délai d'inactivité « Verrouiller
    après » (Paramètres › Sécurité, `localStorage`).
  - `lib/api.ts` (HTTP, rafraîchissement des jetons, SSE via `fetch`),
    `lib/session.ts` (compte déverrouillé, vaults, items, partage),
    `lib/types.ts` (protocole en snake_case + entités Guiterm en camelCase,
    **même JSON que `termius_core::guivault::entity::Payload`** : un item
    écrit ici doit être relu par Guiterm — les champs inconnus sont
    conservés via `[extra: string]: unknown`).
  - `lib/syncedSettings.ts` — les réglages qui suivent le compte (blob
    sous la user key, `/users/me/settings`), en sections :
    `lib/settingsSections.ts` (apparence, générateurs) ; le popup ajoute
    `extension`. Un nouveau réglage partagé = une section, et
    `settingsChanged(key)` là où il s'enregistre.
  - `lib/clipboard.ts` — tout ce que l'app copie passe par `copyText` et
    s'efface au bout du délai réglé (section synchronisée `clipboard`),
    seulement s'il est encore dans le presse-papiers ; le popup de
    l'extension confie l'effacement au service worker (`setClearScheduler`,
    document hors écran dans Chrome).
  - `lib/items.ts` (secrets vides, ligne secondaire, recherche, `~/.aws/config`),
    `lib/generator.ts` (+ `wordlist.ts`, liste EFF), `lib/sshkey.ts` (clés
    OpenSSH, testées contre `ssh-keygen`), `lib/totp.ts`, `lib/qr.ts`,
    `lib/csv.ts`, `lib/bitwarden.ts` (JSON en clair ou protégé, CSV),
    `lib/importers.ts` / `lib/exporters.ts` (formats dans `docs/ITEMS.md`).
  - `extension/` — l'extension de navigateur (MV3), même `node_modules`,
    importe `../../src/lib/*` et quelques composants. `docs/EXTENSION.md`.
    Le popup ouvert comme une page n'a pas `activeTab` : pour un test
    Playwright, copier `dist-extension` en ajoutant `tabs` et une
    `host_permissions` au manifeste, et ouvrir `popup.html?tab=<id>`.
  - `components/` — une page par route (`VaultPage`, `VaultSettings`,
    `ToolsPage` import/export, `TrashPage` corbeille, `SettingsPage`
    apparence/compte/sécurité/sessions, `InvitationsPage`, `GeneratorPanel`),
    `SearchPalette` (Ctrl+K, tous les vaults), `ItemHistory` (versions d'un
    élément), `ShortcutsHelp` (« ? ») — les raccourcis à une touche passent
    par `lib/keyboard.ts` (`plainShortcut` : ni en saisie, ni sous une
    fenêtre). Un `onClose` passé à une fenêtre (`useModalSurface`) doit être
    stable (`useCallback`) : le hook rend le focus à l'ouvreur quand il
    change. `forms/` : un formulaire par type d'item (`SecretBits.tsx` = tronc commun des secrets ;
    `common.tsx` : `FormShell`, et `useSeed` qui reprend un brouillon —
    un nouveau formulaire lit ses valeurs de départ par `useSeed`),
    `IconPicker.tsx` (le sélecteur de Guiterm, sans Tauri : « Mes icônes »
    sont les items `icon` du vault), `secret-icons.tsx` pour les icônes
    qui ne sont pas dans Guiterm. Un dossier a pour couleur un **nom
    d'accent** (`ACCENT_COLORS`), comme dans Guiterm — pas un hexadécimal.

Requêtes sqlx sans macros `query!` (pas de `DATABASE_URL` à la compilation,
build Docker sans base). Les colonnes `citext` se lisent avec `::text`.

## Vérifier

```bash
scripts/test-db.sh                   # Postgres jetable (Docker, port 55432)
cargo test                           # unitaires + tests/api.rs bout en bout
cargo clippy --all-targets           # doit être vide
cargo fmt --all --check              # le CI le bloque (max_width = 120)
cd web && npm test && npm run lint && npm run build   # Node 20 via nvm (`source ~/.nvm/nvm.sh`)
cd web && npm run build:ext                           # extension (dist-extension/, non embarquée)
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
