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
| Serveur malveillant qui **modifie** des données | Chaque blob est AEAD. L'AAD lie un item à son vault, son id et son type : un item déplacé, renommé ou substitué ne s'ouvre plus. Un morceau de pièce jointe est lié à sa pièce jointe, à sa place et au fait d'être le dernier : ni réordonné, ni tronqué, ni emprunté à un autre fichier. |
| Serveur malveillant qui **rejoue** une ancienne version d'un vault (ou base restaurée depuis une sauvegarde) | Les clients retiennent la dernière révision vue de chaque vault (web et extension : `web/src/lib/vaultRevisions.ts`, `localStorage` ; Guiterm : `SyncState::vault_revisions`) et, si le serveur en annonce une plus basse, le disent en rouge jusqu'à ce que l'utilisateur en prenne acte. Guiterm **suspend** en plus la synchronisation de ce vault (ni pull, ni push, ni suppression) jusqu'à reprise explicite, où sa version fait foi. Non couvert cryptographiquement : voir « Limites ». |
| Serveur malveillant qui **substitue une clé publique** pour lire un vault partagé | C'est l'attaque principale contre tout système de partage E2E. Défense : l'**empreinte** de la clé publique (`fingerprint`) est renvoyée partout où une clé publique apparaît ; le client DOIT l'afficher et demander une vérification hors bande (voix, messagerie interne) avant le premier partage vers une personne, puis épingler la clé (TOFU) et alerter si elle change. Dans l'autre sens, l'enveloppe de la clé de vault est authentifiée (format 2) : le destinataire voit l'empreinte de qui la lui a remise et la vérifie de même. |
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
| Serveur malveillant qui **dicte des paramètres KDF faibles** au prelogin (`m_cost = 8, t_cost = 1` : la clé d'auth reçue se casse hors ligne, et le mot de passe maître avec) | Les clients appliquent les mêmes bornes avant de dériver (`MasterKey::derive` côté Rust, `deriveMasterKey` / `deriveExportKey` côté web) : hors bornes, rien n'est calculé ni envoyé. Plancher = minimum OWASP (19 MiB, 2 passes). Au-dessus du plancher, les paramètres sont **épinglés** par appareil (serveur + e-mail) après chaque déverrouillage réussi — qui prouve qu'ils sont les vrais — et un prelogin qui les fait baisser (moins de mémoire ou de passes) est refusé avant de dériver (`KdfParams::weaker_than` ; web : `web/src/lib/kdfPins.ts` ; Guiterm : `KnownAccount::kdf` dans `accounts.json`). Aucun client ne choisit de paramètres plus faibles que les précédents : une baisse ne peut venir que du serveur. Première connexion depuis un appareil : seul le plancher protège. |
| Lien de partage intercepté ou transféré | Le lien porte la clé (fragment `#…`, jamais envoyé au serveur ni dans un `Referer` : `Referrer-Policy: no-referrer`). Expiration obligatoire (`GUIVAULT_SEND_MAX_DAYS`), nombre d'ouvertures borné, et un **mot de passe** facultatif qui entre dans la dérivation des clés : sans lui, le lien seul n'ouvre rien. La page n'ouvre le contenu qu'au clic (« Ouvrir ») — l'aperçu d'une messagerie ne consomme pas de vue — puis retire le secret de la barre d'adresse. |
| Serveur (ou voleur de la base) qui veut lire un lien de partage | Il n'a que le chiffré et `SHA-256(access_key)` ; la clé de contenu et la clé d'accès sont tirées d'un secret de 128 bits qu'il ne voit jamais. Avec un mot de passe, même le lien complet ne suffit pas : il faudrait aussi casser un Argon2id 64 MiB. Il ne remet le chiffré qu'à qui présente `access_key` (qui n'a que l'identifiant ne peut ni lire, ni consommer une vue), efface le chiffré à la dernière vue et la ligne à l'expiration. Mot de passe deviné en ligne : frein par IP des routes d'authentification. |
| **Accès d'urgence** détourné par le serveur | Le serveur garde des enveloppes (`wrap_emergency_key`) qu'il ne sait pas ouvrir : au pire, il les remet **au contact choisi** avant la fin du délai — jamais à lui-même ni à un tiers. Le donneur enveloppe vers une clé dont il a vérifié l'empreinte (comme pour un partage), et le contact n'ouvre qu'une enveloppe dont l'expéditeur est l'empreinte qu'il a épinglée en acceptant : un vault fabriqué par le serveur « au nom » du donneur est écarté. Le contexte propre à l'urgence (HKDF et AAD) empêche d'installer l'enveloppe comme appartenance au vault. Rien de comparable à la récupération de compte critiquée chez Bitwarden, où le serveur garde de quoi rouvrir le coffre. |
| Recherche de fuites (rapport de santé) qui livrerait les mots de passe | k-anonymat : le client n'envoie que les 5 premiers caractères hexadécimaux du SHA-1 d'un mot de passe (un préfixe partagé par des centaines de mots de passe connus), reçoit tous les suffixes de ce préfixe — **avec remplissage**, pour que la taille de la réponse ne dise pas combien il y en a — et cherche le sien lui-même. Ni le serveur ni Have I Been Pwned ne voient le mot de passe ou son empreinte ; le relais cache en plus l'adresse de l'utilisateur au service. Seulement sur demande (« Rechercher les fuites »), désactivable pour tout le serveur (`GUIVAULT_HEALTH_LOOKUPS=false`). |
| **Administrateur du serveur** (rôle `is_admin`, ou sa session volée) | Il voit ce que voit déjà le serveur — adresses, dates, tailles, nombre d'items — et rien de plus : aucune route d'administration ne rend un chiffré, et il n'a aucune clé. Il peut désactiver ou supprimer un compte (déni de service assumé, audité `admin.*`), pas un autre administrateur. Le rôle ne se donne que depuis le shell du serveur (`guivault admin grant`) : une session volée ne s'en fabrique pas d'autres. `GUIVAULT_ADMIN_ALLOWED_IPS` restreint d'où il agit. |
| Serveur exposé à tout Internet | `GUIVAULT_ALLOWED_IPS` : hors des plages, `403 ip_not_allowed` sur tout (API, interface, liens) sauf la sonde de santé — sur l'adresse du client selon `GUIVAULT_TRUST_PROXY`. Défense en profondeur, pas un substitut au mot de passe maître. |
| E-mails (facultatifs) détournés pour hameçonner ou spammer | Aucun message ne contient de secret, de nom de vault (chiffré) ni de lien autre que l'adresse publique du serveur ; chacun rappelle que GuiVault ne demande jamais le mot de passe maître. Au plus 30 e-mails par heure vers d'autres adresses par compte. L'alerte de connexion depuis une IP inconnue et celles de changement de mot de passe ou de second facteur signalent un vol de mot de passe maître. Rien ne dépend de leur arrivée. |
| Sauvegarde volée | Même contenu que la base (voir la première ligne) : rien de lisible sans les mots de passe maîtres. Fichiers `0600`, dossier `0700` dans l'image. `GUIVAULT_SECRET` n'y est pas (à garder à part). |
| Sauvegarde corrompue ou incomplète découverte le jour où on en a besoin | Chaque sauvegarde est relue (gzip, lignes, SHA-256 par table) et, avec une base d'essai, restaurée puis re-sauvegardée à l'identique ; une table du schéma inconnue du format fait échouer la sauvegarde plutôt que de l'omettre. L'échec est visible dans l'administration. |
| Compte qui remplit le disque | Quota par compte (`GUIVAULT_QUOTA_MB`, ou fixé par un administrateur) sur les chiffrés vivants des vaults qu'il possède ; `507 quota_exceeded`. |
| Blobs de taille arbitraire | Tailles bornées par champ ; taille max d'item configurable ; limite globale du corps. |
| Mutex empoisonné, panique, surcharge | Runtime tokio, timeouts de 30 s, arrêt gracieux SIGTERM. |

## Ce que le serveur voit (assumé)

Adresses e-mail, appartenance aux vaults et rôles, nombre et **types**
d'items (`host`, `ssh-key`, `password`…), dates, révisions, IP/user-agent
des sessions, journal d'audit. Ces métadonnées suffisent à dire « Alice
partage 12 hôtes et 3 clés avec Bob », jamais lesquels. Des **pièces
jointes**, il voit la taille chiffrée (donc, à 41 octets par Mio près, la
taille du fichier), quand elles sont ajoutées, et à quel item elles
appartiennent — ni leur nom, ni leur type, ni leur contenu : chacune est
chiffrée sous une clé propre, gardée dans l'item. Des réglages
synchronisés, il voit la taille du blob et quand il change (chaque réglage
d'apparence modifié en est un) — pas son contenu. De l'historique et de la
corbeille, il garde les versions précédentes **chiffrées** (combien, quand,
remplacées par qui) : un item supprimé reste récupérable `GUIVAULT_TRASH_DAYS`
jours, y compris par qui obtiendrait la base **et** la clé du vault — ce que
« Supprimer définitivement » (corbeille) efface tout de suite. Un ancien
membre n'y a plus accès (404), et la rotation qui suit son départ
re-chiffre les versions sous la nouvelle clé.

Des **liens de partage**, il voit qui en crée, quand, leur taille, s'ils ont
un mot de passe, leurs expirations et chaque ouverture (date, IP) — pas leur
contenu ni leur nom (dans la fiche de l'auteur, sous sa user key). Du **rapport de santé**, rien, sauf s'il relaie la recherche de fuites :
alors des préfixes de 5 caractères de SHA-1 (et leur nombre, à peu près
celui des mots de passe distincts du coffre), et qui demande la liste des
sites à 2FA. De
l'**accès d'urgence**, il voit qui a désigné qui, pour quels vaults, le
délai, et chaque étape (acceptation, demande, accord, refus) — ce qu'il faut
pour appliquer le délai.

## Limites connues

- **Pas de protection cryptographique contre le rejeu/rollback par le
  serveur** : un serveur malveillant peut renvoyer une ancienne version
  chiffrée d'un item (l'AAD ne contient pas la révision, pour que la
  rotation reste possible sans re-chiffrer sous une révision). Les clients
  détectent une **révision de vault qui recule** — ce que produit une base
  restaurée, ou un serveur qui rejoue sans maquiller — mais la révision
  n'est pas authentifiée : un serveur qui sert d'anciens chiffrés sous des
  révisions qui montent passe. Le **manifeste de vault** qui le couvre est
  en cours (`MANIFESTE.md`) : serveur, web, extension, `gv` et Guiterm
  prêts, pas encore activé tant que ce Guiterm n'est pas publié. Une fois actif, il restera cette
  limite assumée : n'importe quel membre (lecteur compris) peut écrire un
  manifeste valide.
- **Vault fabriqué par le serveur.** Un serveur malveillant peut créer un
  vault avec une clé à lui et y inscrire un utilisateur, pour qu'il y range
  des secrets. Les enveloppes de format 2 sont authentifiées : il ne peut
  pas en produire une au nom d'un membre — seulement sous sa propre clé, ou
  sous une clé qu'il ferait passer pour celle d'un membre dans la liste des
  membres. Le client montre donc qui a remis la clé (réglages du vault) et
  signale « clé non vérifiée » tant que l'empreinte de l'expéditeur n'est
  pas épinglée : c'est la **vérification de cette empreinte**, par le
  destinataire, qui ferme la porte — dès l'invitation : l'enveloppe y est
  jointe et s'ouvre avant d'accepter, et une clé différente de celle déjà
  vérifiée pour l'inviteur bloque l'acceptation. Une enveloppe de format 1
  (anonyme, d'avant) ne dit rien de son auteur ; une rotation de clé la
  remplace.
  Contrairement à une signature, l'authentification X25519 ne prouve rien
  à un tiers (le destinataire aurait pu fabriquer l'enveloppe lui-même) —
  inutile ici, où seul le destinataire a besoin de savoir.
- **Le délai de l'accès d'urgence est appliqué par le serveur**, pas par la
  cryptographie : un serveur compromis peut remettre les enveloppes au
  contact sans attendre (le contact étant, par construction, quelqu'un à qui
  le donneur a déjà confié ses clés). Sans alerte par e-mail (pas de SMTP
  encore), le donneur découvre une demande à sa connexion suivante : le
  délai doit en tenir compte. Ce que le contact a lu pendant un accès
  accordé, il a pu le garder : reprendre la main n'efface pas sa mémoire,
  une rotation de clé si.
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
- **Copie hors ligne** (Paramètres › Sécurité, et réglages du popup de
  l'extension ; **désactivée par défaut, par appareil**) : pour ouvrir le
  coffre quand le serveur ne répond pas, en lecture seule. Elle contient ce
  que le serveur garde, rien de plus — le compte enveloppé (paramètres
  Argon2id, user key et clé privée scellées), les clés de vault enveloppées,
  les noms et items chiffrés — dans l'IndexedDB de l'origine (le serveur
  pour le web, l'extension pour elle). Elle s'ouvre comme la connexion :
  Argon2id sur le mot de passe maître (plancher compris), puis
  déchiffrement. Sur le disque, elle vaut une copie de la base : rien
  d'exploitable sans le mot de passe maître, mais attaquable hors ligne —
  c'est le compromis de Bitwarden, à ne pas activer sur un ordinateur
  partagé. Le second facteur ne la protège pas (il protège la session au
  serveur). Pour que la page s'ouvre sans le serveur, l'interface web
  garde aussi son code dans le cache du navigateur (`public/sw.js`,
  service worker) : réseau d'abord pour les pages, cache seulement s'il ne
  répond pas, jamais l'API — une page en ligne est toujours celle du
  serveur ; un `sw.js` modifié remplace l'ancien au chargement suivant.
- **Rien n'atteint le disque et rien ne survit à l'onglet** (hors copie
  hors ligne activée, ci-dessus) : jetons et
  clés sont dans le `sessionStorage` de l'onglet — la page peut donc se
  recharger sans redemander le mot de passe maître, mais fermer l'onglet
  efface tout, et un autre onglet n'y a pas accès. Un délai d'inactivité
  réglable (Paramètres › Sécurité, 15 min par défaut) les efface avant
  cela ; `0` ne garde la session que le temps de l'onglet. Le
  `sessionStorage` est lisible par un script de cette origine, mais la CSP
  n'en laisse tourner aucun d'autre que l'application, et un script injecté
  dans l'application aurait de toute façon les clés en mémoire. Les items
  déchiffrés, eux, ne sont jamais stockés. Seules les empreintes épinglées,
  les paramètres Argon2id épinglés, la dernière révision vue de chaque
  vault et les préférences d'affichage sont en `localStorage`, ils ne sont
  pas secrets.
- La dérivation Argon2id (64 MiB, 3 passes) tourne en JavaScript : une à
  deux secondes à la connexion, comme dans Guiterm.
- Les mêmes règles d'empreinte s'appliquent : inviter quelqu'un ou faire
  tourner une clé exige que son empreinte ait été vérifiée hors bande et
  épinglée dans *ce* navigateur.

- **CORS ouvert sur `/api/v1`** (pour l'extension de navigateur) : sans
  cookie ni session ambiante, une page tierce ne peut rien faire sans le
  jeton porteur ; l'en-tête `Access-Control-Allow-Origin: *` n'expose donc
  rien. Voir `docs/EXTENSION.md` pour le modèle de menace de l'extension.

## Ligne de commande (`gv`)

Même cryptographie, même plancher Argon2id et mêmes paramètres épinglés
que les autres clients. Ce qu'elle garde sur le disque (`0700`/`0600`,
détail dans `docs/CLI.md`) : le compte **enveloppé** et les jetons
(`account.json`), un cache des vaults **chiffré** (lisible sans le serveur),
et la user key + clé privée scellées sous une clé de session aléatoire
(`session.json`) que seule la coquille détient (`GUIVAULT_SESSION`, comme
`BW_SESSION` chez Bitwarden). Qui lit l'environnement de vos processus, ou
d'une commande lancée par `gv run`, lit ces secrets : c'est le prix d'une
session sans mot de passe à chaque commande. `gv lock` rend la clé de
session inutile, `gv logout` révoque la session au serveur et efface tout.
Les jetons de rafraîchissement tournent à chaque usage ; un verrou empêche
deux `gv` de faire tourner le même (le serveur y verrait un vol et
révoquerait la session).

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
