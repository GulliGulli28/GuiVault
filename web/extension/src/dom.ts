/** Le DOM tel que le voit le script de page : à travers les **shadow roots**
 * (ouverts, et fermés — un script d'extension y entre, une page non), dans
 * l'ordre où on les lit, et une saisie qui ressemble à une frappe pour les
 * frameworks. Sans état : `content.ts` s'en sert, les tests de
 * `extension/e2e` le mettent à l'épreuve dans un vrai Chromium. */

/** L'élément hôte de l'interface injectée : jamais pris pour un champ de
 * la page. */
export const HOST_ID = "guivault-inline";

type ChromeDom = { dom?: { openOrClosedShadowRoot?: (e: HTMLElement) => ShadowRoot | null } };

/** La shadow root d'un élément, ouverte ou fermée : `chrome.dom` dans
 * Chrome, `openOrClosedShadowRoot()` dans Firefox, `shadowRoot` sinon
 * (ouverte seulement). */
export function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  // Une racine fermée est presque toujours celle d'un composant (un nom à
  // tiret) : on ne demande qu'à ceux-là, pas à chaque `div` de la page.
  if (!el.tagName.includes("-")) return null;
  try {
    const viaChrome = (globalThis as { chrome?: ChromeDom }).chrome?.dom?.openOrClosedShadowRoot?.(el as HTMLElement);
    if (viaChrome) return viaChrome;
  } catch {
    // pas de racine
  }
  const ff = (el as Element & { openOrClosedShadowRoot?: () => ShadowRoot | null }).openOrClosedShadowRoot;
  if (typeof ff === "function") {
    try {
      return ff.call(el);
    } catch {
      return null;
    }
  }
  return null;
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "SVG", "svg", "IFRAME", "FRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO", "CANVAS"]);

/** Parcourt `root` et chaque shadow root rencontrée, dans l'ordre de
 * lecture : l'hôte, puis son contenu fantôme, puis ses frères. */
function walk(root: Document | ShadowRoot, onInput: (i: HTMLInputElement) => void, onRoot: (r: ShadowRoot) => void) {
  const doc = root instanceof Document ? root : root.ownerDocument;
  const w = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      const el = n as Element;
      if (SKIP.has(el.tagName) || el.id === HOST_ID) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const el = n as Element;
    if (el.tagName === "INPUT") onInput(el as HTMLInputElement);
    const sr = shadowOf(el);
    if (sr) {
      onRoot(sr);
      walk(sr, onInput, onRoot);
    }
  }
}

/** Tous les `<input>` de la page, shadow roots comprises, et les shadow
 * roots elles-mêmes (pour y écouter ce que le document n'entend pas). */
export function collect(doc: Document = document): { inputs: HTMLInputElement[]; roots: ShadowRoot[] } {
  const inputs: HTMLInputElement[] = [];
  const roots: ShadowRoot[] = [];
  walk(doc, (i) => inputs.push(i), (r) => roots.push(r));
  return { inputs, roots };
}

export function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = getComputedStyle(el);
  // Pas de seuil d'opacité : un champ de code transparent posé sur des
  // cases dessinées est le vrai champ.
  return st.visibility !== "hidden" && st.display !== "none";
}

/** Un champ utilisable : visible, ni désactivé ni en lecture seule. */
export const usable = (i: HTMLInputElement) => !i.disabled && !i.readOnly && visible(i);

/** Les champs utilisables de la page, shadow roots comprises. */
export function usableInputs(doc: Document = document): HTMLInputElement[] {
  return collect(doc).inputs.filter(usable);
}

/** L'élément qui a vraiment le focus, au fond des shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
  let a: Element | null = doc.activeElement;
  for (let depth = 0; a && depth < 32; depth++) {
    const inner = shadowOf(a)?.activeElement;
    if (!inner) break;
    a = inner;
  }
  return a;
}

/** Le champ d'où vient un événement : le premier du chemin composé quand il
 * est visible (racine ouverte), sinon l'élément actif (racine fermée : le
 * chemin s'arrête à l'hôte). */
export function eventInput(e: Event): HTMLInputElement | null {
  const first = e.composedPath()[0];
  if (first instanceof HTMLInputElement) return first;
  const active = deepActiveElement();
  return active instanceof HTMLInputElement ? active : null;
}

/** L'élément d'où vient un événement, au plus profond qu'on puisse voir. */
export function eventElement(e: Event): Element | null {
  const first = e.composedPath()[0];
  return first instanceof Element ? first : e.target instanceof Element ? e.target : null;
}

/** Tout ce qui nomme un champ : attributs, libellés (`labels` — `for` ou
 * englobant, dans son propre arbre), `aria-labelledby` résolu dans la même
 * racine, texte juste avant. En minuscules, espaces réduits. */
export function hintOf(i: HTMLInputElement): string {
  const parts: (string | null | undefined)[] = [i.name, i.id, i.autocomplete, i.placeholder, i.getAttribute("aria-label"), i.title, i.className];
  const root = i.getRootNode() as Document | ShadowRoot;
  for (const id of (i.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) parts.push(root.getElementById?.(id)?.textContent);
  for (const l of Array.from(i.labels ?? [])) parts.push(l.textContent);
  const prev = i.previousElementSibling ?? i.parentElement?.previousElementSibling;
  if (prev && prev.textContent && prev.textContent.length < 60) parts.push(prev.textContent);
  // Un champ seul dans son composant : le texte de l'hôte qui l'annonce.
  if (root instanceof ShadowRoot && !i.labels?.length) parts.push(root.host.getAttribute("label"), root.host.getAttribute("aria-label"), root.host.getAttribute("placeholder"));
  return parts.filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ");
}

/** Pose une valeur comme le ferait une frappe : le setter natif (React garde
 * sinon son propre état), puis les événements qu'une saisie produit —
 * `composed`, pour sortir d'une shadow root jusqu'aux écouteurs du
 * composant qui l'héberge. */
export function setValue(el: HTMLInputElement, value: string) {
  const opts = { bubbles: true, composed: true };
  el.focus({ preventScroll: true });
  el.dispatchEvent(new KeyboardEvent("keydown", { ...opts, key: "Unidentified" }));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new InputEvent("input", { ...opts, inputType: "insertReplacementText", data: value }));
  el.dispatchEvent(new KeyboardEvent("keyup", { ...opts, key: "Unidentified" }));
  el.dispatchEvent(new Event("change", opts));
}

/** Un mot de passe à saisir (`current`), à créer (`new` : inscription,
 * nouveau mot de passe, confirmation), ou on ne sait pas. */
export type PasswordRole = "current" | "new" | "unknown";

export function passwordRole(i: HTMLInputElement): PasswordRole {
  const ac = (i.getAttribute("autocomplete") ?? "").toLowerCase();
  if (ac.includes("current-password")) return "current";
  if (ac.includes("new-password")) return "new";
  const hint = hintOf(i);
  if (/current|actuel|\bold\b|ancien|existing/.test(hint)) return "current";
  if (/\bnew\b|nouveau|nouvel|confirm|repeat|retype|again|re-?enter|r[ée]p[ée]t|ressaisi|v[ée]rif|second|choose|choisi|create|cr[ée]e/.test(hint)) return "new";
  return "unknown";
}

/** Les champs de mot de passe à remplir avec un identifiant existant, parmi
 * ceux d'un même formulaire : le mot de passe actuel s'il est désigné
 * (changement de mot de passe : pas le nouveau), sinon, sur un formulaire
 * d'inscription (mot de passe + confirmation), les deux — sinon le premier. */
export function passwordsToFill(passwords: HTMLInputElement[]): HTMLInputElement[] {
  if (passwords.length === 0) return [];
  const roles = passwords.map(passwordRole);
  const current = passwords.filter((_, k) => roles[k] === "current");
  if (current.length) return current.slice(0, 1);
  if (isSignup(passwords)) return passwords.slice(0, 2);
  return passwords.slice(0, 1);
}

/** Un formulaire d'inscription (ou de nouveau mot de passe) : aucun mot de
 * passe « actuel », et un « nouveau » ou deux champs (le second confirme). */
export function isSignup(passwords: HTMLInputElement[]): boolean {
  if (passwords.length === 0) return false;
  const roles = passwords.map(passwordRole);
  if (roles.includes("current")) return false;
  return roles.includes("new") || passwords.length >= 2;
}
