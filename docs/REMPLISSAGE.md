# Remplissage automatique (Android)

GuiVault propose ses identifiants dans les **autres applications** et dans
le navigateur : sous le champ, ou dans la barre du clavier (Android 11+). Un
toucher remplit l'identifiant **et** le mot de passe ; coffre verrouillé,
une empreinte d'abord. Plus d'allers-retours entre GuiVault et l'application
où l'on se connecte.

## L'activer

1. GuiVault › Réglages › Remplissage › « Remplir les autres applications »
   (ou Paramètres › Sécurité) : Android propose de choisir GuiVault comme
   service de remplissage. Le même interrupteur l'enlève
   (`disableAutofillServices`, l'index s'efface).
2. **Chrome** : Chrome › Paramètres › Services de saisie automatique ›
   « Saisie automatique avec un autre service », puis redémarrer Chrome.
   Sans ce choix, Chrome garde son propre gestionnaire et ne montre rien
   de GuiVault — Android ne passe plus par l'accessibilité pour lui
   (`suppress-autofill-via-accessibility`). Option standard des Chrome
   récents ; sur Chrome 133 (l'émulateur), il faut d'abord le drapeau
   `chrome://flags/#enable-autofill-virtual-view-structure`. Firefox,
   Brave, Samsung Internet… parlent au système de remplissage.
3. Ouvrir un coffre dans GuiVault une fois : son index part au service.

## Comment ça marche

```
Interface (web/)                         Kotlin (gen/android/…)
────────────────                         ──────────────────────
coffre ouvert ─ AutofillFeeder ─────────▶ AutofillPlugin.update
  buildAutofillIndex (lib/autofill.ts)     └▶ AutofillIndex : en mémoire
                                               + fichier chiffré (autofill.bin)
verrouillage ─────────────────────────────▶ clear (mémoire vidée, fichier gardé)
déconnexion, coffre fermé ────────────────▶ forget (tout effacé)
mot de passe maître ──────────────────────▶ password (le délai repart)

Une autre application, un champ ──▶ GuiVaultAutofillService.onFillRequest
  AutofillForm.parse : champs identifiant / mot de passe, qui demande
  index ouvert   → les identifiants qui correspondent + « Chercher dans GuiVault »
  fichier prêt   → « Déverrouiller GuiVault » → AutofillActivity : empreinte,
                   un seul résultat : rempli ; sinon la liste
  sinon          → « Ouvrir GuiVault » (mot de passe requis, rien d'activé)
```

- **L'index** : les identifiants (type `login`) de tous les vaults lisibles
  de la session ouverte — nom, vault, identifiant, mot de passe, adresses
  avec leur règle (`never` exclue). Un seul coffre ou compte à la fois :
  le dernier ouvert dans l'application.
- **Sur le disque**, `autofill.bin` dans le dossier privé de l'app : l'index
  chiffré en AES-256-GCM sous une clé au hasard, elle-même chiffrée en
  RSA-OAEP par la clé `guivault.autofill` du Keystore. Chiffrer n'utilise
  que la clé publique (sortie du Keystore) : l'application déverrouillée
  rafraîchit l'index sans empreinte. Déchiffrer exige la clé privée, liée à
  une authentification **biométrique forte, à chaque usage**, et détruite si
  les empreintes changent (l'index est alors oublié). Après une empreinte,
  l'index reste ouvert **2 minutes** (un second champ, une seconde page).
- **Le mot de passe maître reste exigé** après un redémarrage du téléphone
  et au bout de 14 jours sans lui, comme la biométrie : la suggestion dit
  alors « Mot de passe requis » et ouvre GuiVault.
- **Sans biométrie forte** (aucune empreinte) : pas de fichier ; GuiVault ne
  remplit que tant qu'un coffre est ouvert dans l'application.
- **La règle n°1 tient** : rien ne part au serveur, tout se passe sur le
  téléphone.

## Qui reçoit quoi

- **Un site** (navigateur connu, `AutofillForm.BROWSERS`) : les
  identifiants dont une adresse a le même domaine enregistrable (`domain`,
  la règle par défaut), ou le même hôte (`host`, `exact`, `startsWith`,
  `regex` — le chemin n'est pas vu). Le domaine qu'annonce une page n'est
  cru **que d'un navigateur** : une application pourrait se dire
  `banque.fr` dans sa propre structure.
- **Une application** : les identifiants qui la nomment
  (`androidapp://<paquet>`, comme Bitwarden) ou qu'on lui a associés. Rien
  d'autre n'est rempli d'office. Dans la liste, « Suggéré » marque aussi les
  identifiants que le nom du paquet évoque (`com.github.android` → un site
  `github.…`), et **« Retenir pour cette application »** lie le choix au
  paquet **et à l'empreinte SHA-256 de son certificat de signature** : une
  autre application du même nom, signée autrement, n'en profite pas.
- Les champs : indices d'autofill, attributs HTML (`type`, `autocomplete`),
  type de saisie (`textPassword`…), puis les mots du champ (`password`,
  `mot de passe`, `email`, `identifiant`…) ; sans indice d'identifiant, le
  champ de texte qui précède le mot de passe.

## Code

- `GuiVaultAutofillService.kt` (le service), `AutofillForm.kt` (analyse,
  jeux de valeurs, présentations), `AutofillIndex.kt` (index, Keystore,
  correspondances, associations), `AutofillActivity.kt` (la feuille :
  empreinte, recherche, choix), `AutofillPlugin.kt` (ce que l'interface
  appelle) ; `res/xml/autofill_service.xml`, `res/layout/autofill_item.xml`,
  `Theme.GuiVault.Fill`.
- `app-tauri/src/autofill.rs` (inscription), `web/app/src/autofillBridge.ts`,
  `web/src/lib/autofill.ts` (+ test), `components/AutofillSetting.tsx`
  (`AutofillFeeder`, le réglage).
- Vérifié sur l'émulateur (Android 16, Chrome 133 avec le drapeau) :
  suggestion dans la barre du clavier, remplissage d'un toucher, coffre
  verrouillé → empreinte → index rouvert, feuille de recherche.

## Ce qui reste

- [ ] « Enregistrer dans GuiVault ? » après une connexion (`SaveInfo`,
  `onSaveRequest`) : il faudra écrire dans le coffre, donc passer par
  l'interface (ou ouvrir l'application sur un brouillon).
- [ ] Copier le code 2FA après avoir rempli (comme Bitwarden).
- [ ] Passkeys et mots de passe par le **Credential Manager** d'Android 14+
  (`CredentialProviderService`) : la feuille unifiée des applications qui
  l'utilisent.
- [ ] Plusieurs coffres dans l'index (aujourd'hui : le dernier ouvert).
- [ ] Associer depuis la fiche d'un identifiant (« Applications Android »),
  et écrire l'association dans l'item (`androidapp://`) pour qu'elle suive
  sur les autres appareils.
- [ ] Un vrai téléphone : Gboard et d'autres claviers, Chrome à jour,
  applications bancaires (certaines refusent le remplissage).
