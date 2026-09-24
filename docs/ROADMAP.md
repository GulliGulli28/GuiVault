# Feuille de route

Pistes d'amélioration issues d'un tour complet du code et de ce qui se dit
des autres gestionnaires (Bitwarden surtout, mais aussi 1Password, Proton
Pass, Vaultwarden) — septembre 2026. L'idée : combler leurs défauts connus
et jouer ce que GuiVault a qu'eux n'ont pas (Guiterm, l'angle dev/ops,
l'auto-hébergement sans fonctions « premium »).

Chaque piste respecte la règle n°1 (`CLAUDE.md`) : le serveur ne garde que
des blobs qu'il ne sait pas lire. Cocher au fur et à mesure.

Ordre conseillé : §0 → presse-papier + corbeille/historique (§1) →
recherche globale + raccourcis + tri (§4) → hors ligne (§1) → CLI (§3) →
accès d'urgence et partage éphémère (§2).

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
- [ ] **Empreinte de l'inviteur avant d'accepter.** Aujourd'hui l'invité
  voit qui lui a remis la clé une fois le vault rejoint. Le serveur
  pourrait renvoyer l'enveloppe avec l'invitation pour qu'il la vérifie
  avant d'accepter.
- [x] **Doc :** `EXTENSION.md` disait « Lecture seule » en tête, alors que
  l'extension crée, modifie et supprime.

## 1. Défauts de Bitwarden à combler

| Reproche fréquent | Chez nous aujourd'hui | Piste |
|---|---|---|
| Remplissage peu fiable (plainte n°1 ; sites en shadow DOM cités) | `content.ts` ne parcourt pas les `shadowRoot`, ni les iframes de connexion tierces | Parcourir les shadow roots ouverts et les iframes ; corpus de pages de connexion rejoué par Playwright en CI |
| Coffre auto-hébergé injoignable = plus rien (« bloqué à l'aéroport ») | Web 100 % en ligne ; extension en `storage.session` seulement | Cache **chiffré** (blobs + `protected_user_key` en IndexedDB), déverrouillage hors ligne en lecture seule ; PWA installable ; idem extension |
| Pas d'historique des modifications (« History for all fields ») | La suppression vide le chiffré aussitôt (`routes/items.rs`) ; seul le mot de passe a un historique | Table `item_versions` (N derniers chiffrés) + **corbeille** 30 jours, restauration. Protège aussi d'un membre éditeur maladroit ou malveillant |
| Presse-papier jamais effacé (très demandé) | `copyText` (`components/ui.tsx`) ne nettoie rien | Effacement après N s, réglage dans une section synchronisée |
| Tri, doublons, duplication | Rien de tout ça | Tri par modification / création / dernier usage ; rapport de doublons avec fusion ; « Dupliquer » via `useSeed` |
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
- [ ] **CLI `guivault`** (Rust, réutilise les crates) :
  - `guivault run -- cmd` avec des références `gv://vault/élément/champ`
    (comme `op run` de 1Password) ;
  - `credential_process` AWS depuis les éléments `aws` (plus d'identifiants
    AWS en clair sur disque) ;
  - `git credential helper`.
- [ ] Runbooks et snippets qui **référencent des secrets**, résolus au
  moment de l'exécution.
- [ ] **Mode voyage** : le serveur exclut certains vaults de `/sync` pour
  les sessions marquées « en voyage » (payant chez 1Password).

## 4. Interface et ergonomie

- [ ] **Recherche globale** sur tous les vaults et **palette Ctrl+K**
  (aujourd'hui la recherche se limite au vault ouvert).
- [ ] **Raccourcis clavier** : `/` chercher, `j`/`k` naviguer, `c`/`p`
  copier utilisateur / mot de passe, `e` modifier.
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
