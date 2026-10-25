# Politique de sécurité

GuiVault garde des secrets : une faille compte plus qu'un bogue. Merci de
prendre le temps de la signaler.

## Signaler une vulnérabilité

- **Par une [*security advisory* privée](https://github.com/GulliGulli28/GuiVault/security/advisories/new)**
  sur GitHub — pas par une issue publique, une discussion ou une pull
  request.
- En français ou en anglais.
- Utile : la version (commit du serveur, version de l'application ou de
  l'extension), les étapes pour reproduire, ce qu'un attaquant y gagne, et
  le modèle d'attaquant supposé (réseau, serveur compromis, poste
  compromis… — voir [`docs/SECURITY.md`](docs/SECURITY.md)).

Chaque serveur GuiVault sert aussi `/.well-known/security.txt` (RFC 9116) :
le contact de son opérateur s'il en a déclaré un, puis celui du projet.

## Ce à quoi vous attendre

GuiVault est maintenu par **une seule personne** : ces délais sont des
engagements de moyens, tenus au mieux.

| Étape | Délai visé |
|---|---|
| Accusé de réception | 3 jours |
| Première évaluation (reproduite ou non, gravité) | 7 jours |
| Correctif publié — gravité critique ou élevée | 14 jours |
| Correctif publié — gravité moyenne ou faible | 60 jours |
| Publication de l'avis | avec le correctif, ou à 90 jours au plus tard, d'un commun accord |

Vous êtes tenu au courant à chaque étape, et crédité dans l'avis si vous le
souhaitez. Il n'y a **pas encore de prime aux bogues** : elle viendra après
un audit externe (`docs/ROADMAP.md`, §7).

## Versions maintenues

| Composant | Version maintenue |
|---|---|
| Serveur (`guivault-server`), interface web, `gv` | la branche `main` |
| Application Windows et Android | la dernière [release `app-v*`](https://github.com/GulliGulli28/GuiVault/releases) |
| Extension de navigateur | la branche `main` |
| Formats chiffrés (`guivault-crypto`) | tous les formats publiés restent lisibles |

Un correctif de sécurité n'est pas rétroporté sur les anciennes versions de
l'application : elle se met à jour d'elle-même (Windows) ou s'installe
par-dessus (Android).

## Périmètre

**Dans le périmètre** — tout ce qui contredit [`docs/SECURITY.md`](docs/SECURITY.md),
en particulier :

- un serveur, une base ou une sauvegarde qui permettrait de lire un secret,
  de se faire passer pour un utilisateur ou de modifier des données
  chiffrées sans que les clients le voient ;
- la cryptographie (`crates/guivault-crypto`, `web/src/lib/crypto.ts`) et
  l'interopérabilité entre les deux ;
- l'authentification, les sessions, le partage, l'accès d'urgence, les
  liens de partage ;
- l'extension qui remplirait un identifiant sur le mauvais site ou dans un
  cadre tiers ;
- l'application (coffre local, hôte natif, saisie automatique, remplissage
  Android).

**Hors périmètre** :

- une instance que vous n'opérez pas : signalez d'abord à son opérateur
  (son `security.txt`) ;
- les limites déjà documentées dans [`docs/SECURITY.md`](docs/SECURITY.md),
  « Limites connues » — sauf à montrer qu'elles vont plus loin qu'écrit ;
- le déni de service par volume, l'ingénierie sociale, un poste déjà
  compromis (enregistreur de frappe, logiciel malveillant avec les droits
  de l'utilisateur).

## Règles de bonne foi

Testez sur votre propre instance (`docker compose up`, voir le README), pas
sur celle d'un autre. N'accédez pas aux données d'autrui, ne les modifiez
pas, ne dégradez pas un service. Une recherche menée de bonne foi dans ces
limites ne fera l'objet d'aucune poursuite de notre part.
