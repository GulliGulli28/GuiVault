# Android

L'application Android de GuiVault : Tauri 2 mobile, la même interface que
le web mobile (`docs/DESIGN.md`, « Mobile »), le coffre local et le serveur
comme sur Windows, et ce que seul Android sait faire — d'abord la **bulle
flottante**. **État (2026-10-24, version 0.4.0)** : l'application est publiée avec
chaque release (APK signé par le CI) ; coffre local et serveur, toutes les
pages en mise en page mobile, onglets au doigt, bulle (réduire, déplacer,
se ranger au bord, rouvrir d'un toucher, grise une fois verrouillé, fermer
sur la croix ; automatique en quittant l'application, réglable),
déverrouillage biométrique, remplissage des autres applications
([`REMPLISSAGE.md`](REMPLISSAGE.md)), export et import d'un coffre
(« Exporter et importer un coffre »). Les marges
du système (barre d'état, barre de gestes, clavier) viennent de
`MainActivity.kt` : l'app est « bord à bord » et `env(safe-area-inset-*)`
vaut 0 dans la WebView ; la page les lit par `window.GuiVaultInsets`
(`web/app/src/mobile.ts`) dans les variables `--inset-top`,
`--inset-bottom` et `--inset-ime` (`index.css`), et les icônes de la barre
d'état suivent son thème. Ce qui manque : « Ce qui reste », plus bas.

**Publier** : comme l'application Windows — le tag `app-v<version>`
(`docs/APP.md`, « Publier une version »). Dans `app-release.yml`, le job
`android` (après `windows`, qui crée le brouillon) construit l'APK de release
(arm64, x86_64), le signe avec la clé des secrets `ANDROID_KEYSTORE_BASE64`
(le `.jks` en base64) et `ANDROID_KEYSTORE_PASSWORD`, vérifie la signature,
l'atteste (`gh attestation verify`), et le joint au brouillon avec sa somme
dans `SHA256SUMS.txt` et une ligne dans les notes. Lancé à la main (sans
tag), il ne laisse qu'un artefact. Empreinte du certificat (SHA-256) :
`4110b08feab1fdf6d033e5ac47e4f89eda10b21592c34efc77a2477b4535c109`. La
0.2.0, elle, a été construite sur le poste et jointe à la main.

**Bulle automatique** : en quittant l'application (accueil, récentes, une
autre appli ouverte d'ici), `MainActivity.onUserLeaveHint` lance la bulle si
le réglage le veut (`BubbleService.autoEnabled`, préférences Android, activé
par défaut ; commande `auto` du plugin) et que la permission est donnée —
l'activité est encore au premier plan, ce qu'exige Android 12+ pour un
service au premier plan. Les liens vers un site s'ouvrent dans le navigateur
du téléphone (`tauri-plugin-opener`, `web/app/src/links.ts`).

**Icône** : `scripts/android/icon-foreground.py` refait le premier plan de
l'icône adaptative depuis `logo_GuiVault.png` (62 % du carré : Android
découpe la zone centrale) ; à relancer après un `cargo tauri icon`. La bulle
prend `ic_launcher_round` (le logo seul) sur son disque sombre.

**Signature** : la clé des APK de release est **hors du dépôt**,
`%USERPROFILE%\.guivault-android\guivault-release.jks` (RSA 4096, alias
`guivault`), son mot de passe dans `keystore.properties` à côté ;
`gen/android/app/build.gradle.kts` les lit s'ils existent (sinon la release
n'est pas signée). **En garder une copie en lieu sûr** : perdue, une mise à
jour ne pourrait plus remplacer l'application installée (Android exige la
même clé). `scripts\android\build-apk.ps1 -Target aarch64,x86_64 -Release`
construit un APK de release signé pour les téléphones et l'émulateur. Une
release refuse le HTTP en clair (`usesCleartextTraffic`) : un serveur en
HTTPS.

Construire : `scripts/android-sync.sh` (WSL : construit `web/dist-app` et
recopie le dépôt dans `%USERPROFILE%\guivault-android`), puis
`scripts\android\build-apk.ps1` et `scripts\android\install.ps1` dans cette
copie. `gen/android` est versionné ; après un `cargo tauri android init`
côté Windows, `scripts/android-sync.sh --back` le rapatrie. Code : `lib.rs`
(point d'entrée mobile, `cfg(desktop)`), `bubble.rs`,
`gen/android/.../BubblePlugin.kt` et `BubbleService.kt`, `web/app/src/mobile.ts`
et `bubbleBridge.ts`.

Poste : `%USERPROFILE%\.gradle\init.d\maven-central-mirror.gradle` fait passer
Maven Central par le miroir de Google (ce réseau reçoit des 429), et
`org.gradle.configuration-cache=false` dans `%USERPROFILE%\.gradle\gradle.properties`
(le cache contournait le miroir), avec `org.gradle.daemon=false` et
`kotlin.compiler.execution.strategy=in-process` (un démon survivant gardait
ouverte la sortie lue depuis WSL). L'émulateur : `scripts\android\emulator.ps1`
(il s'arrête parfois faute de mémoire pendant une construction). Le CLI est `cargo tauri` (installé côté
Windows) : Gradle le rappelle tel quel, ce qui échouait avec `node tauri.js`.

## L'environnement (poste Windows, depuis WSL)

Tout est côté Windows, sans droits d'administrateur, dans
`%USERPROFILE%\android` ; npm reste côté WSL comme pour le binaire Windows
(`docs/APP.md`).

| Quoi | Où |
|---|---|
| JDK 17 (Temurin) | `%USERPROFILE%\android\jdk-17` (`JAVA_HOME`) |
| SDK Android | `%USERPROFILE%\android\sdk` (`ANDROID_HOME`) : `cmdline-tools/latest`, `platform-tools`, `emulator`, `platforms;android-36`, `build-tools;36.1.0` |
| NDK | `ndk;28.2.13676358` (`NDK_HOME`) |
| Image système | `system-images;android-36;google_apis;x86_64` (Android 16) |
| Émulateur | AVD `guivault` (Pixel 9, clavier du PC activé), accéléré par WHPX |
| Rust | cibles `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` (rustup Windows) |

Variables d'utilisateur posées : `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`, et
`JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=%USERPROFILE%\android\tmp` —
sans elle, Java (sdkmanager, Gradle) ne peut pas ouvrir son canal interne
(« Unable to establish loopback connection ») sous ce profil Windows.

Pièges :

- `sdkmanager` est désormais un alias de l'« Android CLI » : il accepte les
  noms de paquets avec `/` (`platforms/android-36`) ; avec `;`, `cmd` coupe
  le nom en morceaux. `avdmanager`, lui, veut les `;` : l'appeler depuis un
  `.cmd` (`create-avd.cmd`).
- Un `.bat` ne tourne pas dans un dossier UNC (`\\wsl.localhost\…`) :
  `Set-Location` vers un dossier Windows d'abord.
- `adb exec-out screencap > fichier` depuis PowerShell abîme le PNG
  (UTF-16) : `screencap -p /sdcard/…` puis `adb pull` (`shot.cmd`).
- `tauri android build` relie la bibliothèque Rust par un **lien
  symbolique** : il faut le **mode développeur de Windows** (Paramètres ›
  Système › Pour les développeurs). Sans lui, la compilation Rust passe
  (vérifié : une app Tauri jetable, `x86_64-linux-android`) et l'étape
  Gradle échoue sur « Creation symbolic link is not allowed ».

## L'émulateur

```powershell
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd guivault -no-snapshot-save
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices
```

Le web mobile dans le vrai Chrome Android, contre le serveur de dev de WSL
(`npm run dev` sur 1431, `/api` vers le serveur) : `adb reverse tcp:1431
tcp:1431` puis ouvrir `http://localhost:1431/` — `localhost` garde un
contexte sécurisé. Pour le piloter (Playwright, comme le reste) :
`adb forward tcp:9222 localabstract:chrome_devtools_remote` puis
`chromium.connectOverCDP("http://localhost:9222")` depuis Node Windows.
Vérifié le 2026-10-22 : déverrouillage (Argon2id compris, ~15 s sur
l'émulateur), coffre et fiche en Chrome 133 / Android 16.

## Ce qui reste

Vérifié jusqu'ici sur l'émulateur (Android 16, Pixel 9) : ce qui suit est
ce qui manque, du plus pressant au plus confortable.

**À vérifier**

- [ ] **Sur un vrai téléphone** : clavier et feuilles (`--inset-ime`), bulle
  automatique en quittant, liens vers le navigateur, gestes entre onglets,
  Argon2id (≈ 15 s sur l'émulateur : à mesurer sur un milieu de gamme).
- [ ] **Bulle en ouvrant un lien** : « Visiter le site » quitte l'app vers le
  navigateur, et la bulle apparaît (`onUserLeaveHint`). Cohérent avec « en
  quittant l'application » ; à garder ou à écarter pour ce cas (retenir un
  drapeau dans `links.ts` avant d'ouvrir, que `MainActivity` lirait).

**Les données du coffre local**

- [x] **Sortir un coffre de l'appareil, en faire entrer un** : voir
  « Exporter et importer un coffre », plus bas.
- [x] **Sauvegarde Android** : décidé — pas de coffre dans le cloud de
  Google, transfert vers un nouveau téléphone oui (même section).
- [ ] Les sauvegardes automatiques du coffre local (`LocalBackups`) : à
  vérifier sur Android (la restauration crée une copie dans le dossier de
  l'app, `pickRestoreDest`).

**Sécurité et confort**

- [x] **Déverrouillage biométrique** : voir « Déverrouillage biométrique »,
  plus bas. Reste : le proposer de lui-même après un déverrouillage par mot
  de passe, et, pour un compte du serveur, survivre à un redémarrage de
  l'application (garder le jeton de rafraîchissement sur l'appareil, comme
  Bitwarden).
- [x] **Service de remplissage Android** (`AutofillService`, comme KeePassDX
  et Bitwarden) : les identifiants dans les autres applications et dans
  Chrome, sous le champ ou dans la barre du clavier ; coffre verrouillé,
  une empreinte — [`REMPLISSAGE.md`](REMPLISSAGE.md), qui liste la suite
  (enregistrer après une connexion, code 2FA, Credential Manager).
- [ ] **`FLAG_SECURE`** : ni captures d'écran ni aperçu dans les
  applications récentes tant qu'un coffre est ouvert (réglable, il gêne
  les captures voulues).
- [ ] **Presse-papiers** : marquer ce qui est copié comme sensible
  (`ClipDescription.EXTRA_IS_SENSITIVE`, Android 13+ : pas d'aperçu dans la
  notification du système) ; l'effacement au bout du délai passe déjà par
  `lib/clipboard.ts`.
- [ ] **Panneau sur la bulle** (recherche, codes 2FA) : à peser, voir
  « La bulle flottante ».

**Distribution**

- [ ] **Mises à jour** : pas d'updater sur Android ; on installe l'APK
  suivant par-dessus (même clé). Piste : signaler une version plus récente
  (lire `latest.json` d'`app-updater`) et ouvrir la release, sans
  installer soi-même.
- [ ] Un APK par architecture (aujourd'hui universel arm64 + x86_64, ~2×
  plus lourd) ; F-Droid ou le Play Store seulement si on le décide
  (`SYSTEM_ALERT_WINDOW` y est examinée de près).
- [ ] Tablettes et paysage : l'interface passe au bureau au-delà de
  768 px ; jamais regardé sur une tablette.

## Exporter et importer un coffre

Les coffres vivent dans le dossier privé de l'application
(`/data/user/0/dev.guivault.client/coffres`), que la désinstallation efface.

- **Exporter** (Paramètres › Compte › Sauvegardes, « Exporter le coffre ») :
  une archive `<nom>.zip` rangée où l'on veut par le sélecteur de documents
  d'Android (Téléchargements, Drive, Nextcloud… — aucune permission de
  stockage). Elle contient le dossier du coffre, `<nom>.guivault/coffre.json`
  et `attachments/`, **sans les sauvegardes** (elles s'ouvrent avec le mot
  de passe maître de leur date, peut-être un ancien) ni le verrou. Chiffrée
  comme sur l'appareil : décompressée, elle s'ouvre telle quelle au bureau,
  ou par `gv recover` (qui lit aussi le `.zip`).
- **Importer** (accueil, « Importer un coffre ») : une archive de ce genre,
  ou un `coffre.json` seul. Elle devient un coffre de l'appareil, sous un
  nom libre (« Mon coffre 2 » si le nom est pris) ; si l'appareil a déjà ce
  coffre (même identifiant), la copie en reçoit un autre, pour ne pas
  hériter des révisions vues et manifestes de l'original.

Code : `CoffreFilePlugin.kt` (sélecteur, zip, dézip — un nom qui sort du
dossier, « zip slip », est refusé, comme une archive de plus de 4 Gio ou
200 000 fichiers), `src/coffre_file.rs` et, dans `src/lib.rs`,
`local_export_snapshot` (copie cohérente sous le verrou, dans le cache),
`local_staging` et `local_import` (qui n'efface que dans le cache) ;
`guivault_local::export_coffre` / `import_coffre` (`crates/guivault-local/src/export.rs`,
testés) ; interface : `web/app/src/coffreFileBridge.ts`,
`src/components/CoffreExport.tsx`, bouton de `AppWelcome`. Vérifié sur
l'émulateur : export vers Téléchargements, archive relue par `gv recover`,
import (nouvel identifiant à côté de l'original), archive piégée refusée
sans rien écrire hors du dossier temporaire.

**Sauvegarde Android** (`res/xml/data_extraction_rules.xml`, Android 12+ ;
`backup_rules.xml` avant) : la sauvegarde Google (cloud) n'emporte **ni les
coffres** — qui choisit un coffre local ne l'attend pas dans le cloud de
Google, même chiffré — ni ce qui ne vaut qu'avec une clé du Keystore de ce
téléphone (préférences de la biométrie, index du remplissage), qui ne se
restaure pas. Le **transfert d'un téléphone à l'autre** (câble ou réseau
local, à la mise en service du nouveau) emporte les coffres, chiffrés, pas
le reste : sur le nouveau téléphone, biométrie et remplissage se
réactivent. Avant Android 12, une seule règle pour les deux : les coffres
n'y sont pas. Reste vrai : exporter est le seul moyen sûr de garder un
coffre hors du téléphone.

## Déverrouillage biométrique

Paramètres › Sécurité (et l'onglet Réglages, « Déverrouillage ») :
« Déverrouiller par biométrie », pour le coffre local ou le compte ouvert.

- **Ce qui est gardé** : la user key et le compte enveloppé
  (`AccountBlobs`, déjà chiffré), en JSON, chiffrés en AES-256-GCM sous une
  clé du **Keystore Android** (`guivault.biometric`) :
  `setUserAuthenticationRequired`, une authentification **biométrique forte**
  (classe 3) **à chaque usage** (`setUserAuthenticationParameters(0,
  AUTH_BIOMETRIC_STRONG)`, `CryptoObject`), détruite si les empreintes
  changent (`setInvalidatedByBiometricEnrollment`) — tout est alors oublié
  et le mot de passe redemandé. Le chiffré et son IV sont dans les
  préférences privées de l'app (`guivault_biometric`), un par coffre
  (`local:<chemin>`, `server:<url>:<id du compte>`). Rien ne part au
  serveur ; la règle n°1 n'est pas touchée.
- **Le mot de passe maître reste demandé** après un redémarrage du
  téléphone (`Settings.Global.BOOT_COUNT` retenu à chaque déverrouillage
  par mot de passe) et au bout de 14 jours sans lui ; l'invite n'est alors
  même pas montrée, l'écran le dit.
- **Coffre local** : se rouvre aussi après avoir quitté l'application
  (`session.openLocalWithUserKey`). **Compte du serveur** : tant que sa
  session est ouverte — un verrouillage (à la main, inactivité) garde les
  jetons, l'écran « Déverrouiller » du compte rouvre sans nouvelle
  connexion (`session.resumeWithUserKey`) ; après un redémarrage de
  l'application, le mot de passe.
- **L'écran** : après un verrouillage, l'accueil rouvre directement le
  coffre ou le compte verrouillé (`session.lockedTarget`), et l'invite
  s'ouvre d'elle-même ; « Mot de passe maître » la ferme.
- Code : `BiometricPlugin.kt`, `src/biometric.rs`,
  `web/app/src/biometricBridge.ts`, `web/src/lib/biometric.ts`,
  `components/BiometricSetting.tsx`, `AppWelcome.tsx` (`UnlockForm`,
  `ServerLocked`).
- Émulateur : un code de verrouillage (`adb shell locksettings set-pin
  1234`), une empreinte enregistrée dans les réglages, puis `adb emu finger
  touch 1` pour poser le doigt.

## La bulle flottante

Réduire GuiVault à une bulle qui flotte au-dessus des autres applications,
comme les « chat heads » de Messenger : on la déplace du doigt, elle se
range contre un bord, un toucher rouvre GuiVault, la glisser sur la croix en
bas la ferme.

- **Comment** : un plugin Tauri en Kotlin. Une *fenêtre de superposition*
  (`WindowManager`, `TYPE_APPLICATION_OVERLAY`) tenue par un service au
  premier plan (`foregroundServiceType="specialUse"`, Android 14+), avec sa
  notification. Permission « Afficher par-dessus d'autres applis »
  (`SYSTEM_ALERT_WINDOW`), demandée une fois par l'écran des réglages
  d'Android (`ACTION_MANAGE_OVERLAY_PERMISSION`).
- **Mouvements** (`BubbleService.kt`, ressorts de `androidx.dynamicanimation`) :
  elle naît en rebondissant depuis le bord, s'enfonce sous le doigt, se lance
  d'un geste vers un bord (la vitesse du doigt compte), retient sa place
  d'une fois sur l'autre ; la croix monte dans un voile et **aimante** la
  bulle (vibration), qui s'y engouffre.
- **Entre la bulle et le plein écran** : Android n'accorde pas d'animation
  propre à une tâche qu'un service ramène au premier plan
  (`makeScaleUpAnimation` y est ignorée) ; c'est donc la bulle qui anime.
  En quittant l'application, une image de sa fenêtre (`PixelCopy`,
  `BubbleService.capture`) ; au toucher, cette image grandit depuis la
  bulle jusqu'au plein écran (ressort, coins arrondis, l'autre application
  s'assombrit), puis GuiVault revient dessous et l'image s'efface une fois
  sa fenêtre dessinée et l'animation du système finie. « Réduire en bulle »
  fait l'inverse (`collapse`) : l'image couvre l'écran, l'application passe
  derrière, l'image rétrécit jusqu'à la bulle. La fenêtre de l'image prend
  les touchers le temps de l'animation : une superposition qui les laisse
  passer, Android 12+ la rend translucide (opacité plafonnée à 0,8).
  **Verrouillé, aucune image n'est gardée** (`setLocked` l'efface) : c'est
  le logo qui grandit, sur le fond de l'application.
- **Pas l'API « Bubbles »** d'Android 11+ : elle est réservée aux
  conversations (notification `MessagingStyle` + raccourci), c'est elle que
  Messenger utilise aujourd'hui ; un gestionnaire de mots de passe n'y a pas
  sa place. La superposition est le comportement « d'une époque ».
- **Dans l'interface** : « Réduire en bulle » (en-tête mobile, Réglages) ;
  l'application passe à l'arrière-plan et la bulle apparaît.
- **Sécurité** : la bulle ne montre **aucun secret** — le logo seulement,
  gris quand le coffre est verrouillé. Le verrouillage d'inactivité
  continue de courir ; rouvrir depuis la bulle redemande le mot de passe
  s'il est passé. Une seconde étape possible : un panneau qui s'ouvre sur la
  bulle (recherche, codes 2FA) — à peser, puisqu'il montrerait des secrets
  par-dessus une autre application.
- **Publication** : `SYSTEM_ALERT_WINDOW` est examinée de près par le Play
  Store ; sans souci pour un APK installé à la main.
