import React from "react";
import ReactDOM from "react-dom/client";
import "../../src/index.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import { applyTheme, loadTheme } from "../../src/lib/theme";
import { Popup } from "./Popup";

applyTheme(loadTheme());
document.documentElement.style.width = "380px";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
