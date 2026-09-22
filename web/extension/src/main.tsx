import React from "react";
import ReactDOM from "react-dom/client";
import "../../src/index.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import { installPreferences } from "../../src/lib/preferences";
import { Popup } from "./Popup";

installPreferences();
// Assez large pour une arborescence indentée avec ses boutons ; Chrome
// plafonne un popup à 800 × 600.
document.documentElement.style.width = "440px";

// Les réglages du générateur peuvent avoir été changés depuis une page (le
// script de page les garde dans `chrome.storage.local`) : on les reprend
// avant que le panneau lise son `localStorage`.
chrome.storage.local
  .get("generator")
  .then((r) => {
    if (r.generator) localStorage.setItem("guivault.generator", JSON.stringify(r.generator));
  })
  .catch(() => {})
  .finally(() => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <Popup />
      </React.StrictMode>,
    );
  });
