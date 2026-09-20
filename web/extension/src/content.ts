/** Injecté à la demande dans l'onglet actif (`activeTab` + `scripting`) quand
 * on clique « Remplir » : trouve le formulaire de connexion et y pose
 * l'utilisateur et le mot de passe. Jamais chargé sur une page sans ce
 * geste. Idempotent : injecté deux fois, il n'écoute qu'une fois. */

interface FillMessage {
  type: "guivault-fill";
  username?: string;
  password?: string;
  totp?: string;
}

declare global {
  interface Window {
    __guivaultFill?: boolean;
  }
}

(() => {
  if (window.__guivaultFill) return;
  window.__guivaultFill = true;

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
    return /user|login|email|mail|identif|compte|account|name|login|pseudo|phone|tel/.test(hint) || i.autocomplete === "username";
  };

  const fill = (msg: FillMessage) => {
    const all = inputs();
    const result = { username: false, password: false, totp: false };
    if (msg.totp) {
      const otp = all.find((i) => i.autocomplete === "one-time-code" || /otp|totp|code|2fa|mfa/.test(`${i.name} ${i.id}`.toLowerCase())) ?? (document.activeElement instanceof HTMLInputElement ? document.activeElement : null);
      if (otp) {
        setValue(otp, msg.totp);
        result.totp = true;
      }
      return result;
    }
    const password = all.find((i) => i.type === "password");
    if (password && msg.password) {
      setValue(password, msg.password);
      result.password = true;
    }
    if (msg.username) {
      // L'utilisateur : le champ texte qui précède le mot de passe dans le
      // même formulaire, sinon le premier champ qui y ressemble, sinon le
      // champ actif.
      const scope = password?.form ? Array.from(password.form.querySelectorAll<HTMLInputElement>("input")).filter((i) => visible(i)) : all;
      const before = password ? scope.slice(0, scope.indexOf(password)).reverse() : scope;
      const user = before.find(isUsernameLike) ?? before.find((i) => ["text", "email"].includes((i.type || "text").toLowerCase())) ?? all.find(isUsernameLike) ?? (document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "password" ? document.activeElement : null);
      if (user) {
        setValue(user, msg.username);
        result.username = true;
      }
    }
    return result;
  };

  chrome.runtime.onMessage.addListener((msg: FillMessage, _sender, reply) => {
    if (msg?.type !== "guivault-fill") return;
    reply(fill(msg));
  });
})();

export {};
