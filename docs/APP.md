# L'application GuiVault (Windows, puis Android)

**État : étapes 1 à 4 faites — le coffre local (`crates/guivault-local`), son
transport côté interface (`web/src/lib/localHost.ts`), l'app Windows
(`app-tauri/`, `web/app/`) et l'interface en mode local, avec ses tests de
bout en bout dans la vraie fenêtre. Reste la CI Windows et les installeurs
(étape 5).** Ce document fixe les choix ; il deviendra la doc de l'app comme
`EXTENSION.md` l'est pour l'extension.

Une application installée qui, au choix :

- **se connecte à un serveur GuiVault** — c'est l'interface web, telle quelle ;
- **ouvre ou crée un coffre local** — un dossier sur le disque, sans serveur.

## Où elle vit

Dans ce dépôt, pour les raisons de toujours : `web/src` est déjà le client
à 90 %, les vecteurs d'interop exigent le Rust et le TS dans le même arbre,
et un changement de protocole doit toucher tous les clients dans le même
commit.

```
web/app/          le point d'entrée de l'app (vite.app.config.ts), même node_modules ;
                  importe ../../src/lib/* et les composants, comme web/extension/
app-tauri/        Tauri 2, workspace Cargo À PART (comme rdp-sidecar chez Guiterm) :
                  `cargo test` à la racine reste la boucle du serveur, sans tauri,
                  wry ni NDK Android
crates/guivault-local/   le format du coffre local (membre du workspace racine)
```

**Windows d'abord.** Boucle de dev : `tauri dev` sous WSL (webkit2gtk, même
code). Les installeurs Windows se construisent sur un runner `windows-latest`,
comme `release.yml` chez Guiterm. Android viendra quand il y aura Android
Studio sur un poste : même projet Tauri, une cible de plus.

## Le coffre local : un serveur qui ne sait rien lire

Le choix qui commande tout : **un coffre local garde exactement ce que garde
le serveur** — les mêmes items chiffrés (`guivault-protocol::Item`), les
mêmes enveloppes de clés (`guivault-crypto`, octet de version `0x01`), le
même manifeste. Seul le transport change : un dossier au lieu de HTTP.

Ce qu'on y gagne :

- **la règle n°1 tient par construction** : `guivault-local` ne fait aucune
  crypto et ne possède aucune clé, comme le serveur. Toute la crypto reste
  dans les clients (`crypto.ts`, `guivault-crypto`) ;
- **l'interface ne change pas** : `session.ts` chiffre et déchiffre comme
  aujourd'hui, il parle juste à un autre transport ;
- **un coffre local pourra devenir un compte** (« Pousser vers un serveur ») :
  mêmes ids (dans l'AAD), mêmes enveloppes — il suffira de s'inscrire avec la
  même user key et de rejouer les écritures ;
- **`gv` et Guiterm pourront l'ouvrir** en consommant le crate, sans nouveau
  format à apprendre (voir plus bas) ;
- précédent : `cache.json` de `gv` garde déjà les items « chiffrés comme sur
  le serveur ».

### Le dossier

```
Mon coffre.guivault/
  coffre.json                       en-tête + vaults + items (format, voir ci-dessous)
  attachments/<vault>/<id>/<n>.bin  morceaux chiffrés, comme côté serveur
  .lock                             verrou : partagé pour lire, exclusif pour écrire
```

`coffre.json` (`"format": 1`) :

- les **paramètres Argon2id** (avec le plancher `KdfParams::is_sane` à
  l'ouverture, comme au prelogin) ;
- la **user key scellée** sous la master key, et la **paire de clés** du
  compte scellée sous la user key ;
- les **vaults** : id, nom chiffré, vault key enveloppée pour la clé
  publique du compte, révision, manifeste ;
- les **items** : `guivault-protocol::Item` tels quels (blob, révision,
  dates, corbeille), et leurs versions précédentes (historique) ;
- le **blob des réglages** (`/users/me/settings`).

Pas de hash d'authentification : il n'y a personne à qui s'authentifier.
Le mot de passe se vérifie par le tag AEAD de la user key scellée — le même
principe que la DEK de `master_vault.rs` chez Guiterm.

Écriture : sous `.lock`, relire, vérifier la révision attendue, écrire dans
un fichier temporaire, `rename` atomique, `0600` — chaque opération est une
transaction, sans journal. Le ménage que le serveur fait toutes les heures
(corbeille expirée, pièces jointes orphelines ou restées incomplètes) se
fait ici à chaque écriture. Champs inconnus conservés (`extra`), et un
`format` plus récent est refusé plutôt que réécrit à moitié compris. Une révision périmée rend
la même erreur que le serveur (`revision_mismatch`, avec `current`) : un
second écrivain (`gv`, Guiterm, un deuxième onglet) passe par la fusion
existante (`MergeDialog`), rien à réécrire.

Le dossier est portable (clé USB, sauvegarde). Le synchroniser par
Syncthing ou un drive *pendant* qu'on écrit des deux côtés n'est pas
couvert : deux copies divergentes de `coffre.json`, c'est un conflit de
fichier, pas d'item. Pour plusieurs appareils, le serveur existe.

### Côté interface : un transport à la place d'`api`

29 fichiers de `web/src` importent `api`. On ne les touche pas : `api`
est une façade qui délègue au **transport actif** (`setTransport`) — HTTP
par défaut, ou le transport local (`localTransport(hôte)`), qui implémente
ce qui a un sens sans serveur :

| Oui | Non (masqué dans l'interface) |
|---|---|
| vaults : créer, renommer, supprimer | partage, membres, invitations, rotation de clé (elle sert à évincer un membre) |
| items : lire, écrire, supprimer, déplacer | accès d'urgence |
| corbeille, historique des versions | liens de partage |
| manifeste | sessions, appareils, 2FA du compte |
| pièces jointes | connexion par passkey (plus tard, peut-être : Windows Hello) |
| réglages synchronisés, changement de mot de passe | administration |
| import, export, générateur, TOTP, santé (sans les relais) | fuites (k-anonymat) et sites 2FA : relais du serveur |

Le reste répond `ApiError(501, "local_unsupported")`, et l'interface
demande `supports("members")` (etc.) pour ne pas proposer ces pages : la
liste des capacités, c'est la liste des méthodes du transport, rien à tenir
à jour à part. Ce que l'interface masque ainsi : Invitations et Liens de
partage (barre latérale), « Partager par lien » (fiche, pièces jointes),
membres, invitations, journal et rotation (réglages d'un vault), Sessions et
Accès d'urgence (catégories des paramètres), second facteur, passkeys,
empreinte, suppression du compte. La copie hors ligne n'a pas de sens pour
un coffre déjà sur l'appareil (`session.local`). Le coffre se nomme par son
dossier (`coffreName`) là où le web montre l'e-mail, et « Fermer le coffre »
remplace « Se déconnecter ».

Le coffre local répond aussi à `health` (une `HealthResponse`, comme le
serveur) : l'interface y lit la taille maximale des pièces jointes
(`Options::max_attachment_bytes`), et qu'il n'y a ni liens, ni relais du
rapport de santé, ni passkeys.

**Le contrat avec l'hôte** : une opération par méthode d'`api`, avec les
mêmes corps JSON que l'API HTTP (base64 compris) — `guivault_local::rpc::call(vault,
op, args)` côté Rust, `LocalHost.call(op, args)` côté TS. La liste est dans
`crates/guivault-local/ops.json`, vérifiée par les tests des deux côtés.
Deux opérations n'ont pas d'équivalent HTTP : `account` (le compte
enveloppé, pour déverrouiller) et `changePassword` (sans preuve de l'ancien
mot de passe auprès de l'hôte : `session.ts` la vérifie en rouvrant la user
key). Une commande Tauri n'a qu'à appeler `rpc::call` et rendre le
résultat, ou `{ status, …Error::body() }`.

Côté session : `createLocal(hôte, chemin, mot de passe)` et `openLocal(…)`
dans `session.ts`, à côté de `login` et `openOffline` ; `closeLocal()` (ou
`logout()`) rend `api` au serveur. `SessionState.local` dit qu'on est dans
un coffre local.
Le navigateur, lui, ne voit jamais de coffre local : c'est une fonction de
l'app, la copie hors ligne du web (`offline.ts`) reste ce qu'elle est.

## Guiterm et le coffre local

Question posée : sur un PC qui a l'app GuiVault et Guiterm, faut-il relier
les deux bases locales ?

**Pas maintenant, et jamais en partageant un fichier à deux formats.**
Aujourd'hui le « local » de Guiterm n'est pas un vault GuiVault : c'est
`workspace.json` (non secret) plus le trousseau du système ou
`master_vault.rs` (sa propre enveloppe, son propre mot de passe maître,
facultatif). Faire lire ou écrire ces fichiers par GuiVault, ou l'inverse,
créerait un troisième contrat de format à garder compatible, deux écrivains
sans verrou commun, et deux mots de passe maîtres pour une même base.

Le pont existe déjà : **le compte**. Guiterm synchronise ses entités en items
(`core/src/guivault/`), et l'app les verra. Un serveur GuiVault sur
`localhost` suffit à relier les deux applications d'un même PC, sans rien
écrire.

Le jour où l'on veut se passer de serveur, la bonne forme est **une base,
deux lecteurs**, pas deux bases reliées : Guiterm consomme `guivault-local`
(épinglé comme `guivault-crypto`) et son moteur de synchro, qui parle déjà en
items, prend un dossier au lieu d'une URL. C'est précisément parce que le
coffre local garde le format du serveur que ce sera de la tuyauterie et pas
une conception. À décider après la v1 de l'app.

## Construire et lancer

L'interface de l'app est `web/app/` : `src/main.tsx` monte `App` avec
l'accueil `AppWelcome` (serveur ou coffre local) ; `tauriHost.ts` est
l'hôte du coffre local (commandes Tauri) ; `recents.ts` les coffres récents
et le dernier serveur (`localStorage`). Le mode serveur n'a pas besoin de
Tauri : `setBaseUrl` puis l'écran de connexion du web, en HTTP — l'API a un
CORS ouvert (`routes/mod.rs`), et la CSP de `tauri.conf.json` permet
`https:` et `http://localhost`.

```bash
cd web && npm run build:app        # web/dist-app, que le binaire embarque
cd web && npm run dev:app          # Vite sur :1431 (devUrl de tauri.conf.json)
cd app-tauri && cargo build        # binaire de dev Linux (WebKitGTK, WSLg) : charge :1431
cd app-tauri && cargo clippy --all-targets && cargo fmt --check
```

Le vrai binaire Windows (WebView2), depuis WSL — Rust natif est installé
côté Windows ; npm reste côté WSL, un seul `node_modules` :

```powershell
$env:PATH += ";$env:USERPROFILE\.cargo\bin"
$env:CARGO_TARGET_DIR = "$env:USERPROFILE\guivault-app-target-windows"   # NTFS, jamais le chemin UNC
Get-Process guivault-app -ErrorAction SilentlyContinue | Stop-Process -Force
Set-Location "\\wsl.localhost\Ubuntu-24.04\home\glorin\GuiVault\app-tauri"
cargo build --release --features tauri/custom-protocol    # embarque web/dist-app
Start-Process "$env:CARGO_TARGET_DIR\release\guivault-app.exe"
```

Sans `tauri/custom-protocol`, le binaire charge `devUrl` au lieu de
`dist-app`. Les installeurs (MSI/NSIS) viendront avec l'étape 5
(`tauri build` sur un runner Windows).

## Tests de bout en bout

`web/app/e2e/run.mjs` pilote **le vrai binaire** par WebDriver
(`tauri-driver`, comme Guiterm) : de vrais `invoke`, un vrai coffre écrit
par `guivault-local` dans un dossier temporaire, et des vérifications sur le
disque (rien en clair dans `coffre.json`). Scénarios : l'accueil, créer un
coffre, ce que le mode local masque, créer une note, fermer et rouvrir (coffres
récents, mauvais mot de passe), une erreur de l'hôte (`local_exists`), un
serveur qui ne répond pas. Les boîtes de dialogue natives ne se pilotent pas
par WebDriver : le script pose le chemin dans `window.__GUIVAULT_E2E_PATH__`
(`web/app/src/dialogs.ts`). Un échec laisse une capture et le texte visible
(`web/app/e2e/.output/`, ignoré par git).

```bash
cd app-tauri && cargo build && cd ../web && npm run test:app     # Linux, WebKitGTK (WSLg) ; en CI sous Xvfb
```

Sous Windows (WebView2 — ce que lancent les utilisateurs), après le build
release ci-dessus :

```powershell
$env:CARGO_TARGET_DIR = "$env:USERPROFILE\guivault-app-target-windows"
$env:EDGEDRIVER_PATH = "$env:USERPROFILE\edgedriver-155\msedgedriver.exe"
Set-Location "\\wsl.localhost\Ubuntu-24.04\home\glorin\GuiVault\web"
node app\e2e\run.mjs
```

`msedgedriver` doit avoir **la même version majeure que le runtime
WebView2** (sinon : « only supports Microsoft Edge version N ») : le prendre
sur https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip quand
WebView2 se met à jour. `E2E_DRIVER_LOG=fichier` garde ce que disent
`tauri-driver` et le pilote natif. Le script tue tout l'arbre de processus
en partant : un WebKitWebDriver orphelin garderait le port 4445, et sous WSL
ce port bloque aussi le Windows d'à côté (relayé par `wslrelay.exe`).

## Étapes, dans l'ordre

1. ~~**`crates/guivault-local`**~~ — fait : format, écritures sous verrou,
   révisions, manifeste, corbeille, historique, pièces jointes, réglages,
   changement de mot de passe. `tests/local.rs` joue de vrais clients
   `guivault-crypto` (déverrouillage, mauvais mot de passe, conflits, deux
   écrivains et huit fils sur le même coffre, rétention, format plus récent,
   fichier corrompu jamais réécrit). Erreurs aux codes du serveur, plus
   `local_not_found`, `local_exists`, `local_format_unsupported`,
   `local_corrupt`, `local_io` ; `Error::body()` donne le JSON qu'aurait
   renvoyé le serveur.
2. ~~**Transport dans `web/src/lib`**~~ — fait : la façade `api`
   (`setTransport`, `supports`), `localHost.ts`, `rpc.rs` + `ops.json`,
   `createLocal` / `openLocal` / `closeLocal`. `localHost.test.ts` : la
   façade, les erreurs, le contrat, et une session créée, écrite, rouverte
   (mauvais mot de passe, changement de mot de passe) avec un hôte en
   mémoire. Rien ne change pour le web ni l'extension.
3. ~~**`app-tauri/` + `web/app/`**~~ — fait, Windows : quatre commandes
   Tauri (`local_create`, `local_open`, `local_close`, `local_call` →
   `rpc::call`), l'accueil `web/app/src/AppWelcome.tsx` (serveur, ouvrir,
   créer, coffres récents), `App` réutilisé tel quel (`Welcome` à la place
   de `LoginScreen`). Voir « Construire et lancer ».
4. ~~**Interface en mode local**~~ — fait : voir plus haut ce qui est
   masqué ; `health` côté coffre ; E2E dans la vraie fenêtre (7 scénarios,
   WebKitGTK et WebView2) et job `app` du CI.
5. **CI** : job Windows (construction, puis installeur sur tag).
6. Plus tard : Android ; « Pousser vers un serveur » ; `gv` sur un coffre
   local ; Guiterm sur un coffre local.
