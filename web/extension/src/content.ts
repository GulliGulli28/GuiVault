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
import type { CredentialsReply, FillReply, MatchesReply, MatchSummary, PasskeyToBackground, ToBackground, ToContent } from "./messages";

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

  const isUsernameLike = (i: HTMLInputElement) => {
    const t = (i.type || "text").toLowerCase();
    if (!["text", "email", "tel"].includes(t)) return false;
    const hint = `${i.name} ${i.id} ${i.autocomplete} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`.toLowerCase();
    return /user|login|email|mail|identif|compte|account|name|pseudo|phone|tel/.test(hint) || i.autocomplete === "username";
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
  let lastUrl = "";

  const ICON = `<svg viewBox="0 0 16 16" fill="none" width="16" height="16"><rect x="1.5" y="4" width="13" height="8" rx="1.5" stroke="currentColor" stroke-width="1.25"/><circle cx="4.75" cy="8" r="0.9" fill="currentColor"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/><circle cx="11.25" cy="8" r="0.9" fill="currentColor"/></svg>`;

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
      .menu { position: fixed; min-width: 220px; max-width: 320px; background: #121215; color: #e7e7ea; border: 1px solid #26262b; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.45); font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; padding: 4px; overflow: hidden; }
      .item { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; border-radius: 6px; cursor: pointer; text-align: left; border: 0; background: none; color: inherit; width: 100%; font: inherit; }
      .item:hover, .item:focus { background: rgba(255,255,255,.08); outline: none; }
      .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .user { font-size: 11px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .foot { font-size: 10.5px; color: #71717a; padding: 4px 8px 2px; border-top: 1px solid #26262b; margin-top: 2px; }
      .veil { position: fixed; inset: 0; background: rgba(0,0,0,.45); }
      .dialog { position: fixed; left: 50%; top: 18%; transform: translateX(-50%); width: min(360px, calc(100vw - 32px)); background: #121215; color: #e7e7ea; border: 1px solid #26262b; border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.55); font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; padding: 14px; }
      .dialog h2 { margin: 0 0 6px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
      .dialog p { margin: 0 0 10px; color: #a1a1aa; line-height: 1.45; }
      .dialog select { width: 100%; box-sizing: border-box; margin: 0 0 10px; padding: 6px 8px; border-radius: 6px; border: 1px solid #26262b; background: rgba(0,0,0,.25); color: inherit; font: inherit; }
      .row { display: flex; justify-content: flex-end; gap: 6px; }
      .b { padding: 6px 10px; border-radius: 6px; border: 1px solid transparent; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
      .b-primary { background: #2563eb; color: #fff; }
      .b-ghost { background: none; color: #a1a1aa; }
      .b-ghost:hover { color: #e7e7ea; background: rgba(255,255,255,.06); }
      .logo { display: inline-flex; width: 18px; height: 18px; border-radius: 4px; background: #2563eb; color: #fff; align-items: center; justify-content: center; }
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
    fill({ username: c.username, password: c.password }, input);
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

  const attach = (input: HTMLInputElement) => {
    if (anchors.has(input)) return;
    const root = ensureHost();
    const btn = document.createElement("div");
    btn.className = "btn";
    btn.title = "Remplir avec GuiVault";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Remplir avec GuiVault");
    btn.innerHTML = ICON;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => (menu ? closeMenu() : matches.length === 1 ? void choose(matches[0], input) : openMenu(input, btn)));
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

  /** Repère les champs de mot de passe et pose (ou retire) les boutons. */
  const scan = async () => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      const r = await send<MatchesReply>({ type: "guivault-matches", url }).catch(() => null);
      matches = r && !r.locked && r.enabled ? r.logins : [];
    }
    const fields = matches.length ? inputs().filter((i) => i.type === "password") : [];
    for (const input of Array.from(anchors.keys())) if (!fields.includes(input)) detach(input);
    for (const input of fields) attach(input);
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
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "style", "class", "hidden"] });
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); }, true);
    document.addEventListener("mousedown", (e) => { if (menu && e.target !== host) closeMenu(); }, true);
    setInterval(() => { lastUrl = ""; scheduleScan(); }, 15000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // ─── Passkeys : le pont entre la page et le service worker ───────────────
  //
  // Le shim (`webauthn.ts`, monde de la page) envoie la demande par
  // `postMessage` ; ici on demande confirmation dans une boîte injectée,
  // puis on fait signer le worker et on rend la réponse au shim. La page ne
  // voit jamais une clé, seulement l'assertion ou l'attestation.

  interface Choice { value: string; label: string; sub: string }

  /** Une boîte de dialogue dans le shadow DOM : titre, texte, choix
   * (facultatif), Continuer / Utiliser le navigateur. */
  const dialog = (title: string, text: string, choices: Choice[] | null, primary: string): Promise<string | null> =>
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
      row.append(cancel, ok);
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
