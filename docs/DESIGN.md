# Design de l'interface

Refonte décidée le 2026-10-21. **Pas encore implémentée** : `web/` garde pour
l'instant l'ancienne charte. Ce document et les maquettes font foi pour la
refonte.

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
  Santé et Réglages. Le mobile n'est pas encore implémenté.

## Extension de navigateur

Approuvée le 2026-10-21, pas encore implémentée. Planches `X*.dc.html`
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
- Ce qui est injecté suit le thème choisi. Les mots de passe affichés gardent
  Geist Mono : la police devra être livrée avec l'extension
  (`web_accessible_resources`), car une page tierce ne charge pas Google
  Fonts.

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
