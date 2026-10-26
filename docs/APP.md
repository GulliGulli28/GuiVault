# L'application GuiVault (Windows, puis Android)

**État : étapes 1 à 5 faites — le coffre local (`crates/guivault-local`), son
transport côté interface (`web/src/lib/localHost.ts`), l'app Windows
(`app-tauri/`, `web/app/`), l'interface en mode local avec ses tests de bout
en bout, le CI Windows et les installeurs. Ensuite : Android, et la feuille
de route de l'app (`ROADMAP.md`, § Application).** Ce document fixe les choix ; il deviendra la doc de l'app comme
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
- **un coffre local peut devenir un compte**, et l'inverse (Paramètres ›
  Compte › « Copier », [`TRANSFERT.md`](TRANSFERT.md)) : mêmes ids (dans
  l'AAD), mêmes enveloppes — on s'inscrit avec le compte du coffre, et les
  items passent tels quels, historique et corbeille compris ;
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
`dist-app`.

Les hooks de `tauri.conf.json` (`beforeDevCommand`, `beforeBuildCommand`)
tournent **depuis la racine du dépôt** (le parent de `app-tauri/`) : d'où
`npm --prefix web …`.

## Installeurs et releases

`tauri build` (depuis `app-tauri/`) produit un **MSI** (WiX, en français) et
un **installeur NSIS** (`*-setup.exe`, par utilisateur, sans droits
d'administrateur), dans `target/release/bundle/{msi,nsis}/`. Identifiant :
`dev.guivault.client` — il fixe le dossier de données de WebView2 (coffres
récents) et, plus tard, le paquet Android : ne pas en changer.

En CI (`.github/workflows/app-release.yml`) : un tag `app-v<version>` (la
version de `tauri.conf.json`, vérifiée ; les tags `v*` sont ceux du serveur)
construit les deux installeurs sur `windows-latest`, leurs sommes SHA-256 et
une attestation de provenance, et les dépose dans un **brouillon** de
release — publier reste un geste humain. Lancé à la main, il garde les
installeurs comme artefact de l'exécution. Pas de signature de code :
SmartScreen avertit à la première installation (même situation que
Guiterm, voir son `RELEASING.md` pour les options).

Localement sous Windows, avec une CLI Tauri native Windows (le `node_modules`
de `web/` est celui de WSL) et le hook neutralisé, `web/dist-app` étant
construit côté WSL :

```powershell
npm install --prefix "$env:USERPROFILE\guivault-tauri-cli" @tauri-apps/cli@2.12.3   # une fois
Set-Content "$env:TEMP\guivault-nohook.json" '{"build":{"beforeBuildCommand":""}}'
$env:CARGO_TARGET_DIR = "$env:USERPROFILE\guivault-app-target-windows"
Set-Location "\\wsl.localhost\Ubuntu-24.04\home\glorin\GuiVault\app-tauri"
node "$env:USERPROFILE\guivault-tauri-cli\node_modules\@tauri-apps\cli\tauri.js" build --config "$env:TEMP\guivault-nohook.json"
```

## Saisie automatique (Windows)

Comme le « Perform Auto-Type » de KeePass2. `web/src/lib/autotype.ts` dit
**quoi** taper (séquences KeePass : `{USERNAME}{TAB}{PASSWORD}{ENTER}`,
`{TOTP}`, `{S:champ}`, `{DELAY n}`, `{TAB 3}`… — liste complète en tête du
fichier et dans Paramètres › Saisie automatique) et **pour quelle fenêtre**
(un motif associé à l'identifiant, sinon son nom dans le titre, sinon le
domaine d'une de ses adresses) ; `app-tauri/src/autotype.rs` **tape**
(`SendInput` en Unicode : la disposition du clavier n'y change rien).

- **Raccourci global** (Ctrl+Alt+A par défaut, réglable) : la fenêtre au
  premier plan est notée à l'instant de la pression ; un seul identifiant lui
  correspond, il est tapé aussitôt ; plusieurs (ou aucun), GuiVault revient
  au premier plan avec un choix et une recherche (`AutoTypeHost`). Coffre
  verrouillé : la demande attend son ouverture (deux minutes), puis tape.
- **Sur une fiche** (bouton clavier) : GuiVault se réduit, la séquence est
  tapée dans la fenêtre qui reprend le premier plan.
- **Par identifiant** (formulaire) : désactiver, une séquence propre, des
  fenêtres associées avec leur séquence (`Login.autoType`, `docs/ITEMS.md`).
- Réglages de l'appareil (`localStorage`) : le raccourci, la séquence par
  défaut.

L'interface commune n'importe rien de Tauri : l'application pose un pont
(`lib/platform.ts`, `web/app/src/autotypeBridge.ts`) seulement si elle sait
taper sur ce système — sous Linux et Android, rien n'en est montré. Les
garde-fous (modificateurs relâchés, focus vérifié avant chaque caractère,
texte effacé) sont dans `docs/SECURITY.md`. Linux (X11) : à faire.

## Le poste : presse-papiers, verrouillage, sauvegardes, zone de notification

Ce que seule l'application sait faire passe par des ponts que l'interface
commune lit sans rien importer de Tauri (`web/src/lib/platform.ts`, posés par
`web/app/src/*Bridge.ts`) ; leurs réglages sont sur l'appareil
(`lib/appSettings.ts`, Paramètres › Application).

- **Presse-papiers** (Windows, `app-tauri/src/clipboard.rs`) : ce que l'app
  copie part avec les formats qui l'excluent de l'historique (Win+V) et du
  presse-papiers cloud, comme KeePass ; l'effacement au délai réglé est fait
  par l'application, **seulement si personne n'a copié autre chose depuis**
  (numéro de séquence du presse-papiers — sans relire le secret, sans focus).
  Pas de repli sur le presse-papiers du navigateur s'il échoue.
- **Verrouillage** (`app-tauri/src/system.rs`) : à la session Windows
  verrouillée (Win+L) et à la mise en veille (par défaut) ; à la réduction
  ou au passage dans la zone de notification (au choix — pas quand la saisie
  automatique réduit la fenêtre) ; depuis le menu de l'icône. « Verrouiller
  après » compte l'inactivité dans GuiVault (par défaut, le plus sûr) ou sur
  tout l'ordinateur (pour qui tape avec le raccourci global depuis
  d'autres fenêtres). Le délai vaut aussi pour un coffre local, qui avant
  ne se verrouillait jamais (le dernier geste n'était lu que dans la
  session gardée de l'onglet).
- **Sauvegardes du coffre local** (`crates/guivault-local/src/backup.rs`) :
  avant une écriture, si la dernière a plus d'une heure, `coffre.json` est
  copié dans `backups/` ; les dix plus récentes sont gardées. Restaurer
  **n'écrase rien** : la sauvegarde devient un nouveau coffre à côté, avec
  un nouvel identifiant (sinon il hériterait des révisions retenues pour
  l'original, et signalerait un retour en arrière). Paramètres › Compte, et
  à l'accueil quand un coffre ne s'ouvre plus (`local_corrupt`). Les pièces
  jointes ne sont pas dans les sauvegardes : la copie reprend le dossier
  `attachments/` tel qu'il est.
- **Zone de notification** (Windows, `app-tauri/src/tray.rs`) : une icône
  (ouvrir, verrouiller, quitter) ; fermer la fenêtre l'y range (réglable) —
  le raccourci de saisie automatique reste actif ; démarrer avec Windows
  (`--minimized` : directement dans la zone) ; **une seule instance**
  (relancer ramène la fenêtre ; le runner E2E refuse de démarrer si
  GuiVault est déjà ouvert). Sous Linux, pas d'icône — il y faut une
  bibliothèque d'indicateurs souvent absente — et fermer quitte. La fenêtre
  part cachée (`tauri.conf.json`) et `setup` la montre.

## Mises à jour

Comme Guiterm : `tauri-plugin-updater` (Paramètres › Application › Mise à
jour, et une vérification discrète au démarrage qui le signale). L'app lit
`latest.json` sur la release **`app-updater`** du dépôt — pas sur « Latest »,
qu'une release du serveur prendrait —, télécharge l'installeur NSIS, n'installe
que si sa signature correspond à la clé publique de `tauri.conf.json`
(`plugins.updater.pubkey`), puis relance. « À jour » distingue « c'est la
dernière » de « GitHub annonce encore une version plus ancienne »
(`app_update_advertised`).

### Publier une version

Le circuit : le tag `app-v<version>` → `app-release.yml` (runner Windows,
~8 min) construit les installeurs, les signe (secret
`TAURI_SIGNING_PRIVATE_KEY`) et en fait un **brouillon** avec `latest.json` ;
**publier** le brouillon déclenche `app-updater.yml`, qui recopie
`latest.json` dans la pré-release `app-updater` — c'est là que les
applications installées le lisent. Un brouillon n'atteint jamais personne.
Les tags `v*` sont ceux du serveur, d'où le préfixe `app-`.

1. Monter `version` dans `app-tauri/tauri.conf.json` **et**
   `app-tauri/Cargo.toml` (puis `cargo build` dans `app-tauri/` pour le
   `Cargo.lock`) ; commiter, pousser. Le workflow refuse un tag qui ne
   correspond pas à `tauri.conf.json`.
2. `git tag -a app-v<version> -m "GuiVault — application <version>"` puis
   `git push origin app-v<version>` ; suivre « Application (release) »
   (`gh run watch`).
3. **Vérifier avant de publier** : `node scripts/verify-app-release.mjs
   app-v<version>` télécharge `latest.json` et les deux installeurs du
   brouillon, et contrôle chaque entrée contre la clé publique embarquée —
   exactement ce que fera l'updater (version, URL, identifiant de clé,
   commentaire de confiance).
4. Ajouter les nouveautés en tête des notes, puis publier :
   `gh release edit app-v<version> --notes "…" --draft=false --latest`.
   « Latest » : le brouillon est créé avec `--latest=false` pour laisser
   l'étiquette aux releases du serveur, mais il n'y en a encore aucune sur
   GitHub (le tag serveur `v4.0.1` n'a jamais été poussé) — la release de
   l'app la prend donc. L'updater ne lit de toute façon que `app-updater`.
5. Contrôler que les applications la voient :
   `curl -sSL https://github.com/GulliGulli28/GuiVault/releases/download/app-updater/latest.json`
   doit annoncer la nouvelle version.
6. Sur un poste qui a la version précédente : Paramètres › Application ›
   Mise à jour la propose (ou la notification du démarrage, au bout de
   8 s) ; « Installer » télécharge, vérifie la signature, installe sans
   question (`installMode: passive`) et relance. Circuit éprouvé de bout en
   bout avec 0.1.0 → 0.1.1.

**MSI et NSIS** : chaque installeur a son entrée dans `latest.json`,
`windows-x86_64-msi` et `windows-x86_64-nsis`, signée. L'updater lit dans
son propre exécutable le marqueur que le bundler de Tauri y a posé
(`bundle_type`) et prend l'entrée de son installeur : une installation par
le MSI (pour tous les utilisateurs, `Program Files`, demande
l'administrateur) se met à jour par le MSI, une installation NSIS (pour
soi, `%LOCALAPPDATA%`) par le NSIS. L'entrée `windows-x86_64` reste le NSIS,
pour les versions qui ne lisaient pas encore le marqueur (jusqu'à 0.4.0).
Paramètres › Application › Mise à jour dit par quel installeur l'app a été
posée (`app_installer`). Le bundler écrit ce marqueur en patchant
l'exécutable ; si un autre processus le tient ouvert à ce moment
(l'antivirus, vu sur le poste : erreur 1224), il ne fait qu'avertir et le
MSI garde un marqueur inconnu — le workflow échoue alors plutôt que de
publier. Vérifié localement : MSI extrait par `msiexec /a`, exécutable
marqué `MSI` ; `verify-app-release.mjs --dir` sur les installeurs signés
du poste, MSI altéré refusé.

### Versions publiées

| Version | Date | Contenu |
|---|---|---|
| [0.1.0](https://github.com/GulliGulli28/GuiVault/releases/tag/app-v0.1.0) | 21 octobre 2026 | Première version : coffre local ou serveur, saisie automatique, presse-papiers hors de l'historique Windows, verrouillage avec la session, sauvegardes du coffre local, zone de notification, import KDBX, extension reliée par l'hôte natif, mises à jour signées. Circuit de l'updater mis en place (clé, `app-updater`) |
| [0.1.1](https://github.com/GulliGulli28/GuiVault/releases/tag/app-v0.1.1) | 21 octobre 2026 | Copier entre un coffre local et un serveur, dans les deux sens ([`TRANSFERT.md`](TRANSFERT.md)) — demande un serveur qui a `POST /vaults/{id}/import`. Première mise à jour livrée par l'updater : **éprouvée** le 21 octobre 2026 sur un vrai poste Windows — une 0.1.0 installée par NSIS l'a proposée (Paramètres › Application › Mise à jour), installée et relancée en 0.1.1 |
| [0.2.0](https://github.com/GulliGulli28/GuiVault/releases/tag/app-v0.2.0) | 22 octobre 2026 | Refonte de l'interface (`DESIGN.md`) : thème Graphite sombre et clair, accueil, fiche avec colonne « Sécurité », palette Ctrl K, santé, liens de partage, paramètres ; accueil de l'application refait ; liste et fiche côte à côte dès 1100 px ; compteurs de l'accueil justes en coffre local. Premier APK Android joint (aperçu, bulle flottante, `ANDROID.md`) |
| [0.2.1](https://github.com/GulliGulli28/GuiVault/releases/tag/app-v0.2.1) | 22 octobre 2026 | « Nouvel élément » de l'accueil : chaque type, un dossier, un nouveau vault ; vitrine animée à la connexion. Premier APK Android construit et signé par le CI : animations, bulle depuis toutes les pages, création de vaults, icône corrigée |
| [0.5.0](https://github.com/GulliGulli28/GuiVault/releases/tag/app-v0.5.0) | 26 octobre 2026 | Manifeste de vault actif (élément rejoué, retenu ou ressuscité détecté ; Guiterm 4.2.0 ou plus pour écrire dans un vault qui en a un). Éléments protégés (mot de passe maître redemandé), doublons repérés et fusionnés, « Dupliquer », « Bien démarrer » à l'accueil, problèmes de santé ignorables, fuites vérifiées sans serveur depuis un coffre local, feuille de secours imprimable, import CSV de 1Password et Proton Pass. Avec un serveur à jour : mode voyage, clé de sécurité en second facteur. Les mises à jour suivantes passent par le même installeur (MSI ou NSIS) que l'installation. Android : exporter / importer un coffre local, écran caché aux captures, presse-papiers sensible, nouvelle version signalée |
| [0.4.0](https://github.com/GulliGulli28/GuiVault/releases/tag/app-v0.4.0) | 24 octobre 2026 | Android : remplissage automatique des autres applications et de Chrome (suggestions au clavier, coffre verrouillé : une empreinte) ; la bulle grandit jusqu'au plein écran et l'application rétrécit jusqu'à elle |
| [0.3.0](https://github.com/GulliGulli28/GuiVault/releases/tag/app-v0.3.0) | 23 octobre 2026 | Android : déverrouillage par empreinte ou visage (Keystore, mot de passe après un redémarrage et tous les 14 jours) ; pages qui suivent le doigt entre les onglets et transitions façon iOS ; bulle sur ressorts (lancer, aimant de la croix, retour qui grandit depuis la bulle) ; page Santé qui ne déborde plus (le glisser y marchait mal) |
| [0.2.2](https://github.com/GulliGulli28/GuiVault/releases/tag/app-v0.2.2) | 23 octobre 2026 | Vault vide sans boutons ; la zone du compte mène aux paramètres ; Générateur et Codes 2FA alignés à gauche. Android : glisser entre les onglets, bulle en quittant l'application (réglable, sinon un bouton en haut des pages), onglet Générateur, liens ouverts dans le navigateur du téléphone, feuilles au-dessus du clavier |

### La clé de signature

**La clé privée** a été générée hors du dépôt
(`~/.guivault-updater/guivault-app-updater.key`, sans mot de passe) ; elle
est dans le secret GitHub `TAURI_SIGNING_PRIVATE_KEY` depuis la 0.1.0. **En
garder une copie en lieu sûr** — perdue, plus aucune mise à jour ne serait acceptée par
les applications installées (il faudrait les réinstaller avec une nouvelle
clé publique). Sans le secret, `app-release.yml` construit quand même, sans
signature ni `latest.json`, et l'annonce.

## Tests de bout en bout

`web/app/e2e/run.mjs` pilote **le vrai binaire** par WebDriver
(`tauri-driver`, comme Guiterm) : de vrais `invoke`, un vrai coffre écrit
par `guivault-local` dans un dossier temporaire, et des vérifications sur le
disque (rien en clair dans `coffre.json`). Scénarios : l'accueil, créer un
coffre, ce que le mode local masque, créer une note, la saisie automatique
(bouton de la fiche, réglages, et une **vraie frappe** `SendInput` — dans
GuiVault lui-même, jamais dans une fenêtre de la personne qui lance les
tests ; ○ « ignoré » si la fenêtre n'a pas le premier plan, ou sous Linux
où l'on vérifie que rien n'en est montré), la fenêtre maximisée (rien ne
déborde, captures `plein-ecran-*.png` à regarder après un changement
d'interface), fermer et rouvrir (coffres récents, mauvais mot de passe), une erreur de l'hôte (`local_exists`), un
serveur qui ne répond pas. Sous Linux, l'interface est construite puis
servie par `vite preview` (le serveur de dev rechargeait la page en
découvrant ses dépendances, cache froid). Le scénario du presse-papiers lit
et écrit **le vrai presse-papiers de Windows** (et le remet en état à la
fin) : copier quelque chose sur le poste pendant ses ~15 secondes le fait
échouer — le lancer quand on ne s'en sert pas. Les boîtes de dialogue natives ne se pilotent pas
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
Set-Location "\\wsl.localhost\Ubuntu-24.04\home\glorin\GuiVault\web"
node app\e2e\run.mjs
```

`msedgedriver` doit avoir **la même version que le runtime WebView2**
(sinon : « only supports Microsoft Edge version N »), qui se met à jour tout
seul : le script lit sa version dans le registre et télécharge le pilote
correspondant depuis Microsoft dans `~\edgedriver-<version>\`, gardé
seulement si sa signature Authenticode est valide et au nom de Microsoft.
`EDGEDRIVER_PATH` impose un pilote. `E2E_DRIVER_LOG=fichier` garde ce que disent
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
5. ~~**CI**~~ — fait : jobs `app` (Linux : clippy, E2E dans WebKitGTK sous
   Xvfb) et `app-windows` (clippy et build release, là où le code propre à
   Windows se compile) de `ci.yml` ; `app-release.yml` pour les
   installeurs. L'E2E dans WebView2 est à part (`app-windows-e2e.yml`) :
   le runner GitHub tourne en administrateur, et WebView2 n'y applique pas
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (le port de débogage que
   msedgedriver demande) : l'app la reprend elle-même dans les arguments
   passés à WebView2 (`create_main_window`, `app-tauri/src/main.rs`).
   `E2E_DRIVER_LOG` donne le journal détaillé du pilote.
6. Copier entre un coffre local et un serveur ([`TRANSFERT.md`](TRANSFERT.md)) :
   fait ; son scénario E2E tourne contre un vrai serveur quand
   `GUIVAULT_E2E_SERVER` est posé (job `app` du CI).
7. Android : fait (0.2.0, APK signé par le CI depuis la 0.2.1) —
   [`ANDROID.md`](ANDROID.md), ce qui reste y est listé.
8. Plus tard : `gv` sur un coffre local ; Guiterm sur un coffre local.
