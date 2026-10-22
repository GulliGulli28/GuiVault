# Android

L'application Android de GuiVault : Tauri 2 mobile, la même interface que
le web mobile (`docs/DESIGN.md`, « Mobile »), le coffre local et le serveur
comme sur Windows, et ce que seul Android sait faire — d'abord la **bulle
flottante**. **En préparation** : l'environnement est en place (ci-dessous),
le portage de `app-tauri/` n'est pas commencé.

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

## La suite : l'application

1. **Portage de `app-tauri/`** : `tauri android init`, crate en `lib`
   (`mobile_entry_point`) ; ce qui n'existe qu'au bureau passe sous
   `cfg(desktop)` — zone de notification, raccourci global, instance
   unique, démarrage automatique, updater, hôte natif de l'extension,
   saisie automatique, presse-papiers Windows. Le coffre local
   (`guivault-local`) dans le dossier de données de l'app ; ouvrir ou créer
   un coffre par le sélecteur de documents d'Android.
2. **Mobile d'abord** : l'interface est celle du web sous 768 px ; les ponts
   (`lib/platform.ts`) disent ce que l'application Android sait faire.
3. **Plus tard** : déverrouillage biométrique (la clé du coffre sous une clé
   du Keystore, déverrouillée par l'empreinte), remplissage dans les autres
   applications (service Autofill d'Android), `FLAG_SECURE` contre les
   captures.

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
