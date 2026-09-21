import React from "react";
import ReactDOM from "react-dom/client";
import "../../src/index.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import { applyTheme, loadTheme } from "../../src/lib/theme";
import { Popup } from "./Popup";

applyTheme(loadTheme());
document.documentElement.style.width = "380px";

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
