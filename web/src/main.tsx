import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./touch.css";
import "./fonts";
import { installPreferences } from "./lib/preferences";

// Fond, accent, police et tailles de ligne : posés avant le premier rendu
// pour ne pas voir le thème par défaut clignoter.
installPreferences();

// L'interface gardée pour s'ouvrir quand le serveur ne répond pas
// (`public/sw.js`, avec la copie hors ligne) — en production seulement (en
// développement, elle garderait des versions périmées), et en contexte
// sécurisé, que les service workers exigent.
if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
