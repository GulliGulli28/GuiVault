# Modèle de sécurité

## Objectif

Un administrateur du serveur — ou quiconque a volé la base, les sauvegardes
ou la machine — **ne doit pas pouvoir lire un seul secret**, ni se faire
passer pour un utilisateur, ni modifier silencieusement des données
chiffrées.

## Menaces couvertes

| Menace | Réponse |
|---|---|
| Fuite de la base (dump, sauvegarde, disque) | Aucune clé côté serveur. Les blobs sont XChaCha20-Poly1305 sous des clés dérivées d'un mot de passe maître via Argon2id (64 MiB, 3 passes). La clé d'authentification est re-hachée (Argon2id) : le dump ne permet pas non plus de se connecter. Les jetons sont stockés hachés (SHA-256). |
| Serveur malveillant qui **modifie** des données | Chaque blob est AEAD. L'AAD lie un item à son vault, son id et son type : un item déplacé, renommé ou substitué ne s'ouvre plus. |
| Serveur malveillant qui **rejoue** une ancienne version d'un item | Non couvert cryptographiquement (voir « Limites »). Le client peut détecter un retour en arrière de `revision`. |
| Serveur malveillant qui **substitue une clé publique** pour lire un vault partagé | C'est l'attaque principale contre tout système de partage E2E. Défense : l'**empreinte** de la clé publique (`fingerprint`) est renvoyée partout où une clé publique apparaît ; le client DOIT l'afficher et demander une vérification hors bande (voix, messagerie interne) avant le premier partage vers une personne, puis épingler la clé (TOFU) et alerter si elle change. |
| Vol du mot de passe maître seul (hameçonnage, épaule) | Second facteur TOTP optionnel : sans le code, pas de session. Ne protège pas contre un vol de mot de passe **plus** un dump de base. |
| Vol d'un jeton d'accès | Durée 15 min. Révocable (sessions). |
| Vol d'un jeton de rafraîchissement | Rotation à chaque usage ; le rejeu de l'ancien révoque la session entière. |
| Force brute sur le mot de passe (en ligne) | Rate-limit par IP sur `/auth/*` ; réponses 401 uniformes ; hachage à coût constant même pour un e-mail inconnu (pas de différence de temps mesurable). |
| Force brute (hors ligne, avec le dump) | Argon2id 64 MiB côté client **puis** Argon2id 19 MiB côté serveur sur la clé d'auth. La clé d'auth est dérivée par HKDF *à côté* de la clé de chiffrement : la casser ne donne rien sur les données sans refaire toute la dérivation depuis le mot de passe. |
| Énumération des comptes | `prelogin` renvoie des paramètres déterministes (HMAC du secret serveur) pour un e-mail inconnu, identiques d'un appel à l'autre. `login` renvoie le même 401 dans les deux cas. `register` renvoie 409 sur doublon (assumé : un serveur d'équipe, les adresses des collègues ne sont pas secrètes). `users/lookup` est réservé aux utilisateurs authentifiés. |
| Accès à un vault dont on n'est pas membre | 404 — sans distinguer « n'existe pas » de « pas à toi ». |
| Escalade de rôle | Un admin ne confère pas plus que son rôle ; ne touche pas au propriétaire ; ne change pas son propre rôle. Un seul propriétaire (contrainte en base). |
| Ancien membre qui garde la clé | Rotation de clé : le serveur exige une enveloppe pour **chaque** membre restant et un chiffré pour **chaque** item vivant, et refuse si la révision a bougé (personne n'écrit avec l'ancienne clé pendant la rotation). Les invitations en attente sont révoquées. |
| Paramètres KDF affaiblis par un client hostile (compte cassable) ou absurdes (DoS du client) | Bornes vérifiées côté serveur (`KdfParams::is_sane`). |
| Serveur malveillant qui **dicte des paramètres KDF faibles** au prelogin (`m_cost = 8, t_cost = 1` : la clé d'auth reçue se casse hors ligne, et le mot de passe maître avec) | Les clients appliquent les mêmes bornes avant de dériver (`MasterKey::derive` côté Rust, `deriveMasterKey` / `deriveExportKey` côté web) : hors bornes, rien n'est calculé ni envoyé. Plancher = minimum OWASP (19 MiB, 2 passes). Au-dessus du plancher, les paramètres sont **épinglés** par appareil (serveur + e-mail) après chaque déverrouillage réussi — qui prouve qu'ils sont les vrais — et un prelogin qui les fait baisser (moins de mémoire ou de passes) est refusé avant de dériver (`KdfParams::weaker_than`, `web/src/lib/kdfPins.ts`). Aucun client ne choisit de paramètres plus faibles que les précédents : une baisse ne peut venir que du serveur. Première connexion depuis un appareil : seul le plancher protège. |
| Blobs de taille arbitraire | Tailles bornées par champ ; taille max d'item configurable ; limite globale du corps. |
| Mutex empoisonné, panique, surcharge | Runtime tokio, timeouts de 30 s, arrêt gracieux SIGTERM. |

## Ce que le serveur voit (assumé)

Adresses e-mail, appartenance aux vaults et rôles, nombre et **types**
d'items (`host`, `ssh-key`, `password`…), dates, révisions, IP/user-agent
des sessions, journal d'audit. Ces métadonnées suffisent à dire « Alice
partage 12 hôtes et 3 clés avec Bob », jamais lesquels. Des réglages
synchronisés, il voit la taille du blob et quand il change (chaque réglage
d'apparence modifié en est un) — pas son contenu.

## Limites connues

- **Pas de protection contre le rejeu/rollback par le serveur** : un
  serveur malveillant peut renvoyer une ancienne version chiffrée d'un item
  (l'AAD ne contient pas la révision, pour que la rotation reste possible
  sans re-chiffrer sous une révision). Un client soigneux refuse une
  révision de vault qui recule.
- **Pas de signature de l'expéditeur** sur les enveloppes de clés (boîte
  scellée = anonyme). Le serveur ne peut pas *lire* une enveloppe, mais il
  pourrait en fabriquer une avec une clé de vault de son choix pour un vault
  qu'il aurait lui-même créé — d'où l'importance de la vérification
  d'empreinte et du fait que le client n'accepte une invitation que si
  l'inviteur affiché est attendu.
- **Le client est dans la base de confiance.** Un Guiterm compromis a le
  mot de passe maître. Rien côté serveur n'y peut quoi que ce soit.
- **Le mot de passe maître est irrécupérable.** Pas de réinitialisation, par
  construction.
- **Le second facteur TOTP protège la session, pas les données.** Son
  secret est déchiffrable par le serveur (il doit vérifier les codes) : un
  serveur compromis peut le lire — mais un serveur compromis n'a de toute
  façon rien d'autre à lire.
- **`users/lookup` et le 409 d'inscription** confirment l'existence d'un
  compte à un utilisateur authentifié (lookup) ou à n'importe qui (409).
  Acceptable pour un serveur d'équipe ; à revoir avant une offre publique
  (e-mail de confirmation à la place du 409).

## Interface web

L'interface servie à `/` fait la même cryptographie que Guiterm, dans le
navigateur (`web/src/lib/crypto.ts`, port de `guivault-crypto`). Le serveur
ne reçoit toujours que la clé d'auth et des enveloppes. Mais le code qui
manipule le mot de passe maître est **livré par le serveur à chaque
chargement** : c'est un cran de moins que le client de bureau, dont le code
est installé une fois et vérifiable.

- **Un serveur (ou un proxy) compromis peut servir une page modifiée** qui
  exfiltre le mot de passe maître. C'est le compromis classique des coffres
  web (même limite que Bitwarden ou Proton) : l'interface web ne protège
  pas contre un opérateur malveillant, seulement contre un opérateur honnête
  dont la base fuit. Qui veut cette garantie-là utilise Guiterm.
- Pour que *rien d'autre* que le binaire ne puisse injecter du code, la page
  est servie avec une CSP stricte (`script-src 'self'`, pas d'inline, pas
  de domaine tiers, `frame-ancestors 'none'`), sans referrer, et le binaire
  n'embarque aucun script externe — l'application est entièrement dans
  `web/dist`, compilée dans l'image.
- **Rien n'atteint le disque et rien ne survit à l'onglet** : jetons et
  clés sont dans le `sessionStorage` de l'onglet — la page peut donc se
  recharger sans redemander le mot de passe maître, mais fermer l'onglet
  efface tout, et un autre onglet n'y a pas accès. Un délai d'inactivité
  réglable (Paramètres › Sécurité, 15 min par défaut) les efface avant
  cela ; `0` ne garde la session que le temps de l'onglet. Le
  `sessionStorage` est lisible par un script de cette origine, mais la CSP
  n'en laisse tourner aucun d'autre que l'application, et un script injecté
  dans l'application aurait de toute façon les clés en mémoire. Les items
  déchiffrés, eux, ne sont jamais stockés. Seules les empreintes épinglées,
  les paramètres Argon2id épinglés et les préférences d'affichage sont en
  `localStorage`, ils ne sont pas secrets.
- La dérivation Argon2id (64 MiB, 3 passes) tourne en JavaScript : une à
  deux secondes à la connexion, comme dans Guiterm.
- Les mêmes règles d'empreinte s'appliquent : inviter quelqu'un ou faire
  tourner une clé exige que son empreinte ait été vérifiée hors bande et
  épinglée dans *ce* navigateur.

- **CORS ouvert sur `/api/v1`** (pour l'extension de navigateur) : sans
  cookie ni session ambiante, une page tierce ne peut rien faire sans le
  jeton porteur ; l'en-tête `Access-Control-Allow-Origin: *` n'expose donc
  rien. Voir `docs/EXTENSION.md` pour le modèle de menace de l'extension.

## Déploiement

- **TLS obligatoire** devant le serveur. Sans TLS, les jetons et la clé
  d'auth passent en clair (les données restent chiffrées, mais une session
  volée permet de supprimer des vaults ou d'injecter des invitations) — et
  surtout, n'importe qui sur le chemin peut remplacer le JavaScript de
  l'interface par une version qui exfiltre le mot de passe maître. Servie
  ailleurs qu'en HTTPS (ou que depuis `localhost`), la page le dit en
  rouge : le navigateur la place hors « contexte sécurisé », ce qui lui
  retire au passage `crypto.randomUUID` et le presse-papiers.
- `GUIVAULT_TRUST_PROXY` : y mettre **l'adresse ou le réseau du proxy**
  plutôt que `true`. L'en-tête `X-Forwarded-For` est écrit par le client
  comme n'importe quel autre ; le croire sans condition laisse choisir son
  IP de rate-limit à qui peut joindre le port directement, donc
  brute-forcer des mots de passe maîtres sans jamais être limité. Avec une
  liste, l'en-tête n'est lu que si l'adresse de la connexion TCP — la seule
  chose qu'un client ne choisit pas — en fait partie. La chaîne est alors
  lue par la droite en sautant les proxys connus : que le proxy écrase
  l'en-tête ou qu'il l'ajoute à la suite, c'est l'adresse qu'il a réellement
  vue qui compte. `true` garde l'ancien comportement (première entrée, sans
  vérification) et suppose le port injoignable autrement.
- **Filtrer sur le nom d'hôte ne remplace pas un port fermé** : `Host` est
  choisi par le client au même titre que `X-Forwarded-For`. Ce qui restreint
  l'accès, c'est le réseau — publication sur `127.0.0.1`, réseau Docker
  privé, ou pare-feu.
- `GUIVAULT_SECRET` ne chiffre rien mais doit rester secret : il rend les
  sels de prelogin fictifs prévisibles s'il fuit (oracle d'existence).
- La base ne contient rien d'exploitable sans mots de passe maîtres, mais
  contient les métadonnées ci-dessus : à traiter comme confidentielle.

## Signaler une vulnérabilité

Ouvrir une *security advisory* privée sur GitHub plutôt qu'une issue
publique.
