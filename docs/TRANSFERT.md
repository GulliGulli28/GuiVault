# Copier entre un coffre local et un serveur

Statut : **fait** (21 octobre 2026). Dans l'application seulement
(Paramètres › Compte) : un coffre local se copie vers un serveur, un compte
dans un coffre local. Code : `web/src/lib/transfer.ts` (la logique),
`components/TransferDialog.tsx` (l'assistant), `POST /vaults/{id}/import`
côté serveur (`routes/items.rs`) et son miroir `LocalVault::import_items`
(`crates/guivault-local`, opération `importItems`).

## Ce qui rend la copie simple

Un coffre local garde exactement ce que garde le serveur (`APP.md`), et rien
de ce qui est chiffré ne dépend de l'endroit où il est rangé :

- l'AAD d'un item est `vault_id ‖ item_id ‖ type` — les ids sont gardés,
  donc les chiffrés passent **tels quels** (items, versions, corbeille,
  noms de vaults, manifeste) ;
- les clés des pièces jointes voyagent dans leur item, les morceaux aussi
  tels quels ;
- l'enveloppe d'une clé de vault (format 2) n'est liée qu'au vault, pas à un
  identifiant d'utilisateur : la même paire de clés l'ouvre partout.

**Règle n°1** : le serveur (ou l'hôte du coffre) ne reçoit que du chiffré
qu'il aurait reçu de toute façon. La seule crypto du transfert — envelopper
chaque clé de vault pour le compte d'arrivée — se fait dans le client.

## Les quatre cas

| De → vers | Compte d'arrivée | Ce qui est fait |
|---|---|---|
| coffre → **nouveau compte** | celui du coffre | inscription avec le matériel du coffre (Argon2id, sel, user key scellée, paire de clés, vault personnel au même id) ; la clé d'auth vient du mot de passe maître redemandé — c'est aussi la preuve qu'on le connaît. Rien n'est re-chiffré ; réglages synchronisés compris |
| coffre → **compte existant** | un autre | connexion à part (second facteur compris) ; chaque clé de vault est enveloppée pour la paire du compte ; le vault personnel du coffre devient un vault ordinaire, « Personnel (‹coffre›) » |
| compte → **nouveau coffre** | celui du compte | le coffre est créé avec le compte de la session (même mot de passe maître) et son vault personnel ; réglages compris |
| compte → **coffre existant** | celui du coffre | ouvert avec **son** mot de passe ; le vault personnel du compte y devient « Personnel (‹e-mail›) » |

Toujours une **copie** : la source n'est jamais modifiée. Les vaults partagés
avec nous (compte → coffre) sont décochés par défaut : la copie est à nous
seul, sans les autres membres. La synchronisation continue entre les deux
reste à faire (`ROADMAP.md`, « Synchroniser deux coffres locaux »).

## Ce qui est copié

| Copié | Pas copié |
|---|---|
| items, **historique avec ses dates**, **corbeille** (date de suppression comprise), pièces jointes des items vivants, manifeste, réglages synchronisés (compte ou coffre neuf) | sessions, liens de partage, accès d'urgence, membres et invitations, second facteur et passkeys, journal d'audit, pièces jointes d'items à la corbeille (le serveur n'en accepte que pour un item vivant — le rapport les compte) |

## `POST /vaults/{id}/import`

Rejouer des `PUT` daterait l'historique du jour du transfert, relancerait le
délai de la corbeille, et laisserait un vault à moitié rempli si la copie
était coupée. La route d'import (`docs/API.md`) reçoit des lots d'items avec
leurs versions et leurs dates :

- **propriétaire seulement**, et **seulement des ids que le vault n'a jamais
  eus** (tombale comprise, `409 item_exists`) : elle ne peut ni écraser un
  item ni réécrire son histoire ;
- une transaction par lot (au plus 1000 items ; le client découpe aussi à
  ~4 Mio) ; les révisions sont attribuées par le serveur, versions d'abord ;
- au plus `GUIVAULT_ITEM_HISTORY` versions par item, comme `keep_version` ;
  sans historique, pas de corbeille non plus ;
- le quota du propriétaire vaut pour les items vivants, comme un `PUT` ;
- le manifeste de la source arrive avec le dernier lot (mêmes chiffrés,
  donc toujours valide) et **ferme** l'import (`409 import_closed`) : un
  vault qui a un manifeste ne reçoit plus d'écriture qui ne le tienne pas.

Les dates sont fournies par le client : ce sont des métadonnées de son propre
vault, qu'il pourrait de toute façon inventer en écrivant au bon moment.

## Reprise

Les ids étant gardés, une copie coupée se relance telle quelle : un vault
déjà présent à l'arrivée est complété (le rapport le dit), seuls les items
absents partent, une pièce jointe incomplète est refaite. Un vault dont l'id
est pris par quelqu'un d'autre (`409` à la création) est signalé sans
arrêter les autres. Après un « nouveau compte » coupé, relancer en
« compte existant » avec le même mot de passe.

## Tests

- `tests/api.rs`, `vault_import_keeps_history_trash_and_dates` : la route
  (dates, plafond d'historique, corbeille, refus de réécrire, propriétaire
  seulement, lots mal formés, manifeste qui ferme l'import, audit).
- `crates/guivault-local/tests/local.rs`, même scénario sur le coffre local.
- `web/src/lib/transfer.test.ts` : le plan, les lots, la copie entre deux
  extrémités en mémoire qui suivent les règles du serveur — vraie crypto,
  tout s'ouvre avec le compte d'arrivée —, la reprise après une coupure, les
  coffres neuf et existant.
- `web/app/e2e/run.mjs`, « copier » : dans la vraie app contre un vrai
  serveur (`GUIVAULT_E2E_SERVER`, posé par le job `app` du CI), coffre →
  nouveau compte, connexion à ce compte avec le même mot de passe, puis
  compte → nouveau coffre, comparé au coffre d'origine sur le disque.
