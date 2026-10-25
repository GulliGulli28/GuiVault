# GuiVault

**Un coffre zero-knowledge pour les mots de passe *et* les secrets
d'infrastructure — sur votre serveur, ou sans serveur du tout.**

GuiVault garde identifiants, codes 2FA, passkeys, notes, cartes et
identités, mais aussi hôtes SSH, clés, accès AWS et clés d'API, et les
partage entre les membres d'une équipe. Tout est chiffré sur l'appareil :
le serveur, que vous hébergez, ne garde que des blobs qu'il ne sait pas
lire et ne possède aucune clé. Le même coffre peut aussi vivre dans un
simple dossier, sans serveur, à la manière de KeePass — et passer de l'un à
l'autre quand le besoin change.

Clients : interface web (servie par le serveur), extension de navigateur,
application Windows, application Android, ligne de commande `gv`, et
[Guiterm](https://github.com/GulliGulli28/gui-termius), le client SSH du
même auteur.

> **Où en est le projet — sans enjoliver** (octobre 2026)
>
> - **Projet jeune** : premier commit le 15 septembre 2026, un seul
>   développeur. Environ 57 000 lignes de Rust, TypeScript et Kotlin, plus
>   de 250 tests automatisés passés par le CI à chaque commit — unitaires,
>   bout en bout contre un vrai serveur et une vraie base, extension dans un
>   vrai Chromium, application dans sa vraie fenêtre (WebKitGTK et WebView2).
> - **Aucun audit de sécurité externe à ce jour.** La conception est
>   documentée et argumentée ([`docs/SECURITY.md`](docs/SECURITY.md)), la
>   cryptographie repose sur des bibliothèques reconnues (RustCrypto,
>   `@noble`) et non sur du fait maison — mais rien ne remplace un regard
>   indépendant. Gardez une autre copie de ce que vous ne pouvez pas vous
>   permettre de perdre.
> - **Interface en français uniquement.**
> - **Distribution encore artisanale** : image Docker à construire
>   soi-même, extension à charger « non empaquetée » (pas encore dans les
>   stores), installeurs Windows sans signature Authenticode (SmartScreen
>   avertit), APK Android à installer à la main et vérifié seulement sur
>   émulateur. Ni iOS, ni macOS, ni application Linux.

## Pourquoi GuiVault

1. **Conçu contre un serveur malveillant, pas seulement contre une fuite.**
   En février 2026, ETH Zurich a publié
   [27 attaques](https://eprint.iacr.org/2026/058) contre Bitwarden,
   LastPass, Dashlane et 1Password, toutes en supposant le serveur
   compromis. GuiVault répond à chacune des familles d'attaques décrites : plancher Argon2id et
   paramètres épinglés par appareil (le serveur ne peut pas imposer une
   dérivation au rabais), enveloppes de clés de vault **authentifiées** et
   empreinte de l'inviteur vérifiée avant d'accepter, retour en arrière
   détecté, accès d'urgence **sans** clé de récupération côté serveur, rôle
   d'administrateur qui ne se donne que depuis le shell. Le manifeste qui
   authentifie l'ensemble d'un vault est écrit, pas encore activé (voir
   [Limites](#limites-connues)).
2. **Local ou serveur, le même coffre.** Un coffre local n'est pas un autre
   format : c'est exactement ce que garderait le serveur, dans un dossier.
   On commence seul sans rien héberger, et on le copie vers un serveur le
   jour où l'on veut partager — ou l'inverse —, historique, corbeille et
   pièces jointes compris ([`docs/TRANSFERT.md`](docs/TRANSFERT.md)).
   KeePass n'a pas de serveur ; Bitwarden, 1Password et Proton Pass n'ont
   pas de mode sans serveur.
3. **Les secrets d'infrastructure en première classe.** Hôtes, clés SSH
   (générées au format OpenSSH), accès AWS, clés d'API qui expirent,
   synchronisés avec Guiterm, dont l'agent SSH lit le coffre (confirmation
   à chaque signature, signature des commits). `gv` lit un secret par
   référence (`gv://vault/élément/champ`), lance une commande avec ses
   secrets en variables (`gv run`), sert de `credential_process` AWS et de
   credential helper Git. Ce que 1Password vend aux développeurs, en
   logiciel libre et auto-hébergé.
4. **Tout, sans palier payant.** Pièces jointes, accès d'urgence, liens de
   partage (texte, élément ou fichier), TOTP, rapport de santé, passkeys :
   ni licence, ni « premium ».
5. **Un serveur qu'on exploite sereinement.** Une image Docker, un binaire
   Rust, PostgreSQL. Des sauvegardes automatiques **restaurées dans une
   base d'essai** à chaque fois, pour prouver qu'elles marchent ; une
   administration qui ne voit jamais un contenu ; quotas, restriction par
   adresse IP, journal d'audit en ajout seul, e-mails facultatifs dont rien
   ne dépend.

## Ce que ça fait

### Les clients

| Client | Ce qu'il fait | État |
|---|---|---|
| **Interface web** | Tout, depuis n'importe quel navigateur, avec la même cryptographie que les autres clients ; utilisable au téléphone, installable (PWA), copie hors ligne en lecture seule | Servie par le serveur à `/` |
| **Extension** ([`EXTENSION.md`](docs/EXTENSION.md)) | Remplissage en un clic ou depuis le champ — composants web (shadow DOM) et cadres compris, sans jamais remettre le mot de passe d'un site à un cadre tiers —, codes TOTP, passkeys, générateur ; face à un serveur ou au coffre local de l'application | Chrome, Edge, Firefox ≥ 115 ; à charger non empaquetée |
| **Application Windows** ([`APP.md`](docs/APP.md)) | Coffre local ou serveur ; saisie automatique à la KeePass, presse-papiers hors de l'historique Windows, verrouillage avec la session, zone de notification, sauvegardes du coffre local, import KeePass (KDBX), mises à jour signées | MSI et NSIS dans les [releases `app-v*`](https://github.com/GulliGulli28/GuiVault/releases) |
| **Application Android** ([`ANDROID.md`](docs/ANDROID.md)) | Coffre local ou serveur ; déverrouillage biométrique, remplissage des autres applications et de Chrome ([`REMPLISSAGE.md`](docs/REMPLISSAGE.md)), bulle flottante | APK signé et attesté, joint aux mêmes releases ; vu sur émulateur seulement |
| **`gv`** ([`CLI.md`](docs/CLI.md)) | Secrets par référence, `gv run`, AWS, Git, pièces jointes ; cache chiffré lisible sans le serveur | À compiler (`cargo build --release -p guivault-cli`) |
| **Guiterm** | Client SSH : hôtes, clés, snippets et connexions synchronisés, agent SSH adossé au coffre | Dépôt à part |

Tous lisent les mêmes blobs : des vecteurs générés par le Rust et relus par
le TypeScript (et réciproquement) le vérifient à chaque build.

### Le coffre

- **Types d'éléments** : identifiants (plusieurs sites, TOTP, passkeys,
  historique du mot de passe), notes sécurisées, cartes, identités, accès
  AWS, clés d'API, hôtes, clés SSH, snippets ; champs personnalisés,
  favoris, dossiers colorés, icônes. Formats dans
  [`docs/ITEMS.md`](docs/ITEMS.md).
- **Pièces jointes chiffrées**, une clé par fichier, morceaux liés à leur
  place ([`docs/PIECES-JOINTES.md`](docs/PIECES-JOINTES.md)).
- **Historique** de chaque élément et **corbeille** (30 jours par défaut).
- **Conflits** : deux modifications concurrentes se fusionnent champ par
  champ au lieu qu'une écrase l'autre.
- **Recherche** dans tous les vaults (Ctrl+K), raccourcis clavier (`?`),
  presse-papiers effacé après le délai réglé, verrouillage après
  inactivité, réglages qui suivent le compte (chiffrés).
- **Générateurs** : mots de passe, phrases de passe (liste EFF), clés SSH
  Ed25519, RSA et ECDSA.
- **Import** : Bitwarden (JSON en clair ou protégé, CSV), KeePass 2 et
  KeePassXC (KDBX 3.1 et 4, fichier clé, pièces jointes et historique),
  CSV de Chrome, Firefox, LastPass et KeePassXC. **Export** : JSON chiffré
  par mot de passe ou en clair, CSV.

### Le partage

- **Vaults partagés** : la clé d'un vault est enveloppée pour la clé
  publique de chaque membre ; rôles lecteur / éditeur / admin /
  propriétaire ; invitations, y compris vers quelqu'un qui n'a pas encore
  de compte ; **empreintes** à vérifier hors bande, épinglées, alerte si
  elles changent ; rotation de clé après un départ.
- **Liens de partage** (« Send ») : un texte, un élément ou un fichier
  transmis à quelqu'un sans compte, la clé dans le fragment du lien
  (jamais vue par le serveur), avec expiration, nombre d'ouvertures et mot
  de passe facultatif.
- **Accès d'urgence** : un proche pourra lire certains de vos vaults si
  vous ne refusez pas sa demande avant la fin d'un délai choisi ; les clés
  lui sont enveloppées côté client, le serveur ne sait que les garder.

### Le compte et la sécurité

- Connexion par **mot de passe maître** (Argon2id 64 Mio, 3 passes, côté
  client) avec second facteur **TOTP** et codes de récupération, ou par
  **passkey** (PRF de WebAuthn, [`docs/PASSKEYS.md`](docs/PASSKEYS.md)).
- **Sessions** : jetons opaques hachés, rotation des jetons de
  rafraîchissement avec détection de rejeu, révocation à distance, alerte
  par e-mail à une connexion depuis une adresse jamais vue.
- **Rapport de santé**, calculé dans le navigateur : mots de passe faibles,
  réutilisés, anciens, **fuités** (Have I Been Pwned par k-anonymat, sur
  demande), sites qui acceptent la 2FA sans code enregistré, clés et cartes
  qui expirent.
- **Synchronisation** : révisions monotones par vault, téléchargement des
  seuls changements, verrou optimiste, flux temps réel (SSE).
- **Suppression du compte** (mot de passe et second facteur redemandés).

## La sécurité, en bref

```
mot de passe maître ─Argon2id─▶ master key ─┬─HKDF─▶ auth key ──▶ serveur (re-hachée Argon2id)
                                            └─HKDF─▶ clé qui scelle la user key
user key ─▶ clé privée X25519 ─▶ clés de vault (une enveloppe par membre) ─▶ items
```

- **Primitives** : XChaCha20-Poly1305, Argon2id, X25519, HKDF-SHA-256.
  Chaque item est lié par l'AAD à son vault, son id et son type : déplacé,
  renommé ou substitué, il ne s'ouvre plus.
- **Le serveur voit** des adresses e-mail, qui est membre de quoi, le
  nombre et le **type** des éléments, des tailles, des dates, les adresses
  IP des sessions — jamais un nom, un site, un identifiant ou un secret.
- **Changer de mot de passe** ne re-chiffre que la user key ; un mot de
  passe maître perdu est **irrécupérable**, par construction.

Le modèle de menace complet — ce qui est couvert, comment, et ce qui ne
l'est pas — est dans [`docs/SECURITY.md`](docs/SECURITY.md) ; la hiérarchie
de clés en détail dans [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Limites connues

À lire avant d'adopter GuiVault ; chacune est détaillée dans
[`docs/SECURITY.md`](docs/SECURITY.md) ou [`docs/ROADMAP.md`](docs/ROADMAP.md).

- **Pas d'audit externe**, pas encore de programme de prime aux bogues.
- **Retour en arrière d'un item** : un serveur malveillant peut resservir
  l'ancienne version chiffrée d'un élément sous une révision qui monte. Le
  manifeste de vault qui l'empêche est prêt dans tous les clients ; il sera
  activé une fois la version de Guiterm qui l'entretient publiée.
- **L'interface web est livrée par le serveur** à chaque chargement : un
  serveur compromis pourrait servir une page qui vole le mot de passe
  maître. C'est la limite de tout coffre web (Bitwarden et Proton
  compris) ; l'application et Guiterm, installés une fois, n'y sont pas
  exposés.
- **Pas de « Secret Key » à la 1Password** : qui vole la base peut attaquer
  hors ligne un mot de passe maître faible. Argon2id le rend coûteux, pas
  impossible — choisissez une phrase de passe longue.
- **Second facteur TOTP seulement** : pas encore de clé de sécurité en
  second facteur ; la connexion par passkey existe dans l'interface web,
  pas encore dans l'extension.
- **Pas de fonctions d'entreprise** : ni SSO, ni SCIM, ni groupes, ni
  politiques imposées aux membres.
- **Pas d'import dédié** depuis 1Password ou Proton Pass, pas d'alias
  d'e-mail.
- **Android** : un coffre local vit dans le dossier privé de l'application,
  que la désinstallation efface (pas encore d'export de fichier) — copiez-le
  vers un serveur pour le mettre à l'abri.
- **Métadonnées** : le serveur sait combien d'éléments de chaque type
  vous avez, et avec qui vous partagez.

## GuiVault face aux autres

GuiVault ne remplace pas un gestionnaire éprouvé pour tout le monde. Voici
où il se situe, honnêtement (état des concurrents à octobre 2026, à
vérifier chez eux).

| | GuiVault | Bitwarden / Vaultwarden | KeePassXC | 1Password | Proton Pass |
|---|---|---|---|---|---|
| Code source | Ouvert (MIT), serveur et clients | Ouvert (GPL/AGPL, certaines parties sous licence Bitwarden) ; Vaultwarden : serveur libre réécrit en Rust | Ouvert (GPL) | Propriétaire | Clients ouverts, serveur fermé |
| Auto-hébergement | Oui (une image, PostgreSQL) | Oui (officiel ou Vaultwarden) | — (un fichier) | Non | Non |
| Sans aucun serveur | Oui (coffre local, convertible en compte) | Non | Oui, c'est son modèle | Non | Non |
| Partage avec rôles | Oui | Oui (organisations) | Non (un fichier partagé) | Oui | Oui |
| Fonctions payantes | Aucune | Premium, Teams, Enterprise (Vaultwarden : tout inclus) | Aucune | Abonnement | Offres Plus et au-delà |
| Audits externes | **Aucun** | Réguliers, publiés | Oui (2023) | Réguliers, SOC 2 | Oui |
| Plateformes | Web, Chrome/Edge/Firefox, Windows, Android, CLI | Toutes, iOS et macOS compris | Windows, macOS, Linux ; mobiles par des applications tierces | Toutes | Toutes |
| Secrets d'infrastructure | Hôtes et clés SSH, AWS, clés d'API ; agent SSH (Guiterm), CLI à références | Agent SSH, CLI, Secrets Manager (produit à part) | Agent SSH, CLI | Le plus complet : agent SSH, CLI à références, intégrations | CLI et agent SSH, récents |
| Protection d'une base volée | Argon2id sur le mot de passe | Argon2id ou PBKDF2 sur le mot de passe | Argon2 sur le fichier | Mot de passe **+ Secret Key** de 128 bits | Mot de passe |
| Langues | Français | Des dizaines | Des dizaines | Des dizaines | Des dizaines |
| Ancienneté | Quelques semaines, un développeur | Depuis 2016, une entreprise | Depuis 2016, une communauté | Depuis 2006, une entreprise | Depuis 2023, Proton |

**Choisissez plutôt…**

- **Bitwarden, ou Vaultwarden avec les clients officiels**, si vous voulez
  aujourd'hui un gestionnaire auto-hébergeable, audité, sur toutes les
  plateformes, iPhone compris. Pour auto-héberger, c'est la référence
  mûre.
- **KeePassXC** si vous êtes seul, ne voulez rien héberger et vous
  satisfaites d'un fichier synchronisé par vos soins.
- **1Password** pour une famille ou une entreprise qui veut le plus
  abouti, un support, la Secret Key et le mode voyage, et accepte le cloud
  et le code fermé.
- **Proton Pass** si vous vivez déjà dans l'écosystème Proton (Mail,
  Drive, VPN), voulez des alias d'e-mail et ne voulez rien héberger.

**Choisissez GuiVault** si vous hébergez vous-même, administrez des
machines et voulez vos clés SSH et accès cloud au même endroit que vos mots
de passe ; si vous voulez commencer sans serveur et pouvoir partager plus
tard sans changer d'outil ; si le cas du serveur compromis compte pour
vous — et si vous acceptez la jeunesse du projet.

## Installer les clients

- **Application Windows et Android** : la dernière
  [release `app-v*`](https://github.com/GulliGulli28/GuiVault/releases)
  (sommes SHA-256 jointes ; l'APK est attesté par le CI). L'application
  Windows se met à jour d'elle-même ; sur Android, installer l'APK suivant
  par-dessus.
- **Extension** : `cd web && npm install && npm run build:ext`, puis
  « Charger l'extension non empaquetée » sur `web/dist-extension`
  ([`docs/EXTENSION.md`](docs/EXTENSION.md)).
- **`gv`** : `cargo build --release -p guivault-cli` → `target/release/gv`.
- **Interface web** : rien à installer, elle est servie par le serveur.

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
proxy TLS** avant de l'exposer : soit le vôtre (Traefik, nginx, Caddy…) en
lui déclarant l'adresse de votre proxy (voir plus bas), soit le profil
intégré :

```bash
GUIVAULT_DOMAIN=vault.example.com docker compose --profile tls up -d
```

**HTTPS n'est pas optionnel pour l'interface web.** En clair, un navigateur
place la page hors « contexte sécurisé » et lui retire une partie de
l'API WebCrypto ; surtout, quiconque est sur le chemin peut remplacer son
JavaScript par une version qui vole le mot de passe maître. La page
affiche un avertissement rouge dans ce cas. Pour un essai rapide sans
certificat, passez par un tunnel SSH — `localhost` est un contexte
sécurisé :

```bash
ssh -N -L 8082:127.0.0.1:8082 mon-serveur
```

### Derrière votre propre reverse proxy

`GUIVAULT_TRUST_PROXY` dit **qui** a le droit d'annoncer l'IP du client via
`X-Forwarded-For` — ce qui décide du rate-limit des routes
d'authentification et de ce qu'écrit le journal d'audit. Donnez-lui
l'adresse (ou le réseau) de votre proxy :

```ini
GUIVAULT_TRUST_PROXY=172.18.0.0/16      # le réseau Docker du proxy
# ou 192.168.1.10, ou plusieurs séparés par des virgules
```

Le serveur ne lit alors l'en-tête que si la connexion vient de là — et une
adresse de connexion TCP, contrairement à un en-tête, ne se falsifie pas.
Quelqu'un qui joindrait le port directement se fait donc limiter sur sa
vraie IP.

`true` reste accepté : l'en-tête est cru quel qu'en soit l'émetteur. À ne
garder que si le port est réellement injoignable autrement (publié sur
`127.0.0.1` avec un proxy sur la même machine et *pas* en conteneur, ou pas
publié du tout). `false` (défaut) ignore l'en-tête.

### Premier compte

Le serveur ne peut pas créer de compte (il n'a jamais le mot de passe
maître). En mode `invite_only` (défaut), mettez votre adresse dans
`GUIVAULT_ALLOWED_EMAILS`, inscrivez-vous depuis Guiterm ou depuis
l'interface web (`https://vault.example.com/`), puis invitez les autres
depuis un vault partagé : une invitation autorise l'inscription — ou,
administrateur (voir ci-dessous), ouvrez-la à une adresse.

### Administration

Un compte devient administrateur du serveur depuis le shell du serveur —
jamais par l'API, pour qu'une session volée ne puisse pas s'en donner
d'autres :

```bash
docker compose exec guivault guivault admin grant vous@example.com
docker compose exec guivault guivault admin list     # ou revoke <email>
```

L'entrée « Administration » apparaît alors dans l'interface web : état du
serveur, comptes (dernière activité, vaults, taille stockée, quota),
désactivation (sessions coupées, rien d'effacé), suppression (ses vaults
partagés avec d'autres passent au membre le mieux placé), et inscriptions
ouvertes à une adresse — utile en `invite_only` sans vault à partager, ou
en `closed`. Un administrateur voit des métadonnées, jamais un contenu, et
ne peut ni désactiver ni supprimer un autre administrateur.

### E-mails (facultatifs)

Avec `GUIVAULT_SMTP_URL` et `GUIVAULT_SMTP_FROM`, le serveur prévient :
l'invité d'un vault (et lui dit de créer son compte s'il n'en a pas), une
adresse à qui l'administration ouvre l'inscription, le titulaire d'un
compte à chaque connexion depuis une adresse IP jamais vue (90 jours), à
chaque changement de mot de passe maître ou de second facteur, et les deux
parties d'un accès d'urgence à chaque étape — surtout le donneur quand son
contact **demande** l'accès, avec la date à laquelle il sera ouvert sans
refus, puis les deux quand il s'ouvre. **Rien n'en dépend** : sans SMTP, avec un SMTP mal réglé ou en
panne, chaque action réussit quand même (l'envoi part après, en
arrière-plan ; un échec est journalisé) et tout reste visible dans les
clients. Un message ne contient ni secret, ni nom de vault, ni autre lien
que `GUIVAULT_PUBLIC_URL`. Administration › Serveur dit si les e-mails
marchent et envoie un e-mail d'essai.

### Interface web

Le binaire sert à `/` une application (React) qui
fait exactement ce que fait Guiterm avec le serveur : dériver les clés du
mot de passe maître dans le navigateur, déchiffrer les vaults, chiffrer ce
qu'elle écrit. Le serveur ne voit pas plus de choses qu'avec Guiterm. Rien
n'est conservé après fermeture de l'onglet (les
empreintes, les paramètres Argon2id épinglés et les dernières révisions vues
des vaults mis à part) ; le modèle de menace propre au web est
dans [`docs/SECURITY.md`](docs/SECURITY.md).

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `GUIVAULT_DATABASE_URL` | — | URL PostgreSQL (obligatoire) |
| `GUIVAULT_SECRET` | — | ≥ 32 caractères (obligatoire) |
| `GUIVAULT_BIND` | `0.0.0.0:8080` | Adresse d'écoute |
| `GUIVAULT_REGISTRATION` | `invite_only` | `open` / `invite_only` / `closed` |
| `GUIVAULT_ALLOWED_EMAILS` | — | Adresses ou `@domaines` toujours autorisés à s'inscrire |
| `GUIVAULT_TRUST_PROXY` | `false` | IP/CIDR des proxys autorisés à poser `X-Forwarded-For` (`true` = tous, voir ci-dessous) |
| `GUIVAULT_ACCESS_TTL_SECS` | `900` | Durée du jeton d'accès |
| `GUIVAULT_REFRESH_TTL_SECS` | `2592000` | Durée du jeton de rafraîchissement (30 j) |
| `GUIVAULT_INVITATION_TTL_SECS` | `1209600` | Durée d'une invitation (14 j) |
| `GUIVAULT_MAX_ITEM_BYTES` | `1048576` | Taille max d'un item chiffré |
| `GUIVAULT_ITEM_HISTORY` | `20` | Versions précédentes gardées par item (historique, chiffrées) ; `0` : ni historique ni corbeille |
| `GUIVAULT_TRASH_DAYS` | `30` | Jours qu'un élément supprimé reste dans la corbeille |
| `GUIVAULT_SEND_MAX_DAYS` | `30` | Durée de vie maximale d'un lien de partage (jours) ; `0` : liens désactivés, routes publiques comprises |
| `GUIVAULT_HEALTH_LOOKUPS` | `true` | Relayer les recherches du rapport de santé (fuites par k-anonymat, liste des sites à 2FA) ; `false` : aucune requête sortante |
| `GUIVAULT_HIBP_URL` / `GUIVAULT_2FA_DIRECTORY_URL` | services publics | Où les relayer (miroir interne, tests) |
| `GUIVAULT_MAX_ATTACHMENT_MB` | `100` | Taille maximale d'une pièce jointe (chiffrée) ; `0` : pièces jointes désactivées |
| `GUIVAULT_QUOTA_MB` | `0` | Quota de stockage par compte (Mio de chiffrés dans les vaults qu'il possède) ; `0` : aucun. Modifiable compte par compte dans l'administration |
| `GUIVAULT_ALLOWED_IPS` | — | Plages (IP/CIDR, séparées par des virgules) seules servies : API, interface, liens de partage ; `/api/v1/health` reste joignable. Vide : toutes |
| `GUIVAULT_ADMIN_ALLOWED_IPS` | — | Plages d'où l'administration (`/admin`) répond ; vide : toutes |
| `GUIVAULT_SMTP_URL` | — | E-mails, facultatifs : `smtps://utilisateur:motdepasse@hote:465` ou `smtp://…:587?tls=required` (STARTTLS). Sans lui, ou injoignable, tout fonctionne pareil |
| `GUIVAULT_SMTP_FROM` | — | Expéditeur, ex. `GuiVault <coffre@exemple.fr>` (requis avec `GUIVAULT_SMTP_URL`) |
| `GUIVAULT_PUBLIC_URL` | — | L'adresse publique du serveur (`https://vault.exemple.fr`), citée dans les e-mails ; elle active aussi la **connexion par passkey** (son domaine est le site des passkeys, son origine la seule acceptée — voir `docs/PASSKEYS.md`) |
| `GUIVAULT_BACKUP_DIR` | — (`/backups` avec le compose) | Dossier des sauvegardes automatiques ; vide : aucune |
| `GUIVAULT_BACKUP_INTERVAL_HOURS` / `_KEEP` | `24` / `7` | Fréquence ; nombre gardé |
| `GUIVAULT_BACKUP_VERIFY_DATABASE_URL` | — (réglée par le compose) | Base d'essai où chaque sauvegarde est restaurée et comparée — **effacée à chaque fois** : vide ou réservée à ça (créée si absente sur le même Postgres) |
| `GUIVAULT_AUTH_RATE_PER_SECOND` / `_BURST` | `2` / `10` | Rate-limit par IP des routes d'auth |
| `GUIVAULT_LOG_JSON` | `false` | Journaux en JSON |
| `RUST_LOG` | `info,sqlx=warn` | Filtre de journalisation |

### Sauvegardes

Le serveur se sauvegarde lui-même : `GUIVAULT_BACKUP_DIR` (activé par le
`docker-compose.yml` fourni, volume `backups`) reçoit toutes les
`GUIVAULT_BACKUP_INTERVAL_HOURS` un fichier `guivault-AAAAMMJJ-….jsonl.gz`,
les `GUIVAULT_BACKUP_KEEP` derniers gardés. Chaque sauvegarde est
**vérifiée** : relue en entier (gzip, chaque ligne, nombres et SHA-256 par
table), et — avec `GUIVAULT_BACKUP_VERIFY_DATABASE_URL`, réglée par le
compose — **restaurée dans une base d'essai** puis re-sauvegardée : mêmes
lignes, mêmes empreintes, ou la sauvegarde est marquée échouée. L'état est
dans Administration › Sauvegardes (en rouge si la dernière a échoué ou si
la dernière réussie est trop vieille), avec « Sauvegarder maintenant ».

```bash
docker compose exec guivault guivault backup create /backups          # à la main
docker compose exec guivault guivault backup verify /backups/guivault-….jsonl.gz
# Restaurer : dans une base vide (ou où le serveur a seulement démarré),
# serveur arrêté ; le schéma de la sauvegarde est recréé puis mis à jour.
docker compose stop guivault
docker compose run --rm guivault backup restore /backups/guivault-….jsonl.gz
```

**Copiez le dossier ailleurs** (autre disque, autre machine) : une
sauvegarde à côté de la base ne protège pas de la perte du disque. Le
fichier ne contient aucun secret en clair — sans le mot de passe maître de
chacun il est inutile —, mais tout ce qu'a la base (adresses, hachés,
chiffrés) : à protéger comme elle. `GUIVAULT_SECRET` n'y est pas : gardez-le
à part ; sans lui, les seconds facteurs TOTP restaurés sont à réenrôler.
`pg_dump` reste possible, à côté.

**Un mot de passe maître perdu est irrécupérable** — il n'y a pas de
« réinitialisation » possible côté serveur, par construction.

## Développement

```bash
scripts/test-db.sh        # Postgres jetable dans Docker (port 55432)
cargo test                # unitaires + intégration bout en bout (vrai serveur, vraie crypto)
cargo clippy --all-targets && cargo fmt --all --check
cd web && npm install && npm test && npm run lint && npm run build   # interface web
cd web && npm run build:ext && npm run test:ext                      # extension et son corpus de remplissage
cd web && npm run build:app                                          # interface de l'application
cd app-tauri && cargo build && cd ../web && npm run test:app         # application, pilotée par WebDriver
```

L'interface web est embarquée dans le binaire au moment de `cargo build`
(`web/dist`, créé par `npm run build`) ; sans ce build, le serveur compile
quand même et répond sur `/` que l'interface manque. Pour travailler dessus
avec rechargement à chaud : `cargo run` d'un côté, `cd web && npm run dev`
de l'autre (Vite sert sur `http://localhost:1430` et proxifie `/api` vers
le serveur).

Structure :

- `crates/guivault-crypto` — primitives et hiérarchie de clés, partagées
  avec les clients. **Tout le chiffrement se passe ici, côté client.**
- `crates/guivault-protocol` — types JSON de l'API.
- `crates/guivault-items` — les formats en clair des secrets, pour qu'un
  client Rust les lise sans les redéfinir. Testé contre ce que l'interface
  web écrit.
- `crates/guivault-server` — le serveur (axum + sqlx/PostgreSQL), qui sert
  aussi l'interface web.
- `crates/guivault-local` — le coffre local : ce que garde le serveur, dans
  un dossier, sans clé ni crypto.
- `crates/guivault-cli` — `gv`.
- `web/` — l'interface web (Vite + React + TypeScript). `src/lib/crypto.ts`
  est le port de `guivault-crypto` ; des vecteurs générés par le crate Rust
  (et réciproquement) garantissent que les deux lisent les mêmes blobs.
  `web/extension/` : l'extension, sur le même code ; `web/app/` : l'interface
  de l'application.
- `app-tauri/` — l'application Windows et Android (Tauri 2, workspace Cargo
  à part ; le Kotlin d'Android dans `gen/android`).

Guiterm consomme `guivault-crypto`, `guivault-protocol` et `guivault-items`
en dépendances git, épinglées sur un commit : une réponse qui change casse
la compilation des deux côtés au lieu de diverger.

## Documentation

| Document | Contenu |
|---|---|
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Fonctionnement, hiérarchie de clés, synchronisation |
| [`SECURITY.md`](docs/SECURITY.md) | Modèle de menace : couvert, assumé, limites |
| [`API.md`](docs/API.md) | Routes et codes d'erreur |
| [`ITEMS.md`](docs/ITEMS.md) | Formats des éléments, import et export |
| [`EXTENSION.md`](docs/EXTENSION.md) | Extension de navigateur |
| [`APP.md`](docs/APP.md) | Application, coffre local, publication des versions |
| [`ANDROID.md`](docs/ANDROID.md) · [`REMPLISSAGE.md`](docs/REMPLISSAGE.md) | Android, service de remplissage |
| [`CLI.md`](docs/CLI.md) | `gv` |
| [`PASSKEYS.md`](docs/PASSKEYS.md) · [`PIECES-JOINTES.md`](docs/PIECES-JOINTES.md) · [`TRANSFERT.md`](docs/TRANSFERT.md) · [`MANIFESTE.md`](docs/MANIFESTE.md) | Conceptions détaillées |
| [`DESIGN.md`](docs/DESIGN.md) | Charte et règles de l'interface |
| [`ROADMAP.md`](docs/ROADMAP.md) | Ce qui est fait, ce qui reste |

## Signaler une vulnérabilité

Par une [*security advisory* privée](https://github.com/GulliGulli28/GuiVault/security/advisories/new)
sur GitHub, pas par une issue publique.

## Licence

MIT.
