# Pièces jointes chiffrées

Statut : **fait** côté serveur, crypto (Rust et web, vecteurs d'interop),
interface web, extension (lecture) et `gv` — 29 septembre 2026. Ce qui reste est en fin de page.

## Ce que ça donne

Un secret (identifiant, note, carte, identité, clé d'API, accès AWS) peut
porter des fichiers : un scan de contrat, une clé de licence, un fichier
`.kdbx` à migrer. Sous la fiche de l'élément, « Pièces jointes » : joindre
un fichier, le télécharger, le retirer. Jusqu'à `GUIVAULT_MAX_ATTACHMENT_MB`
(100 par défaut, `0` désactive), comptés dans le quota du propriétaire du
vault. Gratuit, comme le reste — c'est une fonction payante chez Bitwarden.

## Décisions

1. **Une clé par fichier**, tirée au hasard par le client, gardée dans le
   JSON de l'item (`attachments: [{ id, name, size, mime?, key }]`). Donc
   sous la clé du vault, et couverte par le manifeste avec l'item.
   Renouveler la clé d'un vault re-chiffre les items, **jamais les
   fichiers** ; déplacer un item vers un autre vault non plus (route
   `…/move`, la clé voyage dans l'item). Un ancien membre qui aurait gardé la
   clé d'un fichier n'a plus accès au serveur pour en lire les morceaux —
   même modèle que Bitwarden.
2. **En morceaux de 1 Mio**, chacun scellé comme le reste (format `0x01`)
   sous l'AAD `guivault/v1/attachment\0<id>\0<index>\0<dernier>` : ni
   réordonnés, ni tronqués, ni empruntés à un autre fichier. Pas de limite
   d'item à contourner (1 Mio), envoi repris morceau par morceau, et le
   serveur ne tient jamais plus d'un morceau en mémoire.
3. **Dans PostgreSQL** (`attachments`, `attachment_chunks`, migration
   `0011`), pas sur le disque : les sauvegardes vérifiées par restauration
   (`backup.rs`) les couvrent sans rien ajouter, et la suppression d'un vault
   ou d'un compte les emporte (clés étrangères). Au prix d'une base plus
   grosse : c'est ce que dit la limite par fichier et le quota.
4. **Le cycle de vie suit l'item**, que le serveur ne lit pas mais connaît
   par son id : la pièce jointe reste tant que l'item peut être restauré
   (vivant, ou dans la corbeille), part quand il la quitte (purge, corbeille
   vidée ou expirée) ; un envoi resté incomplet un jour, ou rattaché à un
   item qui n'existe pas, est effacé à la tournée horaire.
5. **Hors du formulaire.** Joindre ou retirer un fichier est une écriture
   de l'item à elle seule, depuis sa fiche : pas de fichier envoyé pour un
   formulaire abandonné. L'envoi précède l'écriture de l'item (effacé si
   elle échoue) ; le retrait la suit. Sur un conflit, le changement est
   rejoué sur la version du serveur (il ne touche qu'un champ).

## Ce que voit le serveur

La taille chiffrée (la taille du fichier à 41 octets par Mio près), le
nombre de morceaux, la date, et l'item de rattachement. Ni le nom, ni le
type, ni le contenu. Voir `SECURITY.md`.

## Où c'est

- Crypto : `crates/guivault-crypto/src/attachment.rs`, port web dans
  `web/src/lib/crypto.ts` (« Pièces jointes ») ; vecteurs dans les deux
  sens (`examples/vectors.rs`, `tests/web_interop.rs`, `crypto.test.ts`).
- Format de l'item : `FileAttachment` (`guivault-items`, `web/src/lib/types.ts`).
- Serveur : `routes/attachments.rs` (routes et `prune`), `db::check_quota`,
  `history.rs` (purge et corbeille vidée), `emergency.rs` (lecture pour un
  contact d'urgence), statistiques de l'administration ; `docs/API.md`.
- Web : `lib/attachments.ts` (envoi, téléchargement, joindre/retirer),
  `components/AttachmentsPanel.tsx`, `moveItem` (les fichiers suivent),
  exports (sans les pièces jointes, dit dans la page Outils).
- Extension : la fiche d'un secret dans le popup les liste et les
  télécharge (`AttachmentsPanel` en lecture) ; les joindre ou les retirer
  se fait dans l'interface web — dans Chrome, ouvrir un sélecteur de
  fichier depuis le popup le ferme.
- `gv` : `gv attachment list|get` (`guivault-cli/src/lib.rs`,
  « Pièces jointes » ; `docs/CLI.md`), test `gv_downloads_attachments`.
- Tests : `attachments_are_chunked_bounded_moved_and_cleaned`
  (`tests/api.rs`), `attachment.rs` (unitaires), et un envoi de 2,5 Mio
  vérifié dans Chromium (contenu jamais en clair en base, téléchargement
  identique) ; puis depuis l'extension réelle (fiche d'une note et d'un
  identifiant, téléchargements identiques).

## Reste

- **Liens de partage** avec un fichier (le §2 de la feuille de route).
- **Copie hors ligne** : les fichiers n'y sont pas (seulement leur
  description) ; les télécharger hors ligne échoue avec un message.
- **Guiterm** ne les affiche pas (il ignore les secrets de l'interface web,
  sauf les accès AWS, dont il garde les pièces jointes en les mettant à
  jour). Au prochain épinglage, `aws.rs` construit un `SecretBase`
  littéral : y ajouter `attachments: None`.
- **Historique** : restaurer une version d'avant un retrait fait réapparaître
  un fichier déjà effacé (« illisible » au téléchargement) ; en restaurer
  une d'avant un ajout laisse le fichier sur le serveur jusqu'à ce que
  l'item quitte la corbeille.
