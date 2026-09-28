# Feuille de route

Pistes d'amélioration issues d'un tour complet du code et de ce qui se dit
des autres gestionnaires (Bitwarden surtout, mais aussi 1Password, Proton
Pass, Vaultwarden) — septembre 2026. L'idée : combler leurs défauts connus
et jouer ce que GuiVault a qu'eux n'ont pas (Guiterm, l'angle dev/ops,
l'auto-hébergement sans fonctions « premium »).

Chaque piste respecte la règle n°1 (`CLAUDE.md`) : le serveur ne garde que
des blobs qu'il ne sait pas lire. Cocher au fur et à mesure.

## État (28 septembre 2026)

**Fait** : tout le §0 sauf le manifeste authentifié (plancher et
paramètres Argon2id épinglés, retour en arrière détecté, enveloppes
authentifiées, empreinte de l'inviteur) ; dans les §1, §3 et §4 : presse-papiers
effacé, historique et corbeille, copie hors ligne, recherche globale
(Ctrl+K), raccourcis, tri, CLI `gv`, **remplissage fiable** de l'extension
(shadow DOM, cadres, corpus rejoué en CI), **agent SSH dans Guiterm** ; dans le §2 : **accès d'urgence**,
**liens de partage** et **rapport de santé** (web). Chaque point est coché ci-dessous avec où il
vit dans le code.

**Ensuite, dans cet ordre** — du plus demandé ou du plus exposé au plus
confortable :

1. **Manifeste de vault authentifié** (§0) : à concevoir ensemble avant de
   l'écrire (chaque écriture devient deux, sous le verrou optimiste ; tous
   les clients à la fois) — proposition et questions dans
   [`MANIFESTE.md`](MANIFESTE.md).
2. **Mobile** (§4) : l'exploitation (§5) est faite — administration,
   sauvegardes vérifiées, SMTP facultatif, plages d'IP, suppression de
   compte.

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
| ~~Remplissage peu fiable (plainte n°1 ; sites en shadow DOM cités)~~ **fait** | `extension/src/dom.ts` : shadow roots ouvertes et fermées (`chrome.dom.openOrClosedShadowRoot`), imbriquées ou tardives, saisie `composed` ; `frames.ts` : chaque cadre est son propre site (identifiants de l'onglet seulement confirmés, « Remplir » du popup vers un seul cadre — un cadre tiers recevait avant le mot de passe du site) ; inscription et changement de mot de passe reconnus ; interface injectée fermée, clics `isTrusted`. Corpus `extension/e2e` (17 cas, Playwright, CI) | « Faire confiance à ce cadre » pour un fournisseur d'identité ; Firefox dans le corpus ; pages réelles anonymisées au fil des signalements |
| ~~Coffre auto-hébergé injoignable = plus rien (« bloqué à l'aéroport »)~~ **fait** | `lib/offline.ts` : copie chiffrée en IndexedDB (par appareil, désactivée par défaut), ouverte avec le mot de passe maître en lecture seule — web (interface gardée par `public/sw.js`) et extension (le remplissage marche) | Écrire hors ligne et resynchroniser ; manifeste PWA installable ; Guiterm |
| ~~Pas d'historique des modifications~~ **fait** | Table `item_versions` (versions chiffrées, `GUIVAULT_ITEM_HISTORY`), corbeille `GUIVAULT_TRASH_DAYS` jours, restauration par renvoi tel quel ; web : « Historique » d'un élément et page Corbeille ; les rotations (web, Guiterm) re-chiffrent l'historique | Guiterm : pas encore d'écran corbeille/historique (le web s'en charge) |
| ~~Presse-papier jamais effacé (très demandé)~~ **fait** | `lib/clipboard.ts` : effacé au bout du délai (30 s par défaut, section synchronisée `clipboard`) s'il contient encore ce qui a été copié ; extension : service worker + document hors écran ; web : à l'échéance si la page peut vérifier, sinon au clic suivant | — |
| Tri, doublons, duplication | **Tri fait** (nom en dossiers, modifiés / créés récemment à plat, retenu par appareil) | Rapport de doublons avec fusion ; « Dupliquer » via `useSeed` ; tri par dernier usage (à tracer côté client) |
| Re-demande du mot de passe maître pour un élément | — | Drapeau `reprompt` sur l'élément (affichage et copie du secret) |
| Fonctions « premium » payantes (accès d'urgence, pièces jointes, Send, TOTP) ; +100 % sur Premium en janvier 2026 | **Accès d'urgence, Send et TOTP faits**, gratuits parce qu'auto-hébergés | Pièces jointes chiffrées — voir §2 |
| Interface « datée », pas d'accompagnement | Pas de premier lancement guidé | Assistant d'import à la première connexion, puis une liste « activer la 2FA, installer l'extension, vérifier une empreinte » |

## 2. Fonctions nouvelles (zero-knowledge)

- [x] **Accès d'urgence** : la clé de vaults dont on est propriétaire,
  enveloppée vers un proche inscrit (empreinte vérifiée des deux côtés) sous
  un contexte propre (`wrap_emergency_key`, format 2 : le serveur ne peut
  ni l'ouvrir, ni l'installer comme appartenance) ; le serveur ne la remet
  qu'après une demande du contact suivie du délai (1 à 90 jours) sans
  refus, ou dès l'accord du donneur, qui peut refuser, reprendre la main,
  changer délai et vaults, ou retirer le contact. Lecture seule (export
  compris). Serveur : `routes/emergency.rs`, migration `0006` ; web :
  Paramètres › Accès d'urgence (`EmergencySettings.tsx`), bandeau du
  donneur, vaults remis dans la barre latérale. Une rotation par le
  propriétaire ré-enveloppe ; par un autre client, les enveloppes sont à
  renouveler et la page du propriétaire les refait. Reste : alerte par
  e-mail (§5 SMTP), Guiterm (rotation qui ré-enveloppe, écran contact),
  l'extension.
- [x] **Partage éphémère (Send)** : texte ou élément (sans son rangement),
  chiffré sous une clé tirée d'un secret qui ne voyage que dans le fragment
  (`#/send/<id>/<secret>`) et d'un mot de passe facultatif (Argon2id) ; le
  serveur ne remet le chiffré qu'à qui présente la clé d'accès, compte les
  ouvertures, efface à la dernière et à l'expiration
  (`GUIVAULT_SEND_MAX_DAYS`, 30 j ; `0` désactive). Crypto :
  `send_keys` / `sendKeys` (vecteurs d'interop) ; serveur :
  `routes/sends.rs`, migration `0005` ; web : `lib/sends.ts`, page « Liens
  de partage », « Partager par lien » sur un élément, page publique
  `SendView.tsx`. Reste : fichiers (avec les pièces jointes), `gv send`,
  l'extension.
- [ ] **Pièces jointes chiffrées**, découpées en morceaux, stockées à part
  (la limite actuelle de 1 Mio par item les empêche).
- [x] **Rapport de santé** (web, « Santé du coffre ») : faibles,
  réutilisés (identifiants, hôtes, connexions SQL, passphrases de clés),
  inchangés depuis un an ; sites qui acceptent la 2FA sans TOTP ni passkey
  enregistrés (2fa.directory) ; fuites HIBP par k-anonymat, sur demande ;
  clés d'API et cartes qui expirent dans le mois. Calcul :
  `web/src/lib/health.ts` ; relais : `routes/lookups.rs`
  (`GUIVAULT_HEALTH_LOOKUPS`, désactivable). Reste : dans l'extension et
  Guiterm ; « ignorer » un élément signalé ; doublons avec fusion (§1).
- [ ] **Déverrouillage par passkey** (extension WebAuthn PRF) et code PIN
  dans l'extension ; **2FA WebAuthn** (seul TOTP aujourd'hui).
- [ ] Alias d'e-mail dans le générateur (SimpleLogin / addy.io), comme
  Proton Pass — moins prioritaire.

## 3. Se différencier : dev/ops avec Guiterm

- [x] **Agent SSH dans Guiterm** adossé au trousseau (et donc au coffre) :
  Paramètres › Agent SSH, éteint par défaut, clés cochées une à une. Le
  client OpenSSH ≥ 8.9 annonce son serveur (`session-bind@openssh.com`,
  signature vérifiée) : l'hôte est reconnu à sa clé d'hôte et seule la clé
  qu'il utilise est présentée. Confirmation à chaque usage (ou 10 min par
  clé), qui dit ce qui est signé (connexion à quel hôte, commit Git
  `SSHSIG`) et quel programme le demande ; agent transféré : toujours.
  Signature des commits (`gpg.format ssh`). Socket Unix, tube nommé sous
  Windows. Guiterm : `core/src/ssh_agent/`, testé contre les vrais `ssh`,
  `ssh-add`, `ssh-keygen`. Reste : l'extension et le web n'en ont pas
  l'usage ; Windows ne nomme pas le programme demandeur.
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

- [x] **Administration du serveur** — rôle donné depuis le shell
  (`guivault admin grant`, `src/admin.rs`), jamais par l'API ;
  `routes/admin.rs` : état du serveur, comptes (activité, vaults, octets),
  désactivation (sessions coupées, `account_disabled` à la connexion),
  quotas (`GUIVAULT_QUOTA_MB` et par compte, vérifiés dans
  `db::check_quota`), suppression avec transfert des vaults partagés,
  inscriptions ouvertes à une adresse. Un administrateur ne touche pas un
  autre administrateur. Web : `AdminPage.tsx`.
- [x] **Sauvegardes intégrées et vérifiées** — `src/backup.rs` : un
  instantané cohérent en lignes JSON de PostgreSQL (aucun type réinterprété),
  SHA-256 par table ; vérifiée par relecture complète, et par
  **restauration dans une base d'essai** re-sauvegardée à l'identique
  (créée si absente) ; restaurable depuis un schéma plus ancien (montée
  ensuite) ; automatique (`GUIVAULT_BACKUP_*`, activée par le compose),
  `guivault backup create|verify|restore`, suivie dans l'administration
  (`backup_runs`, alerte si échouée ou trop vieille).
- [x] **SMTP optionnel** — `src/mail.rs` (`lettre`, rustls) : invitations,
  inscriptions ouvertes, alerte de connexion depuis une IP jamais vue,
  mot de passe et second facteur, compte désactivé ou supprimé, chaque
  étape de l'accès d'urgence. **Jamais bloquant** : envoi en arrière-plan
  après la transaction, SMTP injoignable ou mal réglé sans effet sur les
  actions (testé), e-mail d'essai dans l'administration. L'ouverture d'un
  accès d'urgence au bout du délai est guettée toutes les cinq minutes et
  prévient les deux parties, une fois (`emergency::notify_opened`).
- [x] **Restriction par plages d'IP** — `GUIVAULT_ALLOWED_IPS` (tout le
  serveur sauf `/api/v1/health`, couche `restrict_ips` dans
  `routes/mod.rs`) et `GUIVAULT_ADMIN_ALLOWED_IPS` (l'administration),
  sur l'adresse du client selon `GUIVAULT_TRUST_PROXY`.
- [x] **Suppression de compte** (RGPD) — `DELETE /users/me`
  (`routes/users.rs::delete_me`) : mot de passe et second facteur
  redemandés, refusée tant que le compte possède un vault partagé avec
  d'autres membres (la liste est rendue, pour transférer ou supprimer) ;
  le journal d'audit perd les IP du compte. Web : Paramètres › Compte, qui
  oublie aussi ce que l'appareil retenait (copie hors ligne, paramètres
  Argon2id, révisions).

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
