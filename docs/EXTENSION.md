# Extension de navigateur

`web/extension/` — une extension MV3 (Chrome, Edge, Chromium ; Firefox ≥ 115
via `browser_specific_settings`) qui réutilise tel quel le code de
l'interface web (`web/src/lib/*` : crypto, API, session, TOTP, générateur,
correspondance d'URI). Lecture seule : pour ajouter ou modifier, « Ouvrir le
coffre » mène à l'interface web du serveur.

## Construire et charger

```bash
cd web && npm run build:ext      # → web/dist-extension/
```

Chrome / Edge : `chrome://extensions` → mode développeur → « Charger
l'extension non empaquetée » → `web/dist-extension`. Firefox :
`about:debugging` → « Charger un module temporaire » → `manifest.json`.

Au premier clic : l'adresse du serveur GuiVault, l'e-mail, le mot de passe
maître et le délai de verrouillage.

## Ce qu'elle fait

- **Vaults** : « Identifiants sur cette page » quand une URI correspond à
  l'onglet actif (`uris[].match`, sémantique de Bitwarden — `domain` par
  défaut), puis chaque vault en section repliable, **tous types confondus**
  (identifiants, notes, cartes, identités, hôtes, dossiers, connexions,
  clés, snippets, icônes) avec des filtres par type. Sur un identifiant :
  « Remplir », copier l'utilisateur, copier le mot de passe ; en ouvrant un
  item : sa fiche (celle de l'interface web), **Modifier**, **Supprimer**.
  « Nouveau » propose tous les types, avec les formulaires de l'interface
  web, dans le vault de son choix ; un identifiant sans site reçoit l'URI de
  la page courante.
- **Enregistrer ce qu'on saisit** : à la soumission d'un formulaire de
  connexion, si le couple n'est pas dans le coffre, la page suivante montre
  une bannière « Enregistrer l'identifiant pour <site> ? » (avec le vault) ;
  si un identifiant du site a ce nom mais un autre mot de passe : « Mettre à
  jour ? » (l'ancien passe dans l'historique). La saisie attend deux
  minutes dans la mémoire de session du worker, jamais dans la page.
- **Dans la page** : un bouton GuiVault sur le champ utilisateur (ou le mot
  de passe, faute de mieux) de tout formulaire de connexion — y compris les
  connexions en deux étapes (champ utilisateur seul). Un compte pour le
  site → il remplit ; plusieurs → un menu ; aucun → **« Nouvel
  identifiant »** dans la page, nom et site préremplis, utilisateur repris
  du champ, mot de passe tapé ou généré (réglages du générateur du popup),
  vault au choix — enregistré puis rempli. Coffre verrouillé → il le dit.
  **Ctrl+Maj+L** remplit sans ouvrir le popup. Désactivable (« Proposer le
  remplissage dans les pages »).
- **Badge** : le nombre d'identifiants pour l'onglet, seulement quand la
  page a un formulaire de connexion sous les yeux.
- **Codes** : l'authentificateur — tous les codes TOTP du coffre, en
  direct, avec recherche, et le retrait d'un code (confirmé : sans lui, un
  site qui l'exige encore devient inaccessible). Même vue dans l'interface web (« Authentificateur »),
  où un secret TOTP s'ajoute aussi en déposant ou collant l'image du QR code.
- **Icône grise** quand il faut se reconnecter (verrouillé, session
  expirée ou révoquée) ; le popup dit pourquoi.
- **Générateur** : le même que l'interface web.
- **Passkeys** : sur un site qui propose une passkey, GuiVault propose de
  l'enregistrer dans le coffre (dans un identifiant existant du site, ou un
  nouveau) ; à la connexion, il propose celle(s) qu'il a. « Utiliser le
  navigateur » rend la main à l'authentificateur natif (Windows Hello,
  trousseau…). Les passkeys sont synchronisées comme le reste et visibles
  dans l'interface web.
- **Verrouiller** : efface la session ; le prochain clic redemande le mot
  de passe maître (serveur et e-mail restent mémorisés).

## Comment c'est fait

| Morceau | Rôle |
|---|---|
| `src/Popup.tsx` | tout l'écran : connexion (+ TOTP), liste, remplissage, générateur |
| `src/vaultops.ts` | écrire dans le coffre depuis l'extension (créer, modifier, supprimer, déplacer un identifiant) en tenant le cache d'items à jour |
| `src/store.ts` | la session dans `chrome.storage.session` (jetons, clés du compte, clés et noms des vaults, items déchiffrés) ; réglages dans `chrome.storage.local` |
| `src/background.ts` | un service worker qui ne fait qu'écouter l'alarme de verrouillage |
| `src/content.ts` | le script de page : remplit sur ordre (popup, raccourci) et, chargé sur toutes les pages `http(s)`, repère les champs de mot de passe pour y poser le bouton GuiVault ; l'interface injectée vit dans un shadow DOM |
| `src/webauthn-shim.ts` | injecté dans le **monde de la page** avant ses scripts (`world: MAIN`) : remplace `navigator.credentials.create/get`, traduit la demande en JSON pour le script isolé, rend un `PublicKeyCredential` (même prototype, `toJSON()`), ou rappelle l'implémentation native |
| `src/passkeys.ts` | l'authentificateur, côté service worker : ES256/P-256 via WebCrypto, attestation `none` (CBOR maison, `cbor.ts`), assertion signée en DER ; enregistre la passkey dans un identifiant du coffre (`putPayload`) |
| `src/messages.ts` | les messages page ↔ service worker : la page reçoit des *noms* d'identifiants, et le mot de passe d'un seul, à sa demande, après que le worker a revérifié l'URL de l'onglet expéditeur |

Le service worker MV3 meurt au bout de 30 s d'inactivité : il ne peut rien
« garder ». D'où `chrome.storage.session` — mémoire du navigateur, jamais
sur disque, effacée à sa fermeture, réservée aux contextes de l'extension.
Chaque ouverture du popup repousse l'alarme de verrouillage
(`Verrouiller après`) ; à l'échéance, tout est effacé.

Le popup fait sa cryptographie lui-même (c'est une page) et parle
directement au serveur : l'API a un CORS ouvert (`routes/mod.rs`) — elle
n'a ni cookie ni session ambiante, tout passe par le jeton porteur, donc une
origine étrangère ne peut rien en faire sans lui. Pas de permission d'hôte
à demander, n'importe quel serveur GuiVault convient.

À chaque ouverture, le popup relit `/sync` et ne re-télécharge que les vaults
dont la révision a bougé ; les items déchiffrés sont gardés dans la session.

### Passkeys, en détail

Une extension ne peut pas être un fournisseur de passkeys du système ;
comme Bitwarden, GuiVault remplace donc l'API WebAuthn dans la page. Le
shim ne voit que les paramètres de la demande ; les clés privées (PKCS#8,
dans `Login.passkeys[].keyValue`) ne quittent jamais le service worker, qui
vérifie que le `rpId` demandé appartient à l'origine de l'onglet (hôte ou
suffixe enregistrable) avant de signer. Compteur à zéro (« non géré »),
drapeaux UP·UV·BE·BS, AAGUID nul — ce que les sites acceptent d'une passkey
synchronisée. Seul ES256 est proposé ; un site qui n'accepte que RS256 (rare)
garde le navigateur. La médiation conditionnelle (« autofill » des
passkeys) n'est pas gérée : le navigateur la fait.

## Permissions

`storage`, `alarms`, `activeTab`, `scripting`, `tabs` (l'URL de l'onglet
actif, pour le badge et le raccourci), et un script sur `http://*/*`,
`https://*/*` pour proposer le remplissage dans les champs de mot de passe —
le même périmètre que Bitwarden, pour la même raison. Le script ne lit
rien de la page : il cherche des `<input type=password>`, demande au
service worker s'il y a des identifiants pour l'URL (des noms, pas de mot
de passe), et ne reçoit le mot de passe d'un compte que quand on le choisit.
Coffre verrouillé ou sans rien pour le site : il n'ajoute rien à la page.

## Modèle de menace

Comme l'interface web (`docs/SECURITY.md`) avec une différence en faveur
de l'extension : son code est installé une fois, pas livré par le serveur à
chaque chargement. Reste que le mot de passe maître est saisi dans le
navigateur, et que les clés vivent dans sa mémoire tant que la session
n'est pas verrouillée — un navigateur compromis a tout.

Le remplissage n'écrit que dans l'onglet visé, après une correspondance
d'URI vérifiée par le service worker sur l'URL que *le navigateur* connaît
de l'onglet (pas celle que la page prétend) : un identifiant `domain
example.com` ne sera jamais proposé sur `example.com.attacker.net`
(domaine enregistrable différent). Le bouton dans la page ne remplit qu'au
clic ; un site ne peut pas déclencher le remplissage lui-même.

## Ce qui n'est pas là (encore)

- Détection plus fine des formulaires (inscription vs connexion, iframes
  de connexion tierces). Le champ utilisateur est reconnu par ses attributs,
  son libellé (`for`, englobant, `aria-labelledby`) et le texte qui le
  précède, contre une liste de mots (`USERNAME_RE` dans `content.ts`) ;
  un champ qu'elle rate est un mot à ajouter là.
- Le partage (membres, invitations, rotation), l'import/export et les
  réglages du compte : l'interface web.
- Passkeys : pas de compteur de signatures, pas de médiation
  conditionnelle, pas de suppression depuis l'extension (l'interface web le
  fait).
- Firefox n'a pas été testé en vrai (Chromium seulement, via Playwright).

## Tester

Il n'y a pas de test automatisé de l'extension dans le CI : Chromium doit
être lancé avec `--load-extension`, avec une copie du manifeste qui ajoute
`tabs` et une permission d'hôte (le popup ouvert comme une page n'a pas
`activeTab`). Le scénario joué à la main lors du développement : connexion,
identifiant de la page, remplissage utilisateur + mot de passe, réouverture
sans mot de passe, bouton dans la page → menu → remplissage, badge,
remplissage du TOTP, recherche, copie, verrouillage (bouton et badge
disparus) ; puis, sur une page WebAuthn de test, création d'une passkey,
authentification **vérifiée par le site** (signature ECDSA contrôlée avec
la clé publique de l'attestation), passkey visible dans l'interface web,
et retour au natif sans candidat.
