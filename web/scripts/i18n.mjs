#!/usr/bin/env node
// Les textes à traduire de l'interface (`src/lib/i18n.ts`) : chaque
// `t("…")`, chaque forme de `plural(n, "…", "…")`, et les libellés des
// tables `translated({ … })`. Partagé par `src/lib/i18n.test.ts` (tout est
// traduit, rien d'orphelin) et par la ligne de commande :
//
//   node scripts/i18n.mjs            # ce qui manque à src/i18n/en.json
//   node scripts/i18n.mjs --stale    # ce qui y est en trop
//   node scripts/i18n.mjs --content  # réécrit extension/src/contentText.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "app/src", "extension"];
const SKIP = /\.test\.|\.testing\.|node_modules|\/e2e\/|\/dist|i18n\.ts$/;

function files(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.test(p + "/")) walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !SKIP.test(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const STRING = /"((?:[^"\\\n]|\\.)*)"/y;

/** La chaîne JSON qui commence à `i` (guillemet), et où elle finit. */
function readString(src, i) {
  STRING.lastIndex = i;
  const m = STRING.exec(src);
  return m ? { value: JSON.parse(`"${m[1]}"`), end: STRING.lastIndex } : null;
}

function skipSpace(src, i) {
  while (/\s/.test(src[i] ?? "")) i++;
  return i;
}

/** L'indice juste après la parenthèse qui ferme celle ouverte en `i`. */
function closing(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (j++; j < src.length && src[j] !== q; j++) if (src[j] === "\\") j++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return src.length;
}

// Pas un texte : identifiant, classe, couleur CSS, pile de polices.
/** Les arguments, au premier niveau, de l'appel dont la parenthèse ouvre en
 * `open` : leurs bornes `[start, end)`. */
function topLevelArgs(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      for (j++; j < src.length && src[j] !== q; j++) if (src[j] === "\\") j++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push({ start, end: j });
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push({ start, end: j });
      start = j + 1;
    }
  }
  return args;
}

const looksLikeText = (s) => /[A-Za-zÀ-ÿ]/.test(s) && !/^[a-z0-9_\-:.\/\[\]#%()]+$/.test(s) && !/^(tag-|var\(|rgba?\(|#)/.test(s) && !/", |, (system-ui|sans-serif|monospace)/.test(s);

export function extractKeys(root = webRoot) {
  const keys = new Map();
  const add = (k, file) => {
    if (!keys.has(k)) keys.set(k, new Set());
    keys.get(k).add(path.relative(root, file));
  };
  for (const dir of DIRS) {
    for (const file of files(path.join(root, dir))) {
      const src = fs.readFileSync(file, "utf8");
      // t("…") et plural(n, "…", "…")
      for (const m of src.matchAll(/\b(t|plural)\(/g)) {
        if (/[\w.$]/.test(src[m.index - 1] ?? "")) continue;
        let i = m.index + m[0].length;
        if (m[1] === "t") {
          const s = src[skipSpace(src, i)] === '"' ? readString(src, skipSpace(src, i)) : null;
          if (s) add(s.value, file);
        } else {
          // Les formes sont les deuxième et troisième arguments.
          for (const arg of topLevelArgs(src, m.index + m[0].length - 1).slice(1, 3)) {
            const at = skipSpace(src, arg.start);
            const s = src[at] === '"' ? readString(src, at) : null;
            if (s && skipSpace(src, s.end) === arg.end) add(s.value, file);
          }
        }
      }
      // translated({ … }) : les valeurs textuelles (pas les clés).
      for (const m of src.matchAll(/\btranslated\(/g)) {
        const end = closing(src, m.index + m[0].length - 1);
        // `translated(table, ["label", …])` : seulement ces champs-là.
        const only = /,\s*\[([^\]]*)\]\s*\)$/.exec(src.slice(m.index, end));
        const fields = only ? [...only[1].matchAll(/"([^"]+)"/g)].map((f) => f[1]) : null;
        for (let j = m.index + m[0].length; j < end; j++) {
          if (src[j] === "'" || src[j] === "`") {
            const q = src[j];
            for (j++; j < end && src[j] !== q; j++) if (src[j] === "\\") j++;
            continue;
          }
          if (src[j] !== '"') continue;
          const s = readString(src, j);
          if (!s) continue;
          const start = j;
          j = s.end - 1;
          const after = src[skipSpace(src, s.end)];
          if (after === ":") continue; // une clé d'objet
          if (fields) {
            const prop = /(\w+)\s*:\s*$/.exec(src.slice(Math.max(0, start - 40), start));
            if (!prop || !fields.includes(prop[1])) continue;
          }
          // Dans une table, un mot seul en minuscules est un libellé (« note »).
          if (looksLikeText(s.value) || (/^[a-zà-ÿ][a-zà-ÿ' ]*$/.test(s.value) && /[a-zà-ÿ]{2}/.test(s.value))) add(s.value, file);
        }
      }
    }
  }
  return keys;
}

/** Le script de page de l'extension n'embarque que ses propres textes
 * (`extension/src/contentI18n.ts`) : le sous-catalogue de ses fichiers. */
export const CONTENT_FILES = ["extension/src/content.ts"];

export function contentCatalog(root = webRoot) {
  const en = loadCatalog(root);
  const out = {};
  for (const [k, files] of extractKeys(root)) {
    if ([...files].some((f) => CONTENT_FILES.includes(f)) && k in en) out[k] = en[k];
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function loadCatalog(root = webRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, "src/i18n/en.json"), "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const keys = extractKeys();
  const en = loadCatalog();
  if (process.argv.includes("--content")) {
    fs.writeFileSync(path.join(webRoot, "extension/src/contentText.json"), JSON.stringify(contentCatalog(), null, 1) + "\n");
  } else if (process.argv.includes("--stale")) {
    console.log(JSON.stringify(Object.keys(en).filter((k) => !keys.has(k)), null, 1));
  } else {
    const missing = [...keys.keys()].filter((k) => !(k in en));
    console.log(JSON.stringify(missing, null, 1));
    console.error(`${missing.length} texte(s) sans traduction, sur ${keys.size}.`);
  }
}
