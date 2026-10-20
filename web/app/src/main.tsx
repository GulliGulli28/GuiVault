import React from "react";
import ReactDOM from "react-dom/client";
import App from "../../src/App";
import "../../src/index.css";
import "../../src/touch.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-ext-400.css";
import { installPreferences } from "../../src/lib/preferences";
import { setDeviceLabel } from "../../src/lib/session";
import { AppWelcome } from "./AppWelcome";

// Comme l'interface web (`src/main.tsx`), sans le service worker : l'app
// embarque déjà son interface.
installPreferences();
setDeviceLabel("Application GuiVault");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App Welcome={AppWelcome} />
  </React.StrictMode>,
);
