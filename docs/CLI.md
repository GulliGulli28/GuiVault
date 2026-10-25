# `gv` — le coffre en ligne de commande

`crates/guivault-cli`, binaire `gv` (`guivault` est le serveur). Un client
comme Guiterm, l'interface web et l'extension : même cryptographie
(`guivault-crypto`), le serveur ne voit que la clé d'auth et des blobs. Il
lit ; pour écrire, l'interface web ou Guiterm.

```bash
cargo install --path crates/guivault-cli      # ou : cargo build --release -p guivault-cli
gv login --server https://vault.example.com --email vous@example.com
eval "$(gv unlock)"                            # une fois par coquille
gv get gv://Personnel/GitHub/password
```

## Commandes

| | |
|---|---|
| `gv login --server URL --email E` | mot de passe maître (et second facteur) sur le terminal ; imprime `export GUIVAULT_SESSION=…` |
| `eval "$(gv unlock)"` | déverrouille dans cette coquille — sans le serveur (`--raw` : la clé seule, pour fish ou PowerShell) |
| `gv lock` | ferme la session : `GUIVAULT_SESSION` ne vaut plus rien |
| `gv logout` | révoque la session au serveur et efface tout de ce poste |
| `gv status`, `gv sync [--accept]` | compte, session, fraîcheur du cache ; relire le serveur maintenant (`--accept` : voir « Manifestes ») |
| `gv list [--vault V] [--type T] [--json]` | les éléments (vault, type, nom, id) |
| `gv get <réf \| élément> [champ] [--vault V] [-n]` | un secret sur la sortie (`-n` : sans retour à la ligne) |
| `gv run [--env-file F]… -- cmd…` | lance `cmd` avec les variables dont la valeur est une référence `gv://` remplacées par le secret |
| `gv attachment list <réf \| élément> [--vault V]` | les pièces jointes d'un élément (nom, taille, id) |
| `gv attachment get <réf \| élément> [pièce jointe] [--vault V] [-o fichier \| -]` | la télécharge et la déchiffre : par défaut un fichier à son nom dans le dossier courant (`0600`, jamais par-dessus un existant), `-o -` sur la sortie ; `gv://vault/élément/pièce jointe` marche aussi |
| `gv aws credential-process <accès \| réf>` | le JSON attendu par `credential_process` (accès AWS par clés) |
| `gv git-credential get` | credential helper Git |
| `gv recover <source> [--email E] [--out DOSSIER] [--password-stdin]` | tout ressortir en clair **sans serveur ni réseau**, d'un coffre local, d'une sauvegarde du serveur ou d'un export — voir « Récupération » |

Sans `GUIVAULT_SESSION`, une commande qui lit demande le mot de passe
maître si un terminal est là.

## Références

`gv://<vault>/<élément>[/<champ>]`, ou `gv://<élément>` (tous les vaults) :
noms (sans tenir compte de la casse) ou ids, `%20` pour une espace. Le vault
personnel répond aussi à `personal` / `perso`. Deux éléments de même nom :
`gv` les liste avec leur id.

Champ par défaut : le secret de l'élément — mot de passe (identifiant,
hôte, connexion SQL), `secret` (clé d'API), `secret-access-key` (AWS),
contenu (note), numéro (carte), clé privée (clé SSH), commande (snippet).
Sinon : `password`, `username`, `totp` (le code du moment), `uri`, `notes`,
n'importe quel champ de l'élément en kebab-case (`access-key-id`,
`key-id`, `port`…) ou un champ personnalisé par son nom.

## Intégrations

```bash
# .env avec des références, jamais de secret en clair
DATABASE_PASSWORD=gv://Équipe%20infra/Base%20prod/password
STRIPE_KEY=gv://Stripe
gv run --env-file .env -- ./manage.py migrate
```

```ini
# ~/.aws/config : plus d'identifiants AWS en clair sur le disque
[profile prod]
credential_process = gv aws credential-process "Prod"
```

```bash
git config --global credential.helper '!gv git-credential'
```

Git demande `host` (et le port), `protocol`, parfois `username` : `gv`
répond avec l'identifiant dont une URI a cet hôte ; `store` et `erase` ne
font rien (le coffre s'écrit ailleurs).

## Sécurité

Le modèle de la CLI de Bitwarden. Dans le dossier de `gv` (`GV_HOME`, sinon
`~/.config/guivault-cli`, `%APPDATA%\guivault-cli`), `0700`/`0600` :

- `account.json` — le compte **enveloppé** tel que le serveur le garde
  (paramètres Argon2id, user key et clé privée scellées : illisibles sans
  le mot de passe maître) et les jetons de session. Le jeton de
  rafraîchissement donne accès aux blobs chiffrés, pas aux secrets ; `gv
  logout` le révoque.
- `session.json` — la user key et la clé privée, scellées sous une clé de
  session aléatoire que seule la coquille a (`GUIVAULT_SESSION`). Qui lit
  l'environnement de vos processus a vos secrets : c'est le prix d'une
  session sans mot de passe à chaque commande, comme `BW_SESSION`.
  `gv unlock` en ouvre une nouvelle et rend l'ancienne clé inutile ; `gv
  lock` la ferme.
- `cache.json` — les vaults et leurs items, **chiffrés** comme sur le
  serveur, relus quand il a plus de cinq minutes. Serveur injoignable : le
  cache sert tel quel (avec un avertissement) — `gv` lit ses secrets
  hors ligne.
- `manifests.json` — par serveur, le plus grand compteur de manifeste vu
  pour chaque vault (voir plus bas). Pas secret, et gardé après `gv
  logout`.
- `sync.lock` — pendant une synchronisation. Les jetons de
  rafraîchissement tournent à chaque usage et le serveur prend la
  re-présentation d'un ancien pour un vol (la session est révoquée) : deux
  `gv` lancés en même temps ne rafraîchissent donc pas en même temps ;
  celui qui trouve le verrou lit le cache.

Comme les autres clients : plancher Argon2id avant de dériver, et
paramètres épinglés — un `gv login` à qui le serveur demande moins de
mémoire ou de passes que la dernière fois est refusé avant d'envoyer quoi
que ce soit. `gv run` passe les secrets dans l'environnement de la
commande, qui en fait ce qu'elle veut ; `gv get` les écrit sur la sortie.

### Pièces jointes

La clé d'un fichier est dans son élément, donc dans le cache ; le fichier
lui-même n'y est pas : `gv attachment get` demande le serveur. Chaque
morceau est vérifié (sa place, le fait d'être le dernier) : un fichier
tronqué, réordonné ou altéré ne se déchiffre pas. Voir
[`PIECES-JOINTES.md`](PIECES-JOINTES.md).

### Manifestes

Chaque lecture vérifie que le serveur sert chaque vault tel que ses membres
l'ont laissé, contre son manifeste ([`MANIFESTE.md`](MANIFESTE.md)) : ni
ancienne version d'un élément rejouée, ni élément retenu ou revenu après
suppression, ni manifeste plus ancien que le dernier vu d'ici. `gv` ne fait
que lire : un écart est dit sur la sortie d'erreur, élément par élément, et
**la lecture continue** — un script qui dépend de `gv get` ne casse pas, mais
son journal le montre. L'écart se règle depuis l'interface web (« Prendre
acte »), où un membre qui écrit réécrit le manifeste. Après une
restauration connue du serveur, `gv sync --accept` fait des manifestes
servis la référence de ce poste (les écarts d'éléments, eux, restent
jusqu'à la réécriture).

## Récupération

`gv recover` ne parle à aucun serveur et n'a besoin d'aucune session :
seulement d'un fichier et d'un mot de passe. C'est la sortie de secours si
le serveur est perdu, si GuiVault n'est plus maintenu, ou pour vérifier
qu'une sauvegarde contient bien ce qu'on croit. Les formats qu'il lit sont
décrits dans [`FORMATS.md`](FORMATS.md) ; le code
(`crates/guivault-cli/src/recover.rs`) n'utilise que `guivault-crypto`.

```bash
gv recover ~/GuiVault/Maison                                     # un coffre local (son dossier)
gv recover guivault-20261025-….jsonl.gz --email vous@example.com  # une sauvegarde du serveur
gv recover export-chiffré.json --out ./récupéré                   # un export protégé par mot de passe
```

| Source | Reconnue à | Mot de passe |
|---|---|---|
| Coffre local | un dossier avec `coffre.json` | le mot de passe maître du coffre |
| Sauvegarde du serveur (`guivault backup`) | le gzip | le mot de passe maître du compte `--email` ; seuls ses vaults sont relus |
| Export JSON | `"format": "guivault-export-encrypted"` (ou `guivault-export`, en clair : sans mot de passe) | celui de l'export |

Le résultat est un dossier (`--out`, par défaut `guivault-recover-<date>`,
refusé s'il existe et n'est pas vide), en `0700`, fichiers en `0600` :

- `<vault>.json` par vault — un export GuiVault **en clair**, réimportable
  par Outils › Importer (ou relu par `gv recover` lui-même) ;
- `<vault>/<élément>/<fichier>` — les pièces jointes déchiffrées (pas
  dans un export chiffré, qui n'en contient pas).

Les manifestes sont vérifiés comme à chaque lecture : un écart est signalé,
la récupération continue. Un élément ou un fichier qui ne s'ouvre pas est
nommé sur la sortie d'erreur, le reste est écrit. `--password-stdin` lit le
mot de passe sur la première ligne de l'entrée standard (scripts, tests).
**Le dossier est en clair** : importez-le puis effacez-le.

