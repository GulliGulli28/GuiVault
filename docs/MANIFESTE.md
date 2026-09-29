# Manifeste de vault authentifié

Statut : **adopté, en cours d'implémentation** (29 septembre 2026). Serveur,
format, client web, extension, `gv` et Guiterm faits et testés, vecteurs
d'interopérabilité compris. **L'activation est coupée** (voir « Déploiement ») :
aucun vault ne reçoit de manifeste tant que le Guiterm qui l'entretient
n'est pas publié.

## Le problème

L'AAD d'un item le lie à son vault, son id et son type — pas à sa révision.
C'est voulu (une rotation re-chiffre sans toucher aux révisions), mais un
serveur malveillant peut alors, sans jamais savoir déchiffrer :

1. **rejouer** l'ancien chiffré d'un item sous une révision qui monte (un
   ancien mot de passe « revient ») — les clients ne détectaient qu'une
   révision de *vault* qui recule ;
2. **retenir** un item (le faire disparaître, sans tombale) ;
3. **ressusciter** un item supprimé (resservir sa dernière version).

C'est la famille « métadonnées non authentifiées » du papier de l'ETH
(`ROADMAP.md`, §0).

## Décisions (prises le 29 septembre 2026)

1. **Qui peut écrire un manifeste valide** : n'importe quel membre, lecteurs
   compris (il a déjà la clé du vault). Pas de signature pour l'instant ; la
   porte reste ouverte (paire Ed25519 par compte, qui servirait aussi aux
   invitations et à l'accès d'urgence).
2. **En cas d'écart** : alerte rouge et **blocage des écritures** d'ici sur
   ce vault ; il reste lisible. Levée par une prise d'acte explicite.
3. **Historique et corbeille** : hors du manifeste (ils ne servent qu'à
   restaurer, et une restauration repasse par une écriture).
4. **Le serveur refuse** toute écriture sans manifeste sur un vault qui en a
   un (`409 manifest_required`).
5. **Ordre** : web et extension, puis `gv`, puis Guiterm — Guiterm à jour
   *avant* qu'un vault partagé avec lui ait un manifeste.

## La conception, telle qu'implémentée

**Contenu** (`crates/guivault-crypto/src/manifest.rs`, miroir
`web/src/lib/manifest.ts`) :

```json
{ "v": 1, "counter": 42, "items": { "<id>": "<SHA-256 du chiffré, base64url sans remplissage>" } }
```

Scellé exactement comme un item (`seal_item`, format `0x01` inchangé) sous
l'id `00000000-0000-0000-0000-000000000000` et le type `manifest` : l'AAD
diffère de celle de tout item, un chiffré d'item ne passe pas pour un
manifeste ni l'inverse, et le type `manifest` est refusé pour un item
ordinaire (`400 invalid_item_type`). Pas de liste de supprimés : un item
servi que le manifeste ne connaît pas suffit à trahir une résurrection.

**Serveur** (migration `0010`) : `vaults.manifest` (le blob) et
`vaults.manifest_revision` (verrou optimiste, égal au `counter` scellé).
Rangé à part des items : un client qui ne le connaît pas ne voit rien de
nouveau dans la liste.

- `GET /vaults/{id}/items` : items, révision **et** manifeste lus dans un
  même instantané (`REPEATABLE READ`), pour que la vérification ne voie pas
  d'écart qui n'existe pas. Idem pour les vaults d'un accès d'urgence.
- `PUT …/items/{id}` et `DELETE …/items/{id}` (corps JSON facultatif)
  portent `manifest: { ciphertext, base_revision }`, appliqué dans la même
  transaction. Base dépassée : `409 manifest_conflict` avec le manifeste
  courant ; absent sur un vault qui en a un : `409 manifest_required`.
- `GET /vaults/{id}/manifest` : le manifeste seul (écrire sans tout relire).
- `PUT /vaults/{id}/manifest` `{ ciphertext, base_revision, vault_revision }`
  : le créer (base 0) ou le réécrire d'après ce que sert le serveur (prise
  d'acte). Refusé si le vault a bougé depuis la lecture (`vault_revision`).
  Écrivain et plus ; audit `vault.manifest_create` / `vault.manifest_rewrite`.
- Rotation de clé : `manifest` re-scellé sous la nouvelle clé, obligatoire
  si le vault en a un.
- Taille : jusqu'à 8 fois `GUIVAULT_MAX_ITEM_BYTES` (`413
  manifest_too_large`) ; ≈ 85 octets par item.

**Vérification** (`verify_manifest` / `verifyManifest`), sur **l'état
complet** des items vivants et le plus grand compteur vu d'ici :

| Écart | Ce que ça veut dire |
|---|---|
| `Missing` | le serveur ne sert plus de manifeste alors qu'on en a vu un |
| `Unreadable` | il ne s'ouvre pas avec la clé du vault |
| `Mismatch` | son compteur n'est pas la révision annoncée |
| `Rollback` | plus ancien que le dernier vu d'ici |
| `Unexpected` | un item servi qu'il ne connaît pas (ajouté hors des clients, ressuscité) |
| `Altered` | un item servi dont le chiffré n'est pas celui annoncé (rejoué) |
| `Withheld` | un item annoncé que le serveur ne sert pas (retenu) |

**Client web** (`web/src/lib/session.ts`) : `loadItems` vérifie et rend
`problems` ; le compteur vu est retenu par serveur et par vault
(`manifestCounters.ts`, `localStorage`). Chaque écriture (`putPayload`,
`restoreVersion`, `deleteItem`, `moveItem`, rotation) passe par
`withManifest` : le manifeste courant plus le changement, compteur + 1 ; sur
`manifest_conflict`, reprise depuis le manifeste courant joint (il vient
d'un membre, le serveur ne sait pas le fabriquer ; on vérifie seulement
qu'il s'ouvre et ne recule pas). Un vault en écart refuse les écritures
(`IntegrityError`) jusqu'à `acceptIntegrity` : un écrivain réécrit le
manifeste d'après les items servis, un lecteur accepte le compteur.

**Interface** (`components/IntegrityBanner.tsx`) : sur la page du vault, un
bandeau rouge liste les écarts (avec le nom de l'élément, y compris un
élément retenu déjà lu depuis l'ouverture de la page) ; les éléments en
cause portent une étiquette « écart » dans la liste et un avertissement sur
leur fiche ; les boutons d'écriture disparaissent. « Prendre acte… »
demande confirmation (ce que sert le serveur devient la référence) puis
appelle `acceptIntegrity`. L'extension garde les écarts dans son cache
d'items (`ItemsCache.problems`) : le popup montre le même bandeau, compact,
et `vaultops.ts` refuse d'écrire — le service worker, qui enregistre les
identifiants proposés par les pages, ne lit jamais le manifeste lui-même.

**`gv`** (lecture seule) : le manifeste est gardé avec les items de chaque
vault dans `cache.json` (même instantané) ; chaque ouverture le vérifie
(`vault::open_with`), dit les écarts sur la sortie d'erreur sans bloquer, et
retient les compteurs dans `manifests.json` (par serveur, gardé après
`gv logout`). `gv sync --accept` : prise d'acte des compteurs servis. Test
`gv_checks_vault_manifests` (`tests/cli.rs`) : manifeste qui recule, prise
d'acte, version rejouée et item retenu, avec le binaire.

**Tests** : `manifest.rs` et `manifest.test.ts` (mêmes cas), les deux
vecteurs d'interopérabilité (section `manifest` : un manifeste scellé d'un
côté s'ouvre et se vérifie de l'autre, empreintes identiques), et
`vault_manifest_is_written_with_every_change_and_catches_a_lying_server`
(`tests/api.rs`) — un serveur qui ment simulé en modifiant la base : version
rejouée, item ressuscité, item retenu, ancien manifeste, manifeste disparu ;
rotation ; écritures refusées sans manifeste ou sur une base dépassée.

## Ce qui reste, dans l'ordre

1. ~~**Web** : l'interface d'alerte~~ — fait (« Interface » ci-dessus).
2. ~~**Tests web et vecteurs d'interopérabilité**~~ — fait.
3. ~~**`gv`**~~ — fait (« `gv` » ci-dessus).
4. ~~**Guiterm**~~ — fait (`core/src/guivault/manifest.rs` dans Guiterm) :
   l'état complet de chaque vault reconstitué de ses deltas (empreintes,
   secrets compris ; `verify_manifest_digests` ici), vérifié au pull ; un
   écart suspend le vault comme un retour en arrière de révision, la
   reprise réécrit le manifeste d'après le serveur puis renvoie les
   versions du poste ; toute écriture (push, suppression, retrait après
   déplacement, accès AWS) porte le manifeste et reprend sur
   `manifest_conflict` / `manifest_required` ; la rotation le re-scelle.
   Test `vault_manifest_is_maintained_and_checked` (`guivault_integration`).
5. **Activer** : `AUTO_ENABLE_MANIFEST = true` dans `session.ts` (le web
   donne alors un manifeste à chaque vault où il peut écrire, à la lecture
   et à la rotation) — **seulement une fois 3 et 4 publiés** : une version
   de Guiterm qui les contient installée par ceux qui partagent des vaults.
6. Docs : `SECURITY.md` (ligne « rejoue » et « Limites connues »),
   `ROADMAP.md` §0 à cocher.

## Déploiement

Tant que `AUTO_ENABLE_MANIFEST` est faux, ce serveur se déploie sans
risque : aucun vault n'a de manifeste, tout se comporte comme avant, et les
anciens clients ignorent le champ `manifest` des réponses. **Ne pas
l'activer**, ni créer de manifeste à la main, avant que la version de
Guiterm qui l'entretient soit publiée et installée : dès qu'un vault en a
un, le serveur refuse les écritures d'un Guiterm plus ancien sur ce vault
(il continue à le lire). `gv` ne fait que lire.
