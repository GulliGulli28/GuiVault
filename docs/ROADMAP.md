# Feuille de route

Pistes d'amélioration issues d'un tour complet du code et de ce qui se dit
des autres gestionnaires (Bitwarden surtout, mais aussi 1Password, Proton
Pass, Vaultwarden) — septembre 2026. L'idée : combler leurs défauts connus
et jouer ce que GuiVault a qu'eux n'ont pas (Guiterm, l'angle dev/ops,
l'auto-hébergement sans fonctions « premium »).

Chaque piste respecte la règle n°1 (`CLAUDE.md`) : le serveur ne garde que
des blobs qu'il ne sait pas lire. Cocher au fur et à mesure.

## État (24 septembre 2026)

**Fait** : tout le §0 sauf le manifeste authentifié (plancher et
paramètres Argon2id épinglés, retour en arrière détecté, enveloppes
authentifiées, empreinte de l'inviteur), et dans les §1, §3 et §4 : presse-papiers
effacé, historique et corbeille, copie hors ligne, recherche globale
(Ctrl+K), raccourcis, tri, CLI `gv`. Chaque point est coché ci-dessous avec
où il vit dans le code.

**Ensuite, dans cet ordre** — du plus demandé ou du plus exposé au plus
confortable :

1. **Accès d'urgence et partage éphémère** (§2) : les deux fonctions
   « premium » de Bitwarden qui manquent encore, zero-knowledge sans
   compromis (le serveur garde des blobs qu'il ne lit pas, et libère ou
   expire).
2. **Remplissage plus fiable** (§1, première ligne) : la plainte n°1 contre
   Bitwarden — shadow DOM, iframes de connexion, avec un corpus de pages
   rejoué par Playwright en CI.
3. **Rapport de santé** (§2) : faibles, réutilisés, fuites (HIBP par
   k-anonymat), clés d'API et cartes qui expirent.
4. **Agent SSH dans Guiterm** (§3) : le différenciateur dev/ops.
5. **Manifeste de vault authentifié** (§0) : à concevoir ensemble avant de
   l'écrire (chaque écriture devient deux, sous le verrou optimiste ; tous
   les clients à la fois).
6. **Exploitation** (§5 : administration, sauvegardes vérifiées, SMTP,
   suppression de compte) et **mobile** (§4).

## 0. Sécurité face à un serveur malveillant

Référence : ETH Zurich, *Zero Knowledge (About) Encryption* (février 2026,
[eprint 2026/058](https://eprint.iacr.org/2026/058)) — 12 attaques contre
Bitwarden, 7 contre LastPass, 6 contre Dashlane, 2 contre 1Password, toutes
en supposant le serveur compromis. Familles : récupération de compte qui
rouvre une porte au serveur, métadonnées d'items non authentifiées,
partage dont le serveur choisit les destinataires, rétrogradation vers des
paramètres ou formats anciens.

- [x] **Plancher Argon2id côté client.** Le prelogin renvoie les paramètres
  KDF ; un serveur compromis pouvait répondre `m_cost=8, t_cost=1`,
  recevoir une clé d'auth quasi gratuite à calculer et casser le mot de
  passe maître hors ligne. Les clients refusent maintenant de dériver hors
  de `KdfParams::is_sane` (Rust : `MasterKey::derive` ; web :
  `deriveMasterKey`, `deriveExportKey`) — avant d'envoyer quoi que ce soit.
  Guiterm en profite en remontant son épinglage de `guivault-crypto`.
- [x] **Paramètres KDF épinglés (TOFU), web et extension.** Le plancher
  (19 MiB, 2 passes) laissait encore un serveur passer un compte de
  64 MiB/3 à 19 MiB/2 (~5× moins cher). Les paramètres de la dernière
  connexion réussie sont retenus par serveur + e-mail (`kdfPins.ts`,
  `localStorage`), épinglés seulement après le déverrouillage de la user
  key (preuve qu'ils sont les vrais), et un prelogin qui les fait baisser
  est refusé avant de dériver. Changement de mot de passe : vérifié puis
  ré-épinglé.
- [x] **Paramètres KDF épinglés dans Guiterm.** Même règle
  (`KdfParams::weaker_than`), retenus dans le registre des comptes
  (`accounts.json`, `KnownAccount::kdf`), vérifiés avant `prepare_login` à
  la connexion, au déverrouillage et au changement de mot de passe
  (`core/src/guivault/account.rs`, test `kdf_params_are_pinned_and_a_downgrade_is_refused`).
- [x] **Retour en arrière (rollback).** Web et extension retiennent la
  dernière révision vue de chaque vault (`vaultRevisions.ts`,
  `localStorage`) et affichent une alerte rouge quand le serveur en annonce
  une plus basse, jusqu'à « J'ai compris ». Guiterm (`sync.rs`) **suspend**
  en plus la synchro du vault — sans ça, `?since=` sautait en silence tout
  ce qui s'écrivait ensuite sous des révisions déjà « vues » — jusqu'à
  « Reprendre la synchronisation » (panneau GuiVault), où ce poste fait foi :
  versions renvoyées, items perdus recréés, suppressions rejouées.
- [ ] **Manifeste de vault authentifié.** La révision n'est pas dans l'AAD :
  un serveur qui sert d'anciens chiffrés sous des révisions qui montent
  n'est pas détecté. Piste : un item spécial par vault, chiffré sous la
  vault key, qui porte un compteur et l'empreinte (id → hash du chiffré)
  de chaque item, réécrit par chaque écrivain sous le verrou optimiste
  existant ; un client refuse un item dont le hash ne correspond pas.
- [x] **Enveloppes authentifiées.** Les enveloppes de clés de vault étaient
  des boîtes scellées anonymes : le serveur pouvait en fabriquer une pour un
  vault de son choix. Format 2 (`wrap_vault_key`) : X25519 statique entre
  expéditeur et destinataire, HKDF, AAD = vault ; écrit par le web,
  l'extension et Guiterm, le format 1 encore lu. Web et Guiterm montrent
  qui a remis la clé (réglages du vault, badge « clé non vérifiée »).
- [x] **Empreinte de l'inviteur avant d'accepter.** Le serveur joint
  l'enveloppe à l'invitation (`Invitation.wrapped_vault_key`) ; web et
  Guiterm l'ouvrent avant d'accepter et montrent l'empreinte de qui remet
  la clé. Enveloppe illisible, ou clé différente de celle déjà vérifiée
  pour l'inviteur : « Accepter » est désactivé.
- [x] **Doc :** `EXTENSION.md` disait « Lecture seule » en tête, alors que
  l'extension crée, modifie et supprime.

## 1. Défauts de Bitwarden à combler

| Reproche fréquent | Chez nous aujourd'hui | Piste |
|---|---|---|
| Remplissage peu fiable (plainte n°1 ; sites en shadow DOM cités) | `content.ts` ne parcourt pas les `shadowRoot`, ni les iframes de connexion tierces | Parcourir les shadow roots ouverts et les iframes ; corpus de pages de connexion rejoué par Playwright en CI |
| ~~Coffre auto-hébergé injoignable = plus rien (« bloqué à l'aéroport »)~~ **fait** | `lib/offline.ts` : copie chiffrée en IndexedDB (par appareil, désactivée par défaut), ouverte avec le mot de passe maître en lecture seule — web (interface gardée par `public/sw.js`) et extension (le remplissage marche) | Écrire hors ligne et resynchroniser ; manifeste PWA installable ; Guiterm |
| ~~Pas d'historique des modifications~~ **fait** | Table `item_versions` (versions chiffrées, `GUIVAULT_ITEM_HISTORY`), corbeille `GUIVAULT_TRASH_DAYS` jours, restauration par renvoi tel quel ; web : « Historique » d'un élément et page Corbeille ; les rotations (web, Guiterm) re-chiffrent l'historique | Guiterm : pas encore d'écran corbeille/historique (le web s'en charge) |
| ~~Presse-papier jamais effacé (très demandé)~~ **fait** | `lib/clipboard.ts` : effacé au bout du délai (30 s par défaut, section synchronisée `clipboard`) s'il contient encore ce qui a été copié ; extension : service worker + document hors écran ; web : à l'échéance si la page peut vérifier, sinon au clic suivant | — |
| Tri, doublons, duplication | **Tri fait** (nom en dossiers, modifiés / créés récemment à plat, retenu par appareil) | Rapport de doublons avec fusion ; « Dupliquer » via `useSeed` ; tri par dernier usage (à tracer côté client) |
| Re-demande du mot de passe maître pour un élément | — | Drapeau `reprompt` sur l'élément (affichage et copie du secret) |
| Fonctions « premium » payantes (accès d'urgence, pièces jointes, Send, TOTP) ; +100 % sur Premium en janvier 2026 | Absentes | Gratuites parce qu'auto-hébergées — voir §2 |
| Interface « datée », pas d'accompagnement | Pas de premier lancement guidé | Assistant d'import à la première connexion, puis une liste « activer la 2FA, installer l'extension, vérifier une empreinte » |

## 2. Fonctions nouvelles (zero-knowledge)

- [ ] **Accès d'urgence** : la vault key scellée vers la clé publique d'un
  proche (empreinte vérifiée) ; le serveur ne libère ce blob qu'après un
  délai d'attente sans refus du propriétaire. Le serveur ne garde qu'un blob
  illisible pour lui — l'inverse de la récupération de compte critiquée
  chez Bitwarden.
- [ ] **Partage éphémère (Send)** : chiffré + expiration + nombre de vues
  max ; la clé dans le fragment de l'URL (`#…`), jamais vu par le serveur.
  Sert aussi à partager un seul élément sans créer de vault.
- [ ] **Pièces jointes chiffrées**, découpées en morceaux, stockées à part
  (la limite actuelle de 1 Mio par item les empêche).
- [ ] **Rapport de santé** : faibles, réutilisés, anciens ; sites qui
  proposent la 2FA sans TOTP enregistré (liste 2fa.directory) ; fuites HIBP
  par k-anonymat, relayées par le serveur pour garder la CSP stricte ;
  **clés d'API et cartes qui expirent** (`expiresAt` existe déjà).
- [ ] **Déverrouillage par passkey** (extension WebAuthn PRF) et code PIN
  dans l'extension ; **2FA WebAuthn** (seul TOTP aujourd'hui).
- [ ] Alias d'e-mail dans le générateur (SimpleLogin / addy.io), comme
  Proton Pass — moins prioritaire.

## 3. Se différencier : dev/ops avec Guiterm

- [ ] **Agent SSH dans Guiterm** adossé au coffre. Celui de Bitwarden
  essaie les clés une par une, sans lien hôte → clé, et casse régulièrement
  la signature Git. Ici chaque hôte connaît sa clé : la bonne présentée,
  confirmation à chaque usage, signature des commits.
- [x] **CLI `gv`** (`crates/guivault-cli`, `docs/CLI.md`) : `login`,
  `unlock` (session dans `GUIVAULT_SESSION`, modèle de la CLI Bitwarden),
  `get` par référence `gv://vault/élément/champ`, `run -- cmd` (variables
  `gv://` remplacées, comme `op run`), `aws credential-process`,
  `git-credential`. Cache chiffré, lisible sans le serveur ; verrou pour
  que deux `gv` ne fassent pas tourner le même jeton. Reste : écrire
  (`gv set`), les codes TOTP à la volée pour un `ssh`, la complétion.
- [ ] Runbooks et snippets qui **référencent des secrets**, résolus au
  moment de l'exécution.
- [ ] **Mode voyage** : le serveur exclut certains vaults de `/sync` pour
  les sessions marquées « en voyage » (payant chez 1Password).

## 4. Interface et ergonomie

- [x] **Recherche globale** sur tous les vaults et **palette Ctrl+K**
  (`SearchPalette.tsx`) : éléments (nom, utilisateur, site, tags, chemin,
  vault) et pages ; Entrée ouvre l'élément dans son vault
  (`#/vault/<id>/item/<id>`), Ctrl+C copie le mot de passe (ou le secret),
  Ctrl+Maj+C l'utilisateur. Déchiffré en mémoire seulement, effacé avec la
  session.
- [x] **Raccourcis clavier** dans un vault : `/` filtrer, ↑↓ ou `j`/`k`,
  `c` copier le secret, `u` l'utilisateur, `e` modifier, `h` historique,
  `f` favori, Suppr, `?` l'aide (`ShortcutsHelp.tsx`) — ignorés pendant
  la saisie.
- [ ] **Mobile** : ~16 règles responsive dans tout `components/` —
  quasi inutilisable sur téléphone, et pas d'app. Une vue à un panneau + la
  PWA couvrent déjà consultation, copie et TOTP.
- [ ] **Conflits (409)** : on recharge et on lève une erreur ; proposer une
  fusion champ par champ (ma version / celle du serveur).

## 5. Exploitation (auto-hébergement)

- [ ] **Administration du serveur** : pas de rôle admin aujourd'hui ;
  comptes, invitations, désactivation, quotas.
- [ ] **Sauvegardes intégrées et vérifiées** (le « backup corrompu depuis
  des mois » est un classique de l'auto-hébergement).
- [ ] **SMTP optionnel** : invitations, alertes de nouvelle connexion
  (demande ouverte chez Bitwarden).
- [ ] **Restriction par plages d'IP** (réglage serveur).
- [ ] **Suppression de compte** (RGPD) — absente.

## Sources

- ETH Zurich : [annonce](https://ethz.ch/en/news-and-events/eth-news/news/2026/02/password-managers-less-secure-than-promised.html),
  [papier](https://eprint.iacr.org/2026/058),
  [synthèse](https://www.secretsofprivacy.com/p/zero-knowledge-password-managers-server-side-attacks),
  [réponse de 1Password](https://1password.com/blog/eth-zurich-zero-knowledge-malicious-server-review)
- Bitwarden : [demandes les plus votées](https://community.bitwarden.com/c/feature-requests/5/l/votes),
  [History for all fields](https://community.bitwarden.com/t/history-for-all-fields-like-password-history/16871),
  [avis 2026](https://checkthat.ai/brands/bitwarden/reviews),
  [tarifs 2026](https://checkthat.ai/brands/bitwarden/pricing),
  [serveur injoignable (#23353)](https://github.com/bitwarden/clients/issues/23353),
  [accès hors ligne](https://bitwarden.com/blog/configuring-bitwarden-clients-for-offline-access/)
- Agent SSH Bitwarden : [doc](https://bitwarden.com/help/ssh-agent/),
  [#14617](https://github.com/bitwarden/clients/issues/14617),
  [#13369](https://github.com/bitwarden/clients/issues/13369)
- Auto-hébergement : [XDA](https://www.xda-developers.com/self-hosted-password-manager-risks-limitations-locked-out/),
  [Vaultwarden vs Bitwarden](https://www.wundertech.net/vaultwarden-vs-bitwarden/)
- Concurrents : [Proton Pass vs Bitwarden](https://www.security.org/password-manager/proton-pass-vs-bitwarden/),
  [alias Proton Pass](https://proton.me/support/pass-email-alias),
  [1Password pour développeurs](https://1password.com/developer-security)
