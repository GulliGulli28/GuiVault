# Feuille de route

Pistes d'amélioration issues d'un tour complet du code et de ce qui se dit
des autres gestionnaires (Bitwarden surtout, mais aussi 1Password, Proton
Pass, Vaultwarden) — septembre 2026. L'idée : combler leurs défauts connus
et jouer ce que GuiVault a qu'eux n'ont pas (Guiterm, l'angle dev/ops,
l'auto-hébergement sans fonctions « premium »).

Chaque piste respecte la règle n°1 (`CLAUDE.md`) : le serveur ne garde que
des blobs qu'il ne sait pas lire. Cocher au fur et à mesure.

## État (26 octobre 2026)

**Fait** : tout le §0 (plancher et paramètres Argon2id épinglés, retour en
arrière détecté, enveloppes authentifiées, empreinte de l'inviteur,
**manifeste de vault**, actif depuis le 26 octobre) ; dans les §1, §3 et §4 : presse-papiers
effacé, historique et corbeille, copie hors ligne, recherche globale
(Ctrl+K), raccourcis, tri, **fusion des conflits**, CLI `gv`, **remplissage fiable** de l'extension
(shadow DOM, cadres, corpus rejoué en CI), **agent SSH dans Guiterm** ; dans le §2 : **accès d'urgence**,
**liens de partage**, **rapport de santé** (web), **pièces jointes** et
**connexion par passkey** ; dans le §6 : l'**application Windows** (0.1 puis
0.2, mises à jour signées) et l'**application Android** (APK signé par le
CI à chaque release, bulle flottante). L'interface entière est **refaite**
(`DESIGN.md`, octobre 2026 : web, extension, mobile). Chaque point est
coché ci-dessous avec où il vit dans le code.

**Ce qui reste, par ordre de priorité** (chaque ligne renvoie au détail).
En parallèle, la **confiance et la distribution** (§7 : audit, image signée,
stores, politique de sécurité, survivre au projet) puis l'**offre** (§8) :
c'est ce qui sépare un projet solide d'un outil qu'on recommande.

1. **Android, la suite du remplissage** (essayé sur un vrai téléphone le
   26 octobre ; « Enregistrer dans GuiVault ? » fait le 27) : passkeys par
   le Credential Manager, copier le code 2FA après remplissage (§6,
   [`REMPLISSAGE.md`](REMPLISSAGE.md)).
2. **Windows** (§6) : signature de code (SmartScreen), Windows Hello.
3. **Le reste des cases vides**, au choix : passkey dans l'extension (§2), écrans propres à
   l'application qui n'ont eu que des textes raccourcis dans la refonte
   (`DESIGN.md`, « État »), `gv` et Guiterm sur un coffre local
   (`APP.md`).

## 0. Sécurité face à un serveur malveillant

Référence : ETH Zurich, *Zero Knowledge (About) Encryption* (février 2026,
[eprint 2026/058](https://eprint.iacr.org/2026/058)) — 12 attaques contre
Bitwarden, 7 contre LastPass, 6 contre Dashlane, 6 contre 1Password (version
révisée du papier ; 2 dans la première), toutes
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
- [x] **Manifeste de vault authentifié** — **actif** depuis le 26 octobre
  2026 (Guiterm 4.2.0 ou plus pour écrire dans un vault qui en a un),
  détail dans [`MANIFESTE.md`](MANIFESTE.md) :
  format et vérification (`guivault-crypto/src/manifest.rs`), serveur
  (migration `0010`, écritures refusées sans manifeste, verrou optimiste,
  lecture cohérente, rotation), client web et extension (vérification,
  entretien à chaque écriture, bandeau d'alerte et prise d'acte,
  `IntegrityBanner.tsx`), vecteurs d'interop, `gv` (avertit sans bloquer,
  `gv sync --accept`), Guiterm (vérifie au pull, suspend le vault en écart,
  entretient à chaque écriture) ; puis l'activation (`AUTO_ENABLE_MANIFEST`) :
  le web en donne un à chaque vault où il peut écrire.
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
| Tri, doublons, duplication | **Fait** : tri (nom en dossiers, modifiés / créés récemment à plat, retenu par appareil) ; **doublons** dans la santé (même site et même utilisateur, même numéro de carte, vault par vault) et **fusion** sans perte (`lib/duplicates.ts`, `MergeDuplicates` : mots de passe écartés dans l'historique, adresses, champs, notes, passkeys et pièces jointes réunis, les autres à la corbeille) ; **« Dupliquer »** une fiche (sans pièces jointes, passkeys ni historique) | Tri par dernier usage (à tracer côté client) |
| ~~Re-demande du mot de passe maître pour un élément~~ **fait** | `SecretBase.reprompt` (« Redemander le mot de passe maître ») : afficher, copier, remplir, modifier, partager, taper ; vérifié sans le serveur, cinq minutes de grâce par élément (`lib/reprompt.ts`, `Reprompt.tsx`) ; le menu de l'extension et le remplissage d'Android n'en reçoivent rien ; importé et exporté avec Bitwarden | — |
| Fonctions « premium » payantes (accès d'urgence, pièces jointes, Send, TOTP) ; +100 % sur Premium en janvier 2026 | **Accès d'urgence, Send, TOTP et pièces jointes faits**, gratuits parce qu'auto-hébergés | — |
| ~~Interface « datée », pas d'accompagnement~~ **fait** | Interface refaite (`DESIGN.md`) ; **« Bien démarrer »** en tête de l'accueil (`GettingStarted.tsx`) : importer, double authentification, biométrie, exporter le coffre (Android), installer l'extension, vérifier les empreintes — cochées d'elles-mêmes quand l'interface les voit faites, à la main sinon, masquables | Un vrai assistant pas à pas à la toute première connexion |

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
  `SendView.tsx`. **Fichiers** aussi (jeton de téléchargement d'une heure
  par ouverture, voir `PIECES-JOINTES.md`). Reste : `gv send`,
  l'extension.
- [x] **Pièces jointes chiffrées** ([`PIECES-JOINTES.md`](PIECES-JOINTES.md)) :
  une clé par fichier, gardée dans l'item (une rotation de clé de vault ne
  re-chiffre pas les fichiers) ; morceaux de 1 Mio liés à leur place
  (ni réordonnés, ni tronqués) ; rangées dans PostgreSQL, donc dans les
  sauvegardes vérifiées ; `GUIVAULT_MAX_ATTACHMENT_MB` (100), dans le quota ;
  effacées quand l'item quitte la corbeille, suivent un item déplacé.
  Serveur : `routes/attachments.rs`, migration `0011` ; web :
  `lib/attachments.ts`, « Pièces jointes » sous la fiche d'un secret.
  Extension : listées et téléchargées depuis le popup ; `gv attachment
  list|get` ; liens de partage avec fichier (et « Partager par lien » sur
  une pièce jointe).
- [x] **Rapport de santé** (web, « Santé du coffre ») : faibles,
  réutilisés (identifiants, hôtes, connexions SQL, passphrases de clés),
  inchangés depuis un an ; sites qui acceptent la 2FA sans TOTP ni passkey
  enregistrés (2fa.directory) ; fuites HIBP par k-anonymat, sur demande ;
  clés d'API et cartes qui expirent dans le mois. Calcul :
  `web/src/lib/health.ts` ; relais : `routes/lookups.rs`
  (`GUIVAULT_HEALTH_LOOKUPS`, désactivable). Reste : dans l'extension et
  Guiterm. **Ignorer** un problème signalé pour un élément (onglet
  « Ignorés », « Reprendre ») : retenu par compte dans les réglages
  synchronisés, chiffrés (`lib/healthIgnore.ts`) ; le score ne change pas,
  il dit l'état réel du coffre.
- [x] **Connexion par passkey** ([`PASSKEYS.md`](PASSKEYS.md)) : sans mot de
  passe maître ni code TOTP, dans l'interface web. La PRF de WebAuthn tire
  une clé qui enveloppe la user key ; le serveur garde l'enveloppe sans
  pouvoir l'ouvrir et vérifie les signatures (`src/webauthn.rs`, Rust pur,
  utilisateur vérifié exigé, compteur contre les clones). Ajouter redemande
  le mot de passe maître. Activée par `GUIVAULT_PUBLIC_URL`.
- [x] **2FA WebAuthn** : une clé de sécurité à la place du code TOTP, après
  le mot de passe ; à côté du TOTP (son recours), jamais seule
  ([`PASSKEYS.md`](PASSKEYS.md), « Clé de sécurité »). Reste : l'imposer en
  option (refuser le code).
- [ ] Passkey et **code PIN dans l'extension** (ses pages ont leur propre
  origine).
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
- [x] **Mode voyage** (payant chez 1Password) : en voyage, le compte ne
  garde sur ses appareils que les vaults marqués « sûrs en voyage » ; le
  serveur ne sert plus les autres (404, absents de `/sync`), le couper
  redemande le mot de passe maître ([`ARCHITECTURE.md`](ARCHITECTURE.md),
  « Mode voyage »). Reste : vérifier que Guiterm efface un vault qui
  disparaît de `/sync` (le web, l'extension, la copie hors ligne et `gv`
  le font).

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
- [x] **Mobile** — relevé à 390 px, écran par écran : aucune page ne
  déborde (panneau unique, tiroir). Corrigé : `src/touch.css` (pointeur
  tactile : champs en 16 px, sans quoi Safari iOS zoome au focus ; boutons
  de 36–40 px, lignes de 44 px ; pas d'indications clavier), tiroir refermé
  à chaque changement de page et à Échap, inerte quand il est hors écran
  (ni focus ni lecteur d'écran), en-têtes qui laissent la place au bouton
  Menu, deux notifications au plus sur petit écran, menu « Nouveau » à
  Échap. **PWA installable** (`manifest.webmanifest`, icônes 192/512 et
  masquable ; Chrome la juge installable). **Refait** en octobre 2026
  (`DESIGN.md`, « Mobile ») : barre d'onglets, feuilles qui montent du bas,
  gestes entre onglets, mouvements ; c'est aussi l'interface de
  l'application Android (§6).
- [x] **Conflits (409)** : fusion champ par champ au lieu d'un
  rechargement qui perdait la saisie. Le refus joint la version du serveur
  (`RevisionConflict.current`) ; `lib/merge.ts` fusionne à trois versions
  (celle ouverte, la nôtre, celle du serveur) : un champ changé d'un seul
  côté est repris, changé des deux côtés il se choisit (`MergeDialog`,
  secrets masqués) ; le résultat part de la version du serveur (champs
  inconnus gardés), l'historique des mots de passe s'unit et le mot de
  passe écarté y entre. Supprimé entre-temps : recréer avec sa version.
  Page du vault et popup de l'extension (`useMerge`). Les petites
  écritures (épingler, glisser vers un dossier, retirer un code 2FA,
  joindre ou retirer un fichier) se **rejouent** sur la version du serveur
  au lieu de recharger (`session.changeItem` ; épingler pose la valeur vue,
  jamais un « inverser » qui déferait une épingle posée ailleurs ; test dans
  `localHost.test.ts`).

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

## 6. Application (Windows, puis Android)

Le client installé ([`APP.md`](APP.md)) : un coffre local ou un serveur.
Pistes tirées de ce que font KeePass 2, KeePassXC, 1Password et Bitwarden et
que GuiVault ne fait pas encore (octobre 2026). Effort : S petit, M moyen,
L gros.

**Fait**

- [x] **Coffre local** (`crates/guivault-local`) : ce que garderait le
  serveur, dans un dossier, sans clé ; transport côté interface
  (`lib/localHost.ts`).
- [x] **Application Windows** (`app-tauri/`, `web/app/`) : accueil serveur ou
  coffre local, interface sans ce qui demande un serveur, E2E dans la vraie
  fenêtre (WebKitGTK et WebView2, CI), installeurs MSI et NSIS
  (`app-release.yml`).
- [x] **Saisie automatique à la KeePass** (Windows) : raccourci global,
  bouton de la fiche, séquences et fenêtres associées par identifiant
  (`lib/autotype.ts`, `app-tauri/src/autotype.rs`).

**Le poste** — faits le 20 octobre 2026 (`docs/APP.md`, « Le poste » ; E2E dans WebKitGTK et WebView2)

- [x] **Presse-papiers hors de l'historique Windows** (S, comme KeePass) :
  ce que l'app copie ne va ni dans Win+V ni dans le presse-papiers cloud.
- [x] **Verrouiller avec la session** (S–M, KeePass/KeePassXC) : au
  verrouillage de la session Windows, à la mise en veille, à la réduction
  (réglable) ; l'inactivité au choix dans GuiVault (le plus sûr) ou sur tout
  l'ordinateur (confort avec la saisie automatique) — et le délai vaut
  enfin pour un coffre local.
- [x] **Sauvegardes automatiques du coffre local** (S, KeePass) : N copies
  datées de `coffre.json`, prises avant les écritures.
- [x] **Zone de notification** (S–M, KeePass/KeePassXC) : icône, réduire au
  lieu de quitter, démarrer avec Windows, une seule instance — l'app tourne
  en fond pour le raccourci global.

**Ensuite** (ordre proposé)

- [x] **Import KDBX** (M–L) : KeePass 2 / KeePassXC directement (KDBX 3.1
  et 4, fichier clé), pièces jointes, historique, TOTP et saisie
  automatique compris — `lib/kdbx.ts`, détail dans
  [`ITEMS.md`](ITEMS.md) ; testé contre de vraies bases KeePass, et dans la
  vraie fenêtre (E2E).
- [x] **Extension ↔ application** (L) : l'extension ouvre un coffre local
  par l'hôte natif de l'app — qui ne lui sert que du chiffré, elle
  déchiffre avec le mot de passe maître (plus simple et plus sûr que
  l'association de KeePassXC-Browser, qui remet des secrets en clair).
  [`EXTENSION.md`](EXTENSION.md), « Coffre local » ; E2E de bout en bout
  dans Chromium (`e2e/native.spec.ts`).
- [ ] **Déverrouillage rapide Windows Hello** (M, KeePassXC, Bitwarden) : la
  user key enveloppée sous une clé liée au TPM ; conception crypto à part.
- [x] **Agent SSH** (M, KeePassXC, KeeAgent) : les clés cochées du coffre
  ouvert, sur le tube d'OpenSSH pour Windows, chaque signature confirmée
  (ce qui est signé, par quel programme) — repris de l'agent de Guiterm
  ([`APP.md`](APP.md), « Agent SSH »).
- [x] **Copier un coffre local vers un serveur**, et l'inverse (M) : compte
  neuf ou existant, coffre neuf ou existant ; historique, corbeille et
  pièces jointes compris, reprise après coupure (`POST /vaults/{id}/import`)
  — [`TRANSFERT.md`](TRANSFERT.md) ; E2E contre un vrai serveur.
- [x] **Synchroniser deux coffres locaux** (L, « Synchroniser » de KeePass) :
  une copie sur Nextcloud, Syncthing ou une clé USB et le coffre ouvert
  redeviennent un ; conflit = le plus récent gagne, l'autre reste dans
  l'historique ([`TRANSFERT.md`](TRANSFERT.md), « Synchroniser deux
  copies »). Reste : la lancer d'elle-même quand le fichier de la copie
  change.
- [ ] **Fichier clé** (M, KeePass) : un coffre local qui s'ouvre avec le mot
  de passe **et** un fichier — nouvelle enveloppe, nouveau `format`.
- [ ] **Saisie automatique, suite** (M) : obfuscation à deux canaux,
  `{PICKCHARS}` (« caractères 3, 5 et 8 » des banques), Linux (X11).
- [x] **Mises à jour automatiques signées** (M, comme Guiterm) :
  Paramètres › Application › Mise à jour, release `app-updater`
  ([`APP.md`](APP.md), « Mises à jour ») ; éprouvées sur un vrai poste
  (0.1.0 → 0.1.1, 21 octobre 2026).
- [x] **Mises à jour pour une installation MSI** : les deux installeurs
  signés, `latest.json` avec `windows-x86_64-msi` / `-nsis` (et
  `windows-x86_64` = NSIS pour les versions d'avant), l'updater prend celle
  de son installeur ; vérifiées par `verify-app-release.mjs` ; le type
  d'installation affiché dans Paramètres › Application ([`APP.md`](APP.md),
  « MSI et NSIS »).
- [ ] **Signature de code Windows** — SmartScreen avertit tant que les
  installeurs ne sont pas signés (options dans le `RELEASING.md` de Guiterm).
- [ ] **Plusieurs coffres ouverts à la fois** (L) : local et compte côte à
  côte, transfert entre eux (les « emplacements » de Guiterm).
- [ ] **Références entre champs** `{REF:…}` (M, KeePass).
- [x] **Feuille de secours imprimable** (Emergency Kit de 1Password) :
  Paramètres › Compte › « Feuille de secours » — coffre ou serveur et
  compte, empreinte, date, une case pour le mot de passe maître **à écrire
  à la main** (jamais imprimé), et le rappel de `gv recover`
  (`RecoveryKit.tsx`, styles d'impression dans `index.css`).
- [ ] **Modèles d'éléments**, types personnalisés (M).
- [ ] **Mode portable** (S–M, KeePass) : sur une clé USB.
- [x] **Fuites sans serveur** : un coffre local interroge Have I Been Pwned
  lui-même, sur demande, par k-anonymat avec remplissage ; HIBP voit alors
  l'adresse IP de l'appareil, et la page le dit (`health.directRange`). La
  liste des sites 2FA reste indisponible sans serveur.

**Android** ([`ANDROID.md`](ANDROID.md))

- [x] **L'application Android** (même projet Tauri, `dev.guivault.client`) :
  coffre local ou serveur, l'interface mobile du web, APK signé, attesté et
  joint à chaque release par le CI (depuis la 0.2.1).
- [x] **Bulle flottante** à la Messenger : réduire, déplacer, rouvrir ;
  automatique en quittant l'application (réglable), aucun secret affiché.
- [x] **Essai sur un vrai téléphone** (S) : l'application essayée par
  l'auteur sur son téléphone le 26 octobre 2026 — à élargir à d'autres
  modèles.
- [x] **Exporter / importer un coffre local** : une archive `.zip` du
  dossier du coffre par le sélecteur de documents d'Android (sans les
  sauvegardes), importée sous un nom libre et un nouvel identifiant si
  l'appareil a déjà ce coffre ; relue par `gv recover`. Sauvegarde Google :
  pas de coffre dans le cloud, transfert vers un nouveau téléphone oui —
  [`ANDROID.md`](ANDROID.md), « Exporter et importer un coffre ».
- [x] **Déverrouillage biométrique** (M) : la user key sous une clé du
  Keystore, empreinte ou visage de classe 3 à chaque usage ; mot de passe
  après un redémarrage et tous les 14 jours — [`ANDROID.md`](ANDROID.md),
  « Déverrouillage biométrique ». Windows Hello pourra suivre le même
  schéma (`BiometricBridge`).
- [x] **Service de remplissage Android** (L, KeePassDX, Bitwarden) : les
  autres applications et Chrome, index chiffré sous une clé du Keystore
  (empreinte), associations liées au certificat de l'application —
  [`REMPLISSAGE.md`](REMPLISSAGE.md). Reste : enregistrer après une
  connexion, code 2FA, Credential Manager.
- [x] `FLAG_SECURE` (réglable) et presse-papiers marqué sensible, effacé à
  l'échéance — [`ANDROID.md`](ANDROID.md), « Ce qui reste ».
- [x] **Signaler une nouvelle version** : les releases `app-v*` publiées,
  lues sur l'API de GitHub ; « Télécharger » ouvre leur page.
- [ ] Panneau sur la bulle (recherche, codes 2FA) — à peser : il montrerait
  des secrets par-dessus une autre application.

## 7. Confiance et distribution

Ce qui sépare GuiVault d'un outil qu'on recommande à d'autres (octobre
2026) : la conception est là, la preuve extérieure et la distribution non.
Le README le dit en tête ; chaque case cochée y retire une ligne.

- [ ] **Audit externe** de `guivault-crypto`, `crypto.ts` et des routes
  d'authentification et de partage (Cure53, Trail of Bits, Radically Open
  Security ; ou un financement OTF / NLnet pour un projet libre), rapport
  publié tel quel avec les corrections.
- [x] **Activer le manifeste** (§0) : la dernière limite structurelle face à
  un serveur malveillant — le 26 octobre 2026.
- [x] **Image Docker publiée** sur ghcr.io : amd64 et arm64 (runners
  natifs, fusion par empreinte), signée par cosign sans clé, attestation de
  provenance — `.github/workflows/server-image.yml`, après chaque CI vert
  sur `main` et sur un tag `server-v*` ; vérification dans le README.
  Images de base épinglées par empreinte, avancées par Dependabot
  (`.github/dependabot.yml`, mensuel, avec les actions des workflows).
  Reste : publier un SBOM.
- [x] **Audit des dépendances** : `.github/workflows/security.yml` (chaque
  push, chaque PR et chaque lundi) — `cargo audit` sur le workspace et sur
  `app-tauri`, `npm audit` du web (production bloquant à `high`). Les avis
  écartés le sont dans `.cargo/audit.toml`, chacun avec sa raison
  (`rsa` et `crypto-bigint` : le serveur n'y vérifie que des signatures
  WebAuthn, avec des clés publiques).
- [ ] **Extension dans les stores** (Chrome Web Store, Firefox Add-ons,
  Edge) — l'identifiant change : l'ajouter aux origines de l'hôte natif
  (`EXTENSION.md`).
- [ ] **Signature de code Windows** (§6) ; Android essayé sur un premier
  vrai téléphone, à élargir (§6).
- [x] **Builds reproductibles** du web embarqué : le build est
  reproductible tel quel (vérifié entre un poste en Node 20 et l'image en
  Node 22), `/health` annonce `build_commit` (argument de build de l'image),
  `scripts/verify-web.sh <url> [commit]` reconstruit et compare chaque
  fichier servi ; job `verify` de `server-image.yml` sur chaque image.
  Reste : le faire depuis l'application ou l'extension (vérifier la page
  avant d'y taper le mot de passe), ce qui demanderait la liste des
  empreintes signée hors du serveur.
- [x] **Interface en anglais** (i18n) : web, application, mobile et
  extension (popup, service worker, script de page) — Paramètres ›
  Apparence › Langue (Système, Français, English), par appareil ; erreurs
  du serveur traduites par code. `lib/i18n.ts`, catalogue
  `src/i18n/en.json` (≈ 2 200 textes), complétude vérifiée par
  `i18n.test.ts`. E-mails du serveur dans la langue du compte
  (`users.language`, posée par l'interface ; les deux langues si elle est
  inconnue). README (`README.en.md`) et politique de sécurité
  (`SECURITY.md`) en anglais aussi. Reste : la documentation technique
  (`docs/`), en français seulement.
- [x] **Politique de sécurité** : [`SECURITY.md`](../SECURITY.md) à la
  racine (canal, délais visés, versions maintenues, périmètre, bonne foi) ;
  `/.well-known/security.txt` (RFC 9116) servi par chaque serveur, contact
  de l'opérateur (`GUIVAULT_SECURITY_CONTACT`) puis du projet
  (`routes/well_known.rs`, test `security_txt_names_the_operator_then_the_project`).
- [ ] Une **prime aux bogues**, une fois l'audit passé.
- [ ] **Livre blanc** : la conception cryptographique en un document
  autonome, pour les relecteurs. Les formats y sont déjà
  ([`FORMATS.md`](FORMATS.md)) et les menaces par famille
  ([`SECURITY.md`](SECURITY.md)) ; manque ce que devient ici **chacune**
  des 31 attaques d'ETH Zurich, à écrire papier complet en main (les
  résumés publics ne donnent que les familles).
- [ ] **Version 1.0 du serveur et des formats**, avec une promesse écrite de
  compatibilité et un journal des changements.
- [ ] **Survivre au projet** — l'objection n°1 face à un seul développeur
  (« et si vous arrêtez ? ») :
  - [x] **spécification des formats** : [`FORMATS.md`](FORMATS.md) —
    dérivations, octets de version, AAD, enveloppes, manifeste, pièces
    jointes, coffre local, sauvegarde du serveur, exports, et un engagement
    de compatibilité ;
  - [x] **récupération sans serveur** : `gv recover` ouvre un coffre local,
    une sauvegarde du serveur (`--email`) ou un export avec le seul mot de
    passe, et écrit un export en clair par vault et les pièces jointes
    déchiffrées, sans réseau ([`CLI.md`](CLI.md), « Récupération » ;
    `recover.rs` écrit à partir de `FORMATS.md`, sans `guivault-local` ;
    test `gv_recovers_without_a_server` : sauvegarde d'un vrai serveur relue
    une fois le serveur éteint et sa base effacée). L'export chiffré se lit
    aussi en Rust (`export_key`, vecteur d'interop écrit par le web) ;
  - [x] [`CONTRIBUTING.md`](../CONTRIBUTING.md) : ce qui ne se négocie pas
    (règle n°1, formats, interop, pas de crypto maison, pas de payant),
    construire et tester, ce qu'on attend d'une pull request, publier ;
  - [ ] un **second mainteneur** qui sache publier une version (accès au
    dépôt, à la clé de signature des mises à jour, au keystore Android).
- [x] **Promesse écrite « aucune fonction payante »** dans le README
  (« Pourquoi GuiVault », point 4) et dans `CONTRIBUTING.md`.

## 8. L'offre

Le créneau (README, « GuiVault face aux autres ») : le coffre auto-hébergé
des gens qui administrent des machines, local ou serveur, conçu contre un
serveur compromis. Premier public : les structures françaises attentives à
la souveraineté — collectivités, PME, infogérants, santé, enseignement —
pour qui une interface en français et un hébergement chez soi sont des
atouts, pas des manques. Rien ici ne retire une fonction au logiciel libre.

- [ ] **Une page de présentation** (domaine à soi) : le pitch, la
  comparaison honnête, la sécurité en une page, les téléchargements avec
  leurs sommes et attestations.
- [ ] **Instance hébergée en France** pour qui ne veut pas héberger : même
  binaire, l'opérateur ne voit que ce que voit tout serveur GuiVault.
  Prérequis : l'audit (§7) et le manifeste activé.
- [ ] **Installation et support** pour PME et infogérants : déploiement,
  reprise des coffres existants (Bitwarden, KeePass), formation.
- [ ] **Contrat de maintenance** avec un délai d'engagement sur les failles
  (correctif publié, versions maintenues — la politique de sécurité du §7).
- [x] **Import 1Password et Proton Pass** par leur CSV : formats reconnus,
  TOTP, favoris, étiquettes, vault Proton en dossier, adresse quand
  l'utilisateur manque ([`ITEMS.md`](ITEMS.md)). Reste : le `.1pux` de
  1Password et l'export JSON de Proton Pass (cartes, identités, champs
  personnalisés), à écrire avec de vrais exports en main.

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
