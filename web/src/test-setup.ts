// Les tests vérifient les textes de l'interface en français : la langue est
// fixée, quel que soit le `navigator` de Node (en-US à partir de Node 21).
import { applyLanguageSetting } from "./lib/i18n";

applyLanguageSetting("fr");
