/** Le script de page. Deux rôles, un seul fichier (idempotent : injecté
 * deux fois, il n'écoute qu'une fois) :
 *
 * 1. **Remplir** sur ordre (popup ou raccourci) : trouve le formulaire de
 *    connexion et y pose l'utilisateur, le mot de passe ou le code TOTP.
 * 2. **Proposer** : chargé sur toutes les pages par le manifeste, il repère
 *    les champs de mot de passe visibles, demande au service worker ce qui
 *    correspond à l'URL (des noms, jamais de mot de passe), et pose un
 *    bouton GuiVault dans le champ ; le menu liste les correspondances, en
 *    choisir une demande *ses* secrets et remplit. Rien n'est ajouté à la
 *    page si le coffre est verrouillé ou n'a rien pour elle.
 *
 * L'interface injectée vit dans un shadow DOM, hors du style de la page. */
import { DEFAULT_GENERATOR, generate, type GeneratorOptions } from "../../src/lib/generator";
import type { CredentialsReply, FillReply, MatchesReply, MatchSummary, PasskeyToBackground, Pending, ToBackground, ToContent, VaultsReply } from "./messages";

declare global {
  interface Window {
    __guivaultFill?: boolean;
  }
}

(() => {
  if (window.__guivaultFill) return;
  window.__guivaultFill = true;

  // ─── Formulaire ──────────────────────────────────────────────────────────

  const visible = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };

  const inputs = () => Array.from(document.querySelectorAll<HTMLInputElement>("input")).filter((i) => !i.disabled && !i.readOnly && visible(i));

  /** Pose une valeur comme le ferait l'utilisateur : par le setter natif
   * (React garde son propre état sinon) puis les événements `input` et
   * `change`. */
  const setValue = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  /** Tout ce qui nomme un champ, pour le reconnaître : attributs, libellé
   * associé (`for`, englobant, `aria-labelledby`), texte juste avant. */
  const hintOf = (i: HTMLInputElement): string => {
    const parts: (string | null | undefined)[] = [i.name, i.id, i.autocomplete, i.placeholder, i.getAttribute("aria-label"), i.title, i.className];
    for (const id of (i.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) parts.push(document.getElementById(id)?.textContent);
    if (i.id) for (const l of Array.from(document.querySelectorAll<HTMLLabelElement>("label"))) if (l.htmlFor === i.id) parts.push(l.textContent);
    parts.push(i.closest("label")?.textContent);
    const prev = i.previousElementSibling ?? i.parentElement?.previousElementSibling;
    if (prev && prev.textContent && prev.textContent.length < 60) parts.push(prev.textContent);
    return parts.filter(Boolean).join(" ").toLowerCase().replace(/\s+/g, " ");
  };

  const USERNAME_RE = /user|usr|login|log-in|signin|sign-in|e-?mail|courriel|identif|ident\b|compte|account|pseudo|nickname|member|membre|customer|client|phone|tel|mobile|portable|matricule|\bid\b|nom d'utilisateur|adresse/;
  const NOT_USERNAME_RE = /search|recherch|captcha|otp|one-time|code|zip|postal|city|ville|street|rue|firstname|lastname|prénom|surname|card|carte|cvv|iban|coupon|promo|filter|filtre|query|\bq\b/;

  const isUsernameLike = (i: HTMLInputElement) => {
    const t = (i.type || "text").toLowerCase();
    if (!["text", "email", "tel", "number"].includes(t)) return false;
    if (i.autocomplete === "username" || i.autocomplete === "email" || t === "email") return true;
    if (i.autocomplete === "off" && t === "number") return false;
    const hint = hintOf(i);
    if (NOT_USERNAME_RE.test(hint) && !/user|login|e-?mail|identif|compte|account/.test(hint)) return false;
    return USERNAME_RE.test(hint);
  };

  /** Le champ utilisateur qui va avec un champ mot de passe : le champ texte
   * qui le précède dans le même formulaire, sinon le premier qui y
   * ressemble, sinon le champ actif. */
  const usernameFor = (password: HTMLInputElement | undefined, all: HTMLInputElement[]) => {
    const scope = password?.form ? Array.from(password.form.querySelectorAll<HTMLInputElement>("input")).filter((i) => visible(i)) : all;
    const before = password ? scope.slice(0, scope.indexOf(password)).reverse() : scope;
    return (
      before.find(isUsernameLike) ??
      before.find((i) => ["text", "email"].includes((i.type || "text").toLowerCase())) ??
      all.find(isUsernameLike) ??
      all.find((i) => i !== password && isEmailLike(i)) ??
      (document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "password" ? document.activeElement : null)
    );
  };

  const fill = (msg: { username?: string; password?: string; totp?: string }, preferred?: HTMLInputElement): FillReply => {
    const all = inputs();
    const result: FillReply = { username: false, password: false, totp: false };
    if (msg.totp) {
      const otp = all.find((i) => i.autocomplete === "one-time-code" || /otp|totp|code|2fa|mfa/.test(`${i.name} ${i.id}`.toLowerCase())) ?? (document.activeElement instanceof HTMLInputElement ? document.activeElement : null);
      if (otp) {
        setValue(otp, msg.totp);
        result.totp = true;
      }
      return result;
    }
    const password = preferred ?? all.find((i) => i.type === "password");
    if (password && msg.password) {
      setValue(password, msg.password);
      result.password = true;
    }
    if (msg.username) {
      const user = usernameFor(password, all);
      if (user) {
        setValue(user, msg.username);
        result.username = true;
      }
    }
    return result;
  };

  // ─── Proposition dans la page ────────────────────────────────────────────

  const send = <R,>(msg: ToBackground | PasskeyToBackground): Promise<R> => chrome.runtime.sendMessage<ToBackground | PasskeyToBackground, R>(msg);

  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let menu: HTMLElement | null = null;
  const anchors = new Map<HTMLInputElement, HTMLElement>();
  let matches: MatchSummary[] = [];
  let locked = false;
  let enabled = false;
  let lastUrl = "";

  const ICON = `<svg viewBox="0 0 16 16" fill="none" width="16" height="16"><rect x="1.5" y="4" width="13" height="8" rx="1.5" stroke="currentColor" stroke-width="1.25"/><circle cx="4.75" cy="8" r="0.9" fill="currentColor"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/><circle cx="11.25" cy="8" r="0.9" fill="currentColor"/></svg>`;
  const ICON_EYE = `<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.25"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.25"/></svg>`;
  const ICON_DICE = `<svg viewBox="0 0 16 16" fill="none" width="14" height="14"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/><circle cx="10.5" cy="5.5" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="5.5" cy="10.5" r="1" fill="currentColor"/><circle cx="10.5" cy="10.5" r="1" fill="currentColor"/></svg>`;

  const ensureHost = () => {
    if (shadow) return shadow;
    host = document.createElement("div");
    host.id = "guivault-inline";
    host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .btn { position: fixed; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 4px; background: #2563eb; color: #fff; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.35); font: 0/0 a; }
      .btn:hover { background: #3b82f6; }
      .menu { position: fixed; z-index: 2; min-width: 220px; max-width: 320px; background: #121215; color: #e7e7ea; border: 1px solid #26262b; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.45); font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; padding: 4px; overflow: hidden; }
      .item { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; border-radius: 6px; cursor: pointer; text-align: left; border: 0; background: none; color: inherit; width: 100%; font: inherit; }
      .item:hover, .item:focus { background: rgba(255,255,255,.08); outline: none; }
      .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .user { font-size: 11px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .foot { font-size: 10.5px; color: #71717a; padding: 4px 8px 2px; border-top: 1px solid #26262b; margin-top: 2px; }
      .veil { position: fixed; z-index: 4; inset: 0; background: rgba(0,0,0,.45); }
      .dialog { position: fixed; z-index: 4; left: 50%; top: 18%; transform: translateX(-50%); width: min(360px, calc(100vw - 32px)); background: #121215; color: #e7e7ea; border: 1px solid #26262b; border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.55); font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; padding: 14px; }
      .dialog h2 { margin: 0 0 6px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
      .dialog p { margin: 0 0 10px; color: #a1a1aa; line-height: 1.45; }
      .dialog select { width: 100%; box-sizing: border-box; margin: 0 0 10px; padding: 6px 8px; border-radius: 6px; border: 1px solid #26262b; background: rgba(0,0,0,.25); color: inherit; font: inherit; }
      .row { display: flex; justify-content: flex-end; gap: 6px; }
      .b { padding: 6px 10px; border-radius: 6px; border: 1px solid transparent; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
      .b-primary { background: #2563eb; color: #fff; }
      .b-ghost { background: none; color: #a1a1aa; }
      .b-ghost:hover { color: #e7e7ea; background: rgba(255,255,255,.06); }
      .f { display: block; margin: 0 0 8px; }
      .f > span:first-child { display: block; font-size: 11.5px; color: #a1a1aa; margin-bottom: 3px; }
      .i { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid #26262b; background: rgba(0,0,0,.25); color: #e7e7ea; font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
      .i:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.18); }
      .pw { display: flex; gap: 4px; align-items: center; }
      .pw .b { padding: 4px 6px; display: inline-flex; align-items: center; }
      .err { color: #ef4444; font-size: 12px; margin: 0 0 8px; }
      .gen { border: 1px solid #26262b; border-radius: 8px; padding: 8px; margin: -2px 0 10px; background: rgba(0,0,0,.15); }
      .gen-out { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .gen-value { flex: 1; min-width: 0; font: 13px ui-monospace, "JetBrains Mono", Consolas, monospace; word-break: break-all; color: #e7e7ea; }
      .seg { display: inline-flex; border: 1px solid #26262b; border-radius: 6px; padding: 2px; margin-bottom: 8px; background: #0c0c0e; }
      .seg button { border: 0; background: none; color: #71717a; font: inherit; font-size: 12px; padding: 3px 8px; border-radius: 4px; cursor: pointer; }
      .seg button[data-active="true"] { background: #19191d; color: #e7e7ea; }
      .checks { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: #e7e7ea; }
      .checks label { display: inline-flex; align-items: center; gap: 4px; }
      .checks .sep { width: 3em; padding: 2px 4px; }
      input[type=range] { width: 100%; accent-color: #2563eb; }
      .logo { display: inline-flex; width: 18px; height: 18px; border-radius: 4px; background: #2563eb; color: #fff; align-items: center; justify-content: center; flex-shrink: 0; }
      .banner { position: fixed; z-index: 3; top: 12px; right: 12px; display: grid; grid-template-columns: auto 1fr; gap: 8px 10px; align-items: center; width: min(420px, calc(100vw - 24px)); box-sizing: border-box; background: #121215; color: #e7e7ea; border: 1px solid #26262b; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; padding: 10px 12px; line-height: 1.4; }
      .banner .text { min-width: 0; }
      .banner .actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; align-items: center; gap: 6px; flex-wrap: wrap; }
      .banner select { padding: 4px 6px; border-radius: 6px; border: 1px solid #26262b; background: rgba(0,0,0,.25); color: inherit; font: inherit; font-size: 12px; max-width: 140px; }
    `;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
    return shadow;
  };

  const place = (input: HTMLInputElement, btn: HTMLElement) => {
    if (!input.isConnected || !visible(input)) {
      btn.style.display = "none";
      return;
    }
    const r = input.getBoundingClientRect();
    btn.style.display = "flex";
    btn.style.left = `${Math.round(r.right - 24)}px`;
    btn.style.top = `${Math.round(r.top + (r.height - 20) / 2)}px`;
  };

  const closeMenu = () => {
    menu?.remove();
    menu = null;
  };

  const choose = async (m: MatchSummary, input: HTMLInputElement) => {
    closeMenu();
    const c = await send<CredentialsReply>({ type: "guivault-credentials", id: m.id });
    if (!c) return;
    const password = input.type === "password" ? input : (input.form ? Array.from(input.form.querySelectorAll<HTMLInputElement>("input[type=password]")).find(visible) : undefined) ?? inputs().find((i) => i.type === "password");
    fill({ username: c.username, password: c.password }, password);
  };

  const openMenu = (input: HTMLInputElement, btn: HTMLElement) => {
    closeMenu();
    const root = ensureHost();
    menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "menu");
    for (const m of matches) {
      const b = document.createElement("button");
      b.className = "item";
      b.setAttribute("role", "menuitem");
      b.innerHTML = `<span class="name"></span><span class="user"></span>`;
      (b.firstChild as HTMLElement).textContent = `${m.favorite ? "★ " : ""}${m.name}`;
      (b.lastChild as HTMLElement).textContent = m.username || "—";
      b.addEventListener("click", () => void choose(m, input));
      menu.appendChild(b);
    }
    const add = document.createElement("button");
    add.className = "item";
    add.setAttribute("role", "menuitem");
    add.innerHTML = `<span class="name"></span><span class="user"></span>`;
    (add.firstChild as HTMLElement).textContent = matches.length ? "+ Nouvel identifiant…" : `+ Enregistrer un identifiant pour ${location.hostname.replace(/^www\./, "")}…`;
    (add.lastChild as HTMLElement).textContent = matches.length ? "" : "Aucun identifiant GuiVault pour ce site";
    add.addEventListener("click", () => { closeMenu(); void newLoginDialog(input); });
    menu.appendChild(add);
    const foot = document.createElement("div");
    foot.className = "foot";
    foot.textContent = "GuiVault — Ctrl+Maj+L pour remplir";
    menu.appendChild(foot);
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(window.innerWidth - 330, r.right - 240))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    root.appendChild(menu);
    (menu.querySelector("button") as HTMLElement | null)?.focus();
  };

  const isEmailLike = (i: HTMLInputElement) => (i.type || "text").toLowerCase() === "email" || i.autocomplete === "email" || /e-?mail|courriel/.test(hintOf(i));

  /** Le champ qui porte le bouton : l'utilisateur quand on le trouve (c'est
   * le premier qu'on remplit), sinon un champ e-mail n'importe où dans la
   * page, sinon le mot de passe lui-même. */
  const anchorFor = (password: HTMLInputElement, all: HTMLInputElement[]) => usernameFor(password, all) ?? all.find((i) => i !== password && isEmailLike(i)) ?? password;

  /** Ce que fait le bouton : verrouillé → le dire ; rien pour ce site →
   * créer ; un compte → remplir ; plusieurs → menu. */
  const onButton = (input: HTMLInputElement, btn: HTMLElement) => {
    if (menu) return closeMenu();
    if (locked) return void dialog("GuiVault est verrouillé", "Cliquez sur l'icône GuiVault dans la barre du navigateur pour vous reconnecter, puis revenez ici.", null, "OK", true);
    if (matches.length === 1) return void choose(matches[0], input);
    openMenu(input, btn);
  };

  const attach = (input: HTMLInputElement) => {
    if (anchors.has(input)) return;
    const root = ensureHost();
    const btn = document.createElement("div");
    btn.className = "btn";
    btn.title = matches.length ? "Remplir avec GuiVault" : "Enregistrer dans GuiVault";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "GuiVault");
    btn.innerHTML = ICON;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => onButton(input, btn));
    root.appendChild(btn);
    anchors.set(input, btn);
    place(input, btn);
  };

  const detach = (input: HTMLInputElement) => {
    anchors.get(input)?.remove();
    anchors.delete(input);
  };

  let scheduled = false;
  const reposition = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      for (const [input, btn] of anchors) place(input, btn);
      if (menu) closeMenu();
    });
  };

  /** Les champs qui portent un bouton : pour chaque mot de passe, son
   * utilisateur (ou lui-même) ; et, sans mot de passe visible (connexion en
   * deux étapes), les champs qui ressemblent à un utilisateur. */
  const anchorsWanted = (all: HTMLInputElement[]): HTMLInputElement[] => {
    const passwords = all.filter((i) => i.type === "password");
    if (passwords.length) return Array.from(new Set(passwords.map((p) => anchorFor(p, all))));
    return all.filter(isUsernameLike).slice(0, 3);
  };

  let reportedForm: boolean | null = null;

  /** Repère les champs et pose (ou retire) les boutons ; dit au worker si
   * la page a un formulaire (pour le badge). */
  const scan = async () => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      const r = await send<MatchesReply>({ type: "guivault-matches", url }).catch(() => null);
      locked = !!r?.locked;
      enabled = !!r && (r.locked || r.enabled);
      matches = r && !r.locked ? r.logins : [];
      for (const [, btn] of anchors) btn.title = matches.length ? "Remplir avec GuiVault" : "Enregistrer dans GuiVault";
    }
    const all = inputs();
    const fields = enabled ? anchorsWanted(all) : [];
    for (const input of Array.from(anchors.keys())) if (!fields.includes(input)) detach(input);
    for (const input of fields) attach(input);
    const present = all.some((i) => i.type === "password") || fields.length > 0;
    if (present !== reportedForm && window === window.top) {
      reportedForm = present;
      void send({ type: "guivault-form", present }).catch(() => null);
    }
  };

  let scanTimer: number | undefined;
  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => void scan(), 250);
  };

  // Verrouillage, déverrouillage, nouvel item : le service worker n'a pas de
  // canal vers la page, mais la prochaine URL ou mutation relance la
  // question ; `storage` n'est pas accessible d'ici sans permission, d'où
  // un rafraîchissement périodique léger.
  const start = () => {
    void scan();
    if (window === window.top) askPending();
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "style", "class", "hidden"] });
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); }, true);
    document.addEventListener("mousedown", (e) => { if (menu && e.target !== host) closeMenu(); }, true);
    setInterval(() => { lastUrl = ""; scheduleScan(); }, 15000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // ─── Enregistrer ce qu'on vient de saisir ────────────────────────────────
  //
  // À la soumission d'un formulaire avec un mot de passe, on envoie le
  // couple au service worker ; la page qui suit (souvent une autre, après
  // navigation) demande s'il y a quelque chose à proposer et affiche la
  // bannière. Le mot de passe ne repasse jamais par la page : la bannière
  // ne montre que l'utilisateur.

  const capture = (form: HTMLFormElement | null, trigger: HTMLInputElement | null) => {
    const scope = form ? Array.from(form.querySelectorAll<HTMLInputElement>("input")).filter(visible) : inputs();
    const password = (trigger?.type === "password" ? trigger : undefined) ?? scope.find((i) => i.type === "password" && i.value);
    if (!password?.value) return;
    const user = usernameFor(password, scope);
    void send<{ ok: boolean } | null>({ type: "guivault-captured", username: user?.value.trim() ?? "", password: password.value }).catch(() => null);
  };

  document.addEventListener("submit", (e) => capture(e.target instanceof HTMLFormElement ? e.target : null, null), true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type === "password") capture(e.target.form, e.target);
  }, true);
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target.closest("button, input[type=submit], [role=button]") : null;
    if (!t) return;
    const form = t.closest("form");
    const password = (form ? Array.from(form.querySelectorAll<HTMLInputElement>("input[type=password]")) : inputs().filter((i) => i.type === "password")).find((i) => visible(i) && i.value);
    if (password) capture(form, password);
  }, true);

  let banner: HTMLElement | null = null;
  const showBanner = (p: Pending) => {
    if (banner) return;
    const root = ensureHost();
    banner = document.createElement("div");
    banner.className = "banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Enregistrer dans GuiVault");
    const text = p.mode === "update" ? `Mettre à jour le mot de passe de « ${p.loginName} » ?` : `Enregistrer l'identifiant${p.username ? ` « ${p.username} »` : ""} pour ${p.host} ?`;
    banner.innerHTML = `<span class="logo">${ICON}</span><span class="text"></span>`;
    (banner.querySelector(".text") as HTMLElement).textContent = text;
    let select: HTMLSelectElement | null = null;
    if (p.mode === "new" && p.vaults.length > 1) {
      select = document.createElement("select");
      select.setAttribute("aria-label", "Vault");
      for (const v of p.vaults) {
        const o = document.createElement("option");
        o.value = v.id;
        o.textContent = v.name;
        o.selected = v.id === p.defaultVaultId;
        select.appendChild(o);
      }
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    if (select) actions.appendChild(select);
    const later = document.createElement("button");
    later.className = "b b-ghost";
    later.textContent = "Pas maintenant";
    const save = document.createElement("button");
    save.className = "b b-primary";
    save.textContent = p.mode === "update" ? "Mettre à jour" : "Enregistrer";
    actions.append(later, save);
    banner.appendChild(actions);
    const close = () => { banner?.remove(); banner = null; };
    later.addEventListener("click", () => { void send({ type: "guivault-dismiss-captured" }); close(); });
    save.addEventListener("click", () => {
      save.disabled = true;
      void send<{ ok: true; name: string } | { ok: false; error: string }>({ type: "guivault-save-captured", vaultId: select?.value ?? p.defaultVaultId }).then((r) => {
        (banner?.querySelector(".text") as HTMLElement | null)?.replaceChildren(document.createTextNode(r.ok ? `« ${r.name} » enregistré dans GuiVault.` : `Échec : ${r.error}`));
        select?.remove();
        save.remove();
        later.textContent = "Fermer";
        if (r.ok) setTimeout(close, 4000);
      });
    });
    root.appendChild(banner);
  };

  const askPending = () => void send<Pending | null>({ type: "guivault-pending" }).then((p) => { if (p) showBanner(p); }).catch(() => null);

  // ─── Passkeys : le pont entre la page et le service worker ───────────────
  //
  // Le shim (`webauthn.ts`, monde de la page) envoie la demande par
  // `postMessage` ; ici on demande confirmation dans une boîte injectée,
  // puis on fait signer le worker et on rend la réponse au shim. La page ne
  // voit jamais une clé, seulement l'assertion ou l'attestation.

  interface Choice { value: string; label: string; sub: string }

  /** Une boîte de dialogue dans le shadow DOM : titre, texte, choix
   * (facultatif), Continuer / Utiliser le navigateur. */
  const dialog = (title: string, text: string, choices: Choice[] | null, primary: string, okOnly = false): Promise<string | null> =>
    new Promise((resolve) => {
      const root = ensureHost();
      const veil = document.createElement("div");
      veil.className = "veil";
      const box = document.createElement("div");
      box.className = "dialog";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.innerHTML = `<h2><span class="logo">${ICON}</span><span></span></h2><p></p>`;
      (box.querySelector("h2 span:last-child") as HTMLElement).textContent = title;
      (box.querySelector("p") as HTMLElement).textContent = text;
      let select: HTMLSelectElement | null = null;
      if (choices) {
        select = document.createElement("select");
        select.setAttribute("aria-label", "Identifiant");
        for (const c of choices) {
          const o = document.createElement("option");
          o.value = c.value;
          o.textContent = c.sub ? `${c.label} — ${c.sub}` : c.label;
          select.appendChild(o);
        }
        box.appendChild(select);
      }
      const row = document.createElement("div");
      row.className = "row";
      const cancel = document.createElement("button");
      cancel.className = "b b-ghost";
      cancel.textContent = "Utiliser le navigateur";
      const ok = document.createElement("button");
      ok.className = "b b-primary";
      ok.textContent = primary;
      if (!okOnly) row.append(cancel);
      row.append(ok);
      box.appendChild(row);
      const done = (v: string | null) => {
        veil.remove();
        box.remove();
        resolve(v);
      };
      cancel.addEventListener("click", () => done(null));
      ok.addEventListener("click", () => done(select ? select.value : ""));
      box.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
      root.append(veil, box);
      ok.focus();
    });

  /** Créer un identifiant depuis la page : nom et site préremplis,
   * utilisateur repris du champ, mot de passe tapé ou généré ; enregistré
   * dans le vault choisi puis rempli dans le formulaire. */
  const newLoginDialog = async (input: HTMLInputElement) => {
    const v = await send<VaultsReply>({ type: "guivault-vaults" }).catch(() => null);
    if (!v || v.locked) return void dialog("GuiVault est verrouillé", "Cliquez sur l'icône GuiVault dans la barre du navigateur pour vous reconnecter.", null, "OK", true);
    const all = inputs();
    const password = input.type === "password" ? input : (input.form ? Array.from(input.form.querySelectorAll<HTMLInputElement>("input[type=password]")).find(visible) : undefined) ?? all.find((i) => i.type === "password");
    const user = input.type === "password" ? usernameFor(input, all) : input;
    const root = ensureHost();
    const veil = document.createElement("div");
    veil.className = "veil";
    const box = document.createElement("div");
    box.className = "dialog";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML = `
      <h2><span class="logo">${ICON}</span><span>Nouvel identifiant</span></h2>
      <label class="f"><span>Nom</span><input class="i" name="name"></label>
      <label class="f"><span>Utilisateur</span><input class="i" name="username" autocomplete="off"></label>
      <label class="f"><span>Mot de passe</span><span class="pw"><input class="i" name="password" type="password" autocomplete="off"><button type="button" class="b b-ghost" data-act="show" title="Afficher" aria-label="Afficher">${ICON_EYE}</button><button type="button" class="b b-ghost" data-act="gen" title="Générer" aria-label="Générer">${ICON_DICE}</button></span></label>
      <div class="gen" hidden>
        <div class="gen-out"><output class="gen-value"></output><button type="button" class="b b-ghost" data-act="regen" title="Regénérer" aria-label="Regénérer">${ICON_DICE}</button><button type="button" class="b b-primary" data-act="use">Utiliser</button></div>
        <div class="seg"><button type="button" data-mode="password">Mot de passe</button><button type="button" data-mode="passphrase">Phrase de passe</button></div>
        <div class="gen-pw">
          <label class="f"><span>Longueur : <b data-len></b></span><input type="range" min="8" max="64" name="length"></label>
          <div class="checks">
            <label><input type="checkbox" name="lowercase"> a-z</label>
            <label><input type="checkbox" name="uppercase"> A-Z</label>
            <label><input type="checkbox" name="digits"> 0-9</label>
            <label><input type="checkbox" name="symbols"> !@#</label>
            <label><input type="checkbox" name="avoidAmbiguous"> sans ambigus</label>
          </div>
        </div>
        <div class="gen-pp" hidden>
          <label class="f"><span>Mots : <b data-words></b></span><input type="range" min="3" max="12" name="words"></label>
          <div class="checks">
            <label>Séparateur <input class="i sep" name="separator" maxlength="3"></label>
            <label><input type="checkbox" name="capitalize"> Majuscule</label>
            <label><input type="checkbox" name="includeNumber"> Chiffre</label>
          </div>
        </div>
      </div>
      <label class="f"><span>Site</span><input class="i" name="uri"></label>
      <label class="f vault"><span>Vault</span><select class="i" name="vault"></select></label>
      <p class="err" hidden></p>
      <div class="row"><button type="button" class="b b-ghost" data-act="cancel">Annuler</button><button type="button" class="b b-primary" data-act="save">Enregistrer</button></div>`;
    const q = <T extends HTMLElement>(sel: string) => box.querySelector(sel) as T;
    q<HTMLInputElement>("[name=name]").value = location.hostname.replace(/^www\./, "");
    q<HTMLInputElement>("[name=username]").value = user?.value ?? "";
    q<HTMLInputElement>("[name=password]").value = password?.value ?? "";
    q<HTMLInputElement>("[name=uri]").value = location.origin;
    const select = q<HTMLSelectElement>("[name=vault]");
    for (const vt of v.vaults) {
      const o = document.createElement("option");
      o.value = vt.id;
      o.textContent = vt.name;
      o.selected = vt.id === v.defaultVaultId;
      select.appendChild(o);
    }
    if (v.vaults.length <= 1) q(".vault").hidden = true;
    const close = () => { veil.remove(); box.remove(); };
    q("[data-act=cancel]").addEventListener("click", close);
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    q("[data-act=show]").addEventListener("click", () => { const p = q<HTMLInputElement>("[name=password]"); p.type = p.type === "password" ? "text" : "password"; });
    // Le générateur, avec ses réglages (les mêmes que le popup) : replié
    // derrière le dé, il produit une valeur à chaque changement.
    const gen = q<HTMLElement>(".gen");
    let opts: GeneratorOptions = DEFAULT_GENERATOR;
    const genValue = q<HTMLOutputElement>(".gen-value");
    const render = () => {
      q(".gen-pw").hidden = opts.mode !== "password";
      q(".gen-pp").hidden = opts.mode !== "passphrase";
      for (const b of Array.from(gen.querySelectorAll<HTMLButtonElement>("[data-mode]"))) b.dataset.active = String(b.dataset.mode === opts.mode);
      const pw = opts.password;
      const pp = opts.passphrase;
      q<HTMLInputElement>("[name=length]").value = String(pw.length);
      q("[data-len]").textContent = String(pw.length);
      for (const k of ["lowercase", "uppercase", "digits", "symbols", "avoidAmbiguous"] as const) q<HTMLInputElement>(`[name=${k}]`).checked = pw[k];
      q<HTMLInputElement>("[name=words]").value = String(pp.words);
      q("[data-words]").textContent = String(pp.words);
      q<HTMLInputElement>("[name=separator]").value = pp.separator;
      q<HTMLInputElement>("[name=capitalize]").checked = pp.capitalize;
      q<HTMLInputElement>("[name=includeNumber]").checked = pp.includeNumber;
      genValue.textContent = generate(opts);
    };
    const update = (patch: Partial<GeneratorOptions["password"]> | Partial<GeneratorOptions["passphrase"]> | { mode: GeneratorOptions["mode"] }) => {
      if ("mode" in patch && patch.mode) opts = { ...opts, mode: patch.mode };
      else if (opts.mode === "password") opts = { ...opts, password: { ...opts.password, ...(patch as Partial<GeneratorOptions["password"]>) } };
      else opts = { ...opts, passphrase: { ...opts.passphrase, ...(patch as Partial<GeneratorOptions["passphrase"]>) } };
      render();
      void send({ type: "guivault-generator-options-set", options: opts }).catch(() => null);
    };
    for (const b of Array.from(gen.querySelectorAll<HTMLButtonElement>("[data-mode]"))) b.addEventListener("click", () => update({ mode: b.dataset.mode as GeneratorOptions["mode"] }));
    q("[name=length]").addEventListener("input", (e) => update({ length: Number((e.target as HTMLInputElement).value) }));
    for (const k of ["lowercase", "uppercase", "digits", "symbols", "avoidAmbiguous"] as const) q(`[name=${k}]`).addEventListener("change", (e) => update({ [k]: (e.target as HTMLInputElement).checked }));
    q("[name=words]").addEventListener("input", (e) => update({ words: Number((e.target as HTMLInputElement).value) }));
    q("[name=separator]").addEventListener("input", (e) => update({ separator: (e.target as HTMLInputElement).value }));
    q("[name=capitalize]").addEventListener("change", (e) => update({ capitalize: (e.target as HTMLInputElement).checked }));
    q("[name=includeNumber]").addEventListener("change", (e) => update({ includeNumber: (e.target as HTMLInputElement).checked }));
    q("[data-act=regen]").addEventListener("click", () => { genValue.textContent = generate(opts); });
    q("[data-act=use]").addEventListener("click", () => { const p = q<HTMLInputElement>("[name=password]"); p.value = genValue.textContent ?? ""; p.type = "text"; gen.hidden = true; });
    q("[data-act=gen]").addEventListener("click", () => {
      if (!gen.hidden) { gen.hidden = true; return; }
      void send<{ options: GeneratorOptions }>({ type: "guivault-generator-options" }).catch(() => null).then((r) => {
        if (r?.options) opts = { ...DEFAULT_GENERATOR, ...r.options, password: { ...DEFAULT_GENERATOR.password, ...r.options.password }, passphrase: { ...DEFAULT_GENERATOR.passphrase, ...r.options.passphrase } };
        render();
        gen.hidden = false;
      });
    });
    q("[data-act=save]").addEventListener("click", () => {
      const body = { type: "guivault-create-login" as const, vaultId: select.value, name: q<HTMLInputElement>("[name=name]").value, username: q<HTMLInputElement>("[name=username]").value, password: q<HTMLInputElement>("[name=password]").value, uri: q<HTMLInputElement>("[name=uri]").value };
      if (!body.password) { const err = q(".err"); err.textContent = "Il faut un mot de passe (tapez-le ou générez-le)."; err.hidden = false; return; }
      (q("[data-act=save]") as HTMLButtonElement).disabled = true;
      void send<{ ok: true; name: string } | { ok: false; error: string }>(body).then((r) => {
        if (!r.ok) { const err = q(".err"); err.textContent = r.error; err.hidden = false; (q("[data-act=save]") as HTMLButtonElement).disabled = false; return; }
        close();
        fill({ username: body.username, password: body.password }, password);
        lastUrl = "";
        scheduleScan();
      });
    });
    root.append(veil, box);
    q<HTMLInputElement>(password?.value ? "[name=name]" : "[name=password]").focus();
  };

  const replyShim = (id: number, body: Record<string, unknown>) => window.postMessage({ __guivault: "webauthn-reply", id, ...body }, "*");

  window.addEventListener("message", (e) => {
    const d = e.data as { __guivault?: string; id: number; kind: "get" | "create"; request: Record<string, unknown> } | undefined;
    if (e.source !== window || !d || d.__guivault !== "webauthn") return;
    void (async () => {
      try {
        if (d.kind === "get") {
          const req = d.request as { rpId: string; challenge: string; allowCredentials: string[] };
          const r = await send<{ candidates: { loginId: string; loginName: string; credentialId: string; userName: string }[] | null; error?: string }>({ type: "guivault-passkey-candidates", rpId: req.rpId, allow: req.allowCredentials });
          if (r.error || !r.candidates || r.candidates.length === 0) return replyShim(d.id, { fallback: true });
          const choices = r.candidates.map((c) => ({ value: c.credentialId, label: c.loginName, sub: c.userName }));
          const picked = await dialog(`Se connecter à ${req.rpId}`, r.candidates.length === 1 ? `Avec la passkey de « ${choices[0].label} »${choices[0].sub ? ` (${choices[0].sub})` : ""} enregistrée dans GuiVault.` : "Plusieurs passkeys GuiVault correspondent à ce site.", r.candidates.length === 1 ? null : choices, "Continuer");
          if (picked === null) return replyShim(d.id, { fallback: true });
          const a = await send<{ assertion: Record<string, string> | null; error?: string }>({ type: "guivault-passkey-assert", credentialId: picked || choices[0].value, rpId: req.rpId, challenge: req.challenge });
          if (!a.assertion) return replyShim(d.id, { error: a.error ?? "passkey indisponible" });
          return replyShim(d.id, { result: a.assertion });
        }
        const req = d.request as { rpId: string; rpName: string; userHandle: string; userName: string; userDisplayName: string; challenge: string; excludeCredentials: string[]; discoverable: boolean };
        const l = await send<{ logins: { id: string; name: string; username: string }[] | null; error?: string }>({ type: "guivault-passkey-logins", rpId: req.rpId });
        if (l.error || !l.logins) return replyShim(d.id, { fallback: true });
        const choices: Choice[] = [...l.logins.map((x) => ({ value: x.id, label: x.name, sub: x.username })), { value: "", label: `Nouvel identifiant « ${req.rpName || req.rpId} »`, sub: req.userName }];
        const picked = await dialog(`Enregistrer une passkey pour ${req.rpName || req.rpId}`, `Pour ${req.userDisplayName || req.userName}. Elle sera chiffrée dans votre coffre et synchronisée.`, choices, "Enregistrer");
        if (picked === null) return replyShim(d.id, { fallback: true });
        const a = await send<{ attestation: Record<string, string> | { error: string }; error?: string }>({ type: "guivault-passkey-register", rpId: req.rpId, rpName: req.rpName, userHandle: req.userHandle, userName: req.userName, userDisplayName: req.userDisplayName, challenge: req.challenge, loginId: picked || null, discoverable: req.discoverable });
        if (a.error || !a.attestation || "error" in a.attestation) return replyShim(d.id, { error: a.error ?? (a.attestation as { error: string })?.error ?? "enregistrement impossible" });
        return replyShim(d.id, { result: a.attestation });
      } catch (err) {
        replyShim(d.id, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  // ─── Ordres du popup et du raccourci ─────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg: ToContent, _sender, reply: (r: FillReply) => void) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "guivault-fill") {
      reply(fill(msg));
      return;
    }
    if (msg.type === "guivault-pick") {
      const [input] = Array.from(anchors.keys());
      const btn = input && anchors.get(input);
      if (input && btn) openMenu(input, btn);
      reply({ username: false, password: false, totp: false });
    }
  });
})();

export {};
