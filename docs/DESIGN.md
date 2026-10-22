# Design de l'interface

Refonte décidée le 2026-10-21. Ce document et les maquettes font foi.

**État** : l'interface web (et donc l'application, qui la reprend) est
refaite — socle (`web/src/index.css`, `lib/preferences.ts`, police Geist
embarquée par `src/fonts.ts`), barre latérale, accueil, coffre et fiche,
palette, santé, liens de partage, paramètres, connexion, formulaires,
import/export, réglages du vault, et l'extension (popup et interface
injectée), et le mobile (le web sous 768 px). Restent quelques écrans
propres à l'application (saisie automatique, réglages du poste) qui n'ont
eu que des textes raccourcis.

## Maquettes

- **Design retenu** (bureau sombre, bureau clair, mobile, extension) :
  <https://claude.ai/artifact/VNofu6GVqDvGtdGHU7JZAA>, avec quatre pages :
  « Bureau · sombre », « Bureau · clair », « Mobile » et « Extension ».
- Exploration d'origine (directions A, B, C et planche de motifs) :
  <https://claude.ai/artifact/Lfo8RhX4dCyZ1BPokxDiBY>.
- Sources des maquettes retenues : `docs/design/canvas/`. Chaque écran est un
  fichier `.dc.html`. Les jetons et les primitives sont dans
  `docs/design/canvas/theme.css`, à reprendre dans `web/src/index.css` lors
  de l'implémentation. Les fichiers `Clair*.dc.html` et `M*Clair.dc.html`
  ne font qu'importer l'écran sombre avec `theme="light"`.

Les maquettes sont privées : il faut les partager depuis leur menu Share
pour que quelqu'un d'autre puisse les ouvrir.

## Décisions

- **On se sépare de la charte de Guiterm.** Les copies de `~/gui-termius`
  listées dans `CLAUDE.md` (`index.css`, `vaultTree.ts`, `preferences.ts`…)
  n'ont plus à rester identiques une fois la refonte commencée.
- **Base : la direction A, « Graphite ».** Barre latérale en trois groupes
  (Coffres, Outils, Sécurité), avec le compte, les paramètres et
  « Verrouiller » en pied de barre. Le vault s'affiche sur trois volets ; la
  fiche a un en-tête, de gros boutons de copie, des onglets (Détails,
  Pièces jointes, Historique, Saisie auto) et une colonne « Sécurité ».
- **Repris de la direction B :** la page **Accueil** (accès rapide, codes 2FA,
  santé, coffres, invitation, activité des coffres partagés) et la page
  **Liens de partage** (garanties en puces, liste avec ouvertures et
  expiration, fenêtre « Nouveau lien »).
- **Repris de la direction C :** la **palette Ctrl K**. Préfixe `›`, champ
  « Tous les coffres », résultats groupés (hôtes SSH, identifiants,
  actions), raccourcis en pied (`Ctrl C`, `Ctrl U`, `Tab`, `>` pour les
  commandes seules).
- **Logo :** `web/src/assets/logo.png` en haut à gauche, à la place du
  cadenas. `logo-gray.png` reste réservé à l'écran de déverrouillage.
- **Deux thèmes**, sombre et clair, définis par les mêmes variables :
  `.gv` et `.gv[data-theme="light"]` dans `theme.css`. L'accent est
  `#8B8CFF` en sombre et `#5755D9` en clair, accordés au dégradé du logo.
  Les polices sont Geist et Geist Mono.
- **Mobile** : 11 écrans (déverrouiller, accueil, coffre, fiche, recherche,
  nouvel élément, codes 2FA, générateur, santé, partage par lien,
  réglages). La barre d'onglets du bas contient Accueil, Coffres, Codes,
  Santé et Réglages. Implémenté le 2026-10-22 dans le web (sous 768 px) ;
  voir « Dans le code ».

## Extension de navigateur

Approuvée et implémentée le 2026-10-21. Planches `X*.dc.html`
(popup) et `P*.dc.html` (dans les pages), styles en fin de `theme.css`
(`.popup`, `.p-*`, `.inj-*`).

- **Popup** (440 × 600, la taille actuelle) :
  - En-tête avec le logo (gris quand le coffre est verrouillé), puis trois
    onglets : Coffres, Codes, Générateur.
  - L'onglet Coffres commence par **« Sur <site> »** : les identifiants du
    site ouvert, chacun avec un bouton « Remplir » et un bouton de copie.
    Viennent ensuite la recherche et les coffres.
  - En pied : le raccourci `Ctrl Maj L` et « Nouveau ». Les copies se
    confirment par un toast « effacé dans 24 s ».
  - Les autres écrans : déverrouiller (serveur ou coffre local), fiche,
    codes 2FA (celui du site en tête, « Remplir »), générateur
    (« Remplir le champ »), nouvel identifiant prérempli depuis l'onglet,
    réglages.
  - Les réglages tiennent en lignes « titre + une ligne ». Les règles de
    champs de code personnalisés (les regex) passent sur un écran à part,
    au lieu du long texte d'aide actuel.
- **Dans les pages** (shadow root fermée, comme aujourd'hui) :
  - Le bouton GuiVault est le logo, dans le champ.
  - Le menu de remplissage montre les identifiants du site, une action
    « Nouvel identifiant pour ce site » et un pied de raccourcis.
  - Le bandeau « Enregistrer cet identifiant ? » apparaît en haut à droite,
    avec le choix du coffre et « Jamais pour ce site / Plus tard /
    Enregistrer ».
  - À l'inscription, une proposition de mot de passe s'ouvre sous le champ.
  - Le dialogue passkey choisit parmi des cartes.
- Ce qui est injecté suit le thème **du système** (`prefers-color-scheme`) :
  le script de page ne lit pas les préférences du popup.

Écarts avec les planches, voulus :

- Dans les pages, **police du système** et logo en **SVG en ligne** au lieu
  de Geist et du PNG : une ressource `web_accessible_resources` peut être
  sondée par la page (elle saurait que GuiVault est installé). Le popup,
  lui, a Geist.
- Pas de « Jamais pour ce site » dans le bandeau d'enregistrement : la
  fonction n'existe pas encore (« Plus tard » et la croix l'écartent pour
  cette fois).
- La proposition de mot de passe à l'inscription est le dialogue
  « Nouvel identifiant » existant (générateur intégré), ouvert depuis
  « Générer un mot de passe » dans le menu du champ.

Dans le code : `extension/src/Popup.tsx` reprend les briques du web
(`ItemTile`, `SettingRow`, `InfoTip`, `.segmented`, `.card`) ; les styles de
l'interface injectée sont en tête de `content.ts` (`:host`, variables
`--bg`, `--line`…, mêmes valeurs que `index.css`). Chrome pose sa propre
police sur le `body` des pages d'extension : `index.css` la remplace par
celle de `html`.

## Dans le code

- **Écrans d'entrée** : `components/AuthShell.tsx` (maquette « Connexion » :
  formulaire à gauche, schéma à droite), pour `LoginScreen` et l'accueil de
  l'application (`web/app/src/AppWelcome.tsx` : coffres récents, serveur,
  ouvrir ou créer un coffre local).
- **Gabarit de page** : `components/Page.tsx` (titre, sous-titre d'une ligne,
  actions, colonne bornée). Une ligne de réglage : `SettingRow` (`ui.tsx`).
  Une info au clic : `InfoTip` (`ui.tsx`). Un menu : `Dropdown` (`ui.tsx`).
- **Tuiles** : `ItemTile` (`ItemTree.tsx`) — l'icône choisie, sinon l'initiale
  sur une teinte tirée du nom (`lib/tiles.ts`, classe `.tile`).
- **Couleur d'un vault** : `lib/vaultColors.ts`, préférence de l'utilisateur
  (section synchronisée `vaultColors`), réglée depuis le menu « … » du vault
  ou ses réglages.
- **Éléments de tous les vaults** (accueil, compteurs de la barre, colonne
  « Sécurité ») : `lib/allItems.ts` (`useAllItems`, `healthSummary`), effacés
  avec la session ; la page d'un vault y verse ce qu'elle lit
  (`putVaultItems`), seule nouvelle d'une écriture en coffre local.
- **Préférences** : `DESIGN_VERSION` — des préférences d'avant la refonte
  (locales ou synchronisées) prennent une fois le fond, l'accent, la police
  et les lignes d'entité par défaut.
- **Fiche** : à partir de 1500 px, la colonne « Sécurité » à droite
  (`components/ItemAside.tsx` : force, réutilisation, 2FA, âge du mot de
  passe, puis dossier, tags et versions) ; en dessous, sous la fiche.
- **Coffre** : liste et fiche côte à côte à partir de 1100 px (la fenêtre de
  l'application en fait 1200), un volet à la
  fois en dessous.

- **Mobile** (sous 768 px, `NARROW` de `hooks/useMediaQuery.ts`) :
  - `App.tsx` remplace la barre latérale par `components/MobileNav.tsx` ;
    l'onglet « Coffres » rouvre le dernier vault ouvert.
  - L'onglet « Réglages » est la route `#/more` (`components/MobileMenu.tsx` :
    compte, thème, catégories des paramètres, outils, verrouiller ou se
    déconnecter). Au bureau, `#/more` mène aux paramètres.
  - Les pages sans onglet ont un retour en haut (`Page`, prop `mobileBack`).
  - L'accueil, les codes 2FA, la liste du coffre (puces, « + » flottant,
    sélecteur de vault dans le titre), la fiche (centrée) et les lignes de
    la santé ont leur mise en page mobile dans leur composant.
  - Les fenêtres (`.modal`) deviennent des feuilles qui montent du bas, et
    la palette passe en plein écran.
  - Styles dans `src/touch.css` (classes `m-*`). Le popup de l'extension
    ne l'importe pas : ses 440 px ne sont pas du mobile.
  - `PageContext` porte `search` et `lock` pour les boutons des écrans
    mobiles.
  - Mouvements (`touch.css`, fin) : les onglets entrent en fondu, les pages
    de second niveau glissent depuis la droite, les feuilles montent du bas ;
    rien si le système demande moins de mouvement.
  - Android : « Bulle » à droite de la barre d'onglets, sur toutes les pages.
- **Écrans d'entrée, la vitrine** (`AuthShell`, `.auth-hero` dans
  `index.css`) : aurores floues qui dérivent, grille estompée, cartes de
  verre qui flottent (un identifiant, un code 2FA, ce que voit le serveur).
- **Créer depuis l'accueil** : « Nouvel élément » ouvre un menu — le vault
  de destination s'il y en a plusieurs, chaque type, un dossier
  (`#/vault/<id>/new/group`), un nouveau vault (`NewVault.tsx`, aussi dans la
  barre latérale et le sélecteur de vaults mobile).

## Règles d'écriture de l'interface

- **Pas de paragraphe d'explication.** Un sous-titre d'une ligne suffit ;
  le détail va dans une info au clic (ⓘ, trois puces au plus) ou dans un
  lien « En savoir plus ». Les garanties s'affichent en puces, les
  contraintes dans le contrôle lui-même (« 100 Mo max · chiffré avant
  l'envoi »). Ce qui dépend de la plateforme s'indique par un badge
  (« Windows », « Application »).
- **Vocabulaire** : « Codes 2FA » (pas « Authentificateur »), « Vider le
  presse-papiers », « 18 éléments » (pas « élément(s) »).
- **Débordements** : tout nom, e-mail ou URL est tronqué (`.trunc`, avec un
  `min-width: 0` sur le parent flex) ou coupé (`.break`, `.clamp2`). Les
  barres d'outils passent à la ligne (`flex-wrap`). Les maquettes
  contiennent exprès des valeurs longues (« Équipe infrastructure et
  production », « AWS Console — compte de production principal ») pour
  vérifier ces règles.
- **Responsive bureau** (`theme.css`) :
  - à 1180 px, la barre latérale se resserre ;
  - à 980 px, la liste et la fiche du vault s'empilent ;
  - à 760 px, la barre latérale devient une rangée horizontale.

  Les classes `hide-xl`, `hide-lg` et `hide-md` masquent ce qui est
  secondaire.
- Une cible tactile mobile fait au moins 44 px, et les champs mobiles sont
  en 16 px (pas de zoom automatique sous iOS).
