import React from "react";
import ReactDOM from "react-dom/client";
import "../../src/index.css";
import "../../src/fonts";
import { loadLanguageSetting, setLanguageMirror, useLanguage } from "../../src/lib/i18n";
import { installPreferences } from "../../src/lib/preferences";
import { Popup } from "./Popup";

installPreferences();
// La langue choisie ici vaut aussi pour le service worker et les scripts de
// page, qui ne voient pas ce `localStorage` : recopiée dans
// `chrome.storage.local`.
setLanguageMirror((language) => void chrome.storage.local.set({ language }));
void chrome.storage.local.set({ language: loadLanguageSetting() });

/** Le panneau, redessiné de neuf quand la langue change. */
function Root() {
  const lang = useLanguage();
  return <Popup key={lang} />;
}
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
        <Root />
      </React.StrictMode>,
    );
  });
