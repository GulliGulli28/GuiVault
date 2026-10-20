# L'application GuiVault (Windows, puis Android)

**État : le coffre local est écrit (`crates/guivault-local`, étape 1) ; l'app
pas encore.** Ce document fixe les choix ; il deviendra la doc de l'app comme
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
devient une façade qui délègue au **transport actif** — HTTP (l'actuel) ou
local (des commandes Tauri vers `guivault-local`). Le transport local
implémente ce qui a un sens sans serveur :

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
consulte une liste de capacités du transport pour ne pas proposer ces pages.
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
2. **Transport dans `web/src/lib`** : la façade `api`, le transport HTTP
   (l'actuel, déplacé), les capacités ; un transport en mémoire pour les tests
   de `session.ts`. Rien ne change pour le web ni l'extension.
3. **`app-tauri/` + `web/app/`**, Windows : commandes Tauri qui exposent
   `guivault-local` ; écran d'accueil « Se connecter à un serveur » /
   « Ouvrir un coffre local » / « Créer un coffre local » ; coffres récents.
4. **Interface en mode local** : pages masquées selon les capacités, libellés.
5. **CI** : job Windows (construction, puis installeur sur tag).
6. Plus tard : Android ; « Pousser vers un serveur » ; `gv` sur un coffre
   local ; Guiterm sur un coffre local.
