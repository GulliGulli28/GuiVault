import React from "react";
import ReactDOM from "react-dom/client";
import App from "../../src/App";
import "../../src/index.css";
import "../../src/touch.css";
import "../../src/fonts";
import { installPreferences } from "../../src/lib/preferences";
import { setDeviceLabel } from "../../src/lib/session";
import { AppWelcome } from "./AppWelcome";
import { installAutoType } from "./autotypeBridge";
import { installClipboard } from "./clipboardBridge";
import { installSystem } from "./systemBridge";
import { installBackups } from "./backupBridge";
import { installUpdater } from "./updaterBridge";
import { installCoffres } from "./coffreBridge";
import { installBubble } from "./bubbleBridge";
import { detectMobile, isMobile } from "./mobile";

// Comme l'interface web (`src/main.tsx`), sans le service worker : l'app
// embarque déjà son interface.
installPreferences();
setDeviceLabel("Application GuiVault");

// Ce que l'application ajoute (saisie automatique, presse-papiers natif)
// d'abord — quelques millisecondes : les composants regardent au rendu si
// c'est là.
// Sur mobile (Android), pas d'updater : les mises à jour passent par
// l'installation d'un APK.
void detectMobile().then(() => {
  installBackups();
  if (!isMobile()) installUpdater();
  installCoffres();
  return Promise.allSettled([installAutoType(), installClipboard(), installSystem(), installBubble()]);
}).finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App Welcome={AppWelcome} />
    </React.StrictMode>,
  );
});
