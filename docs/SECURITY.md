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
| Vol d'un jeton d'accès | Durée 15 min. Révocable (sessions). |
| Vol d'un jeton de rafraîchissement | Rotation à chaque usage ; le rejeu de l'ancien révoque la session entière. |
| Force brute sur le mot de passe (en ligne) | Rate-limit par IP sur `/auth/*` ; réponses 401 uniformes ; hachage à coût constant même pour un e-mail inconnu (pas de différence de temps mesurable). |
| Force brute (hors ligne, avec le dump) | Argon2id 64 MiB côté client **puis** Argon2id 19 MiB côté serveur sur la clé d'auth. La clé d'auth est dérivée par HKDF *à côté* de la clé de chiffrement : la casser ne donne rien sur les données sans refaire toute la dérivation depuis le mot de passe. |
| Énumération des comptes | `prelogin` renvoie des paramètres déterministes (HMAC du secret serveur) pour un e-mail inconnu, identiques d'un appel à l'autre. `login` renvoie le même 401 dans les deux cas. `register` renvoie 409 sur doublon (assumé : un serveur d'équipe, les adresses des collègues ne sont pas secrètes). `users/lookup` est réservé aux utilisateurs authentifiés. |
| Accès à un vault dont on n'est pas membre | 404 — sans distinguer « n'existe pas » de « pas à toi ». |
| Escalade de rôle | Un admin ne confère pas plus que son rôle ; ne touche pas au propriétaire ; ne change pas son propre rôle. Un seul propriétaire (contrainte en base). |
| Ancien membre qui garde la clé | Rotation de clé : le serveur exige une enveloppe pour **chaque** membre restant et un chiffré pour **chaque** item vivant, et refuse si la révision a bougé (personne n'écrit avec l'ancienne clé pendant la rotation). Les invitations en attente sont révoquées. |
| Paramètres KDF affaiblis par un client hostile (compte cassable) ou absurdes (DoS du client) | Bornes vérifiées côté serveur (`KdfParams::is_sane`). |
| Blobs de taille arbitraire | Tailles bornées par champ ; taille max d'item configurable ; limite globale du corps. |
| Mutex empoisonné, panique, surcharge | Runtime tokio, timeouts de 30 s, arrêt gracieux SIGTERM. |

## Ce que le serveur voit (assumé)

Adresses e-mail, appartenance aux vaults et rôles, nombre et **types**
d'items (`host`, `ssh-key`, `password`…), dates, révisions, IP/user-agent
des sessions, journal d'audit. Ces métadonnées suffisent à dire « Alice
partage 12 hôtes et 3 clés avec Bob », jamais lesquels.

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
- **Pas de 2FA** pour l'instant (voir `ARCHITECTURE.md`).
- **`users/lookup` et le 409 d'inscription** confirment l'existence d'un
  compte à un utilisateur authentifié (lookup) ou à n'importe qui (409).
  Acceptable pour un serveur d'équipe ; à revoir avant une offre publique
  (e-mail de confirmation à la place du 409).

## Déploiement

- **TLS obligatoire** devant le serveur. Sans TLS, les jetons et la clé
  d'auth passent en clair (les données restent chiffrées, mais une session
  volée permet de supprimer des vaults ou d'injecter des invitations).
- `GUIVAULT_TRUST_PROXY=true` **uniquement** derrière un reverse proxy qui
  écrase `X-Forwarded-For` ; sinon n'importe qui choisit son IP de
  rate-limit.
- `GUIVAULT_SECRET` ne chiffre rien mais doit rester secret : il rend les
  sels de prelogin fictifs prévisibles s'il fuit (oracle d'existence).
- La base ne contient rien d'exploitable sans mots de passe maîtres, mais
  contient les métadonnées ci-dessus : à traiter comme confidentielle.

## Signaler une vulnérabilité

Ouvrir une *security advisory* privée sur GitHub plutôt qu'une issue
publique.
