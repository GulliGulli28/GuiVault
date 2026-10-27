# Politique de sécurité

*[English version below](#security-policy)*

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
- l'application (coffre local, hôte natif, saisie automatique, agent SSH,
  remplissage Android).

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

---

# Security policy

GuiVault keeps secrets: a vulnerability matters more than a bug. Thank you
for taking the time to report it.

## Reporting a vulnerability

- **Through a [private security advisory](https://github.com/GulliGulli28/GuiVault/security/advisories/new)**
  on GitHub — not a public issue, a discussion or a pull request.
- In French or English.
- Useful: the version (server commit, app or extension version), steps to
  reproduce, what an attacker gains, and the assumed attacker model
  (network, compromised server, compromised device… — see
  [`docs/SECURITY.md`](docs/SECURITY.md), in French).

Every GuiVault server also serves `/.well-known/security.txt` (RFC 9116):
its operator's contact if they declared one, then the project's.

## What to expect

GuiVault is maintained by **a single person**: these response times are
best-effort commitments.

| Step | Target time |
|---|---|
| Acknowledgement | 3 days |
| First assessment (reproduced or not, severity) | 7 days |
| Fix released — critical or high severity | 14 days |
| Fix released — medium or low severity | 60 days |
| Advisory published | with the fix, or after 90 days at the latest, by mutual agreement |

You are kept informed at every step, and credited in the advisory if you
wish. There is **no bug bounty yet**: it will come after an external audit
(`docs/ROADMAP.md`, §7).

## Maintained versions

| Component | Maintained version |
|---|---|
| Server (`guivault-server`), web interface, `gv` | the `main` branch |
| Windows and Android app | the latest [`app-v*` release](https://github.com/GulliGulli28/GuiVault/releases) |
| Browser extension | the `main` branch |
| Encrypted formats (`guivault-crypto`) | every published format stays readable |

A security fix isn't backported to older versions of the app: it updates
itself (Windows) or is installed over the current one (Android).

## Scope

**In scope** — anything that contradicts [`docs/SECURITY.md`](docs/SECURITY.md),
in particular:

- a server, a database or a backup that would allow reading a secret,
  impersonating a user or modifying encrypted data without the clients
  noticing;
- the cryptography (`crates/guivault-crypto`, `web/src/lib/crypto.ts`) and
  the interoperability between the two;
- authentication, sessions, sharing, emergency access, share links;
- the extension filling a login on the wrong site or in a third-party
  frame;
- the app (local vault, native host, auto-type, SSH agent, Android
  autofill).

**Out of scope**:

- an instance you don't operate: report to its operator first (its
  `security.txt`);
- limits already documented in [`docs/SECURITY.md`](docs/SECURITY.md),
  “Limites connues” — unless you show they go further than written;
- volumetric denial of service, social engineering, an already compromised
  device (keylogger, malware running with the user's rights).

## Good-faith rules

Test on your own instance (`docker compose up`, see the README), not on
someone else's. Don't access or modify other people's data, don't degrade
a service. Research carried out in good faith within these limits will not
be pursued by us.
