import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
// La mono de Guiterm (JetBrains Mono), sous-ensemble latin ; la police
// d'interface est celle du système, comme son réglage par défaut.
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-ext-400.css";
import { applyTheme, loadTheme } from "./lib/theme";

applyTheme(loadTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
