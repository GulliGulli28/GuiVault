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
| `gv status`, `gv sync` | compte, session, fraîcheur du cache ; relire le serveur maintenant |
| `gv list [--vault V] [--type T] [--json]` | les éléments (vault, type, nom, id) |
| `gv get <réf \| élément> [champ] [--vault V] [-n]` | un secret sur la sortie (`-n` : sans retour à la ligne) |
| `gv run [--env-file F]… -- cmd…` | lance `cmd` avec les variables dont la valeur est une référence `gv://` remplacées par le secret |
| `gv aws credential-process <accès \| réf>` | le JSON attendu par `credential_process` (accès AWS par clés) |
| `gv git-credential get` | credential helper Git |

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
