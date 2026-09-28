# Manifeste de vault authentifié — proposition à trancher

Statut : **proposition**, rien n'est écrit. La feuille de route (§0, point 1
de « Ensuite ») demande de la concevoir ensemble avant de l'écrire : chaque
écriture d'item devient deux, et tous les clients (web, extension, Guiterm,
`gv`) doivent suivre en même temps.

## Le problème

L'AAD d'un item le lie à son vault, son id et son type — pas à sa révision.
C'est voulu (une rotation re-chiffre sans toucher aux révisions), mais un
serveur malveillant peut alors, sans jamais savoir déchiffrer :

1. **rejouer** l'ancien chiffré d'un item sous une révision qui monte (un
   ancien mot de passe « revient ») — les clients ne détectent qu'une
   révision de *vault* qui recule ;
2. **supprimer par omission** : ne plus servir un item, sans tombale ;
3. **ressusciter** un item supprimé (resservir sa dernière version).

C'est la famille « métadonnées non authentifiées » du papier de l'ETH
(`ROADMAP.md`, §0).

## La proposition

Un item réservé par vault (type `manifest`, id fixe dérivé du vault),
chiffré sous la clé du vault comme les autres :

```json
{ "v": 1, "counter": 42, "items": { "<id>": "<SHA-256 du chiffré, base64>" }, "deleted": ["<id>", …] }
```

- **Écrire un item** = écrire aussi le manifeste (compteur + 1, empreinte de
  l'item mise à jour), **dans la même requête** : `PUT …/items/{id}` accepte
  `manifest: { ciphertext, base_revision }`, appliqués dans la même
  transaction — un écrivain concurrent reçoit `409` et recommence, comme
  aujourd'hui.
- **Lire** : chaque client déchiffre le manifeste, vérifie que son compteur
  ne recule pas (retenu par appareil, comme les révisions et les paramètres
  Argon2id), que chaque item servi a l'empreinte annoncée, qu'aucun item du
  manifeste ne manque et qu'aucun supprimé ne revient.
- **Rotation** : le manifeste est re-chiffré avec le reste.
- **Taille** : ~50 octets par item ; 10 000 items ≈ 500 Ko, sous la limite
  d'un item (1 Mio). Au-delà, le découper.

## Ce qu'il faut trancher

1. **Qui peut écrire un manifeste valide ?** Chiffré sous la clé du vault,
   il peut être fabriqué par **n'importe quel membre**, lecteurs compris —
   un lecteur de mèche avec le serveur pourrait donc maquiller. Deux voies :
   - *simple* : l'accepter (un lecteur a déjà tous les secrets du vault) ;
   - *solide* : faire **signer** le manifeste par son écrivain, ce qui
     demande une paire de signature (Ed25519) par compte — nouvelle clé dans
     le compte, publiée comme la clé X25519, empreinte à vérifier pareil.
     Gros chantier, mais il servirait aussi ailleurs (invitations, accès
     d'urgence).
2. **Sévérité** en cas d'écart : bloquer le vault (comme Guiterm le fait
   pour un retour en arrière) ou l'alerter en rouge et continuer ?
3. **Historique et corbeille** : dans le manifeste (plus gros, plus de
   garanties) ou hors de lui (ils ne servent qu'à restaurer, et une
   restauration repasse par une écriture) ?
4. **Déploiement** : un vault passe « avec manifeste » quand un client
   capable l'y met ; ensuite, un client qui ne sait pas l'entretenir ne doit
   plus y écrire. Serveur qui refuse (`409 manifest_required`) les écritures
   sans manifeste sur un tel vault, ou confiance aux clients ?
5. **Ordre** : web et extension (même code), puis `gv`, puis Guiterm — le
   serveur refusant les écritures sans manifeste, Guiterm à jour doit sortir
   *avant* qu'un vault partagé avec lui passe au manifeste.

Ma recommandation : 1 *simple* d'abord (sans fermer la porte à la
signature), 2 alerte rouge + blocage des écritures sur le vault concerné,
3 hors du manifeste, 4 refus serveur, 5 dans cet ordre.
