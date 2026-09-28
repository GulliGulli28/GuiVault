// Outils des pages du corpus. Chaque page range ses champs dans
// `window.__fields` — y compris ceux des shadow roots fermées, dont elle
// garde la référence : le test les retrouve (position, valeur) là où ni lui
// ni une page tierce ne pourraient les chercher. `window.__state` est ce
// qu'un framework aurait retenu des saisies.
window.__fields = {};
window.__state = {};
window.field = (name, el) => {
  window.__fields[name] = el;
  return el;
};

// <login-card mode="open|closed" delay="ms"> : un formulaire de connexion
// entier dans sa shadow root ; l'état suit les événements `input` écoutés
// dans la racine, comme un composant Lit ou Stencil.
class LoginCard extends HTMLElement {
  connectedCallback() {
    if (this._done) return;
    this._done = true;
    const build = () => {
      const root = this.attachShadow({ mode: this.getAttribute("mode") || "open" });
      root.innerHTML = `<form>
        <label>Adresse e-mail <input name="u" type="text"></label>
        <label>Mot de passe <input name="p" type="password"></label>
        <button type="submit">Se connecter</button>
      </form>`;
      field("username", root.querySelector("[name=u]"));
      field("password", root.querySelector("[name=p]"));
      root.addEventListener("input", (e) => {
        const t = e.composedPath()[0];
        window.__state[t.name === "u" ? "username" : "password"] = t.value;
      });
      root.querySelector("form").addEventListener("submit", (e) => e.preventDefault());
    };
    const delay = Number(this.getAttribute("delay") || 0);
    if (delay) setTimeout(build, delay);
    else build();
  }
}
customElements.define("login-card", LoginCard);

// <gv-field label="…" type="text|password" name="…"> : un seul champ, nu,
// dans une racine **fermée** (son libellé est un attribut de l'hôte). Il
// annonce sa valeur par un événement `composed`, comme un design system.
class GvField extends HTMLElement {
  connectedCallback() {
    if (this._done) return;
    this._done = true;
    const root = this.attachShadow({ mode: "closed" });
    const input = document.createElement("input");
    input.type = this.getAttribute("type") || "text";
    root.appendChild(input);
    field(this.getAttribute("name"), input);
    input.addEventListener("input", () => this.dispatchEvent(new CustomEvent("field-input", { bubbles: true, composed: true, detail: { name: this.getAttribute("name"), value: input.value } })));
  }
}
customElements.define("gv-field", GvField);

// <login-form> : une racine ouverte qui contient deux <gv-field> fermés.
class LoginForm extends HTMLElement {
  connectedCallback() {
    if (this._done) return;
    this._done = true;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<div class="card">
      <gv-field name="username" label="Identifiant"></gv-field>
      <gv-field name="password" type="password" label="Mot de passe"></gv-field>
      <button>Connexion</button>
    </div>`;
    root.addEventListener("field-input", (e) => { window.__state[e.detail.name] = e.detail.value; });
  }
}
customElements.define("login-form", LoginForm);

// Un champ « contrôlé » à la manière de React : la valeur que le framework
// croit avoir posée est suivie par une propriété d'instance ; un `input` qui
// n'apporte rien de neuf par rapport à elle est ignoré, et chaque rendu
// réécrit tous les champs depuis l'état. Un remplissage qui passerait par
// `input.value = …` serait donc effacé au rendu suivant.
window.controlled = (input, key) => {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  let tracked = "";
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return proto.get.call(this); },
    set(v) { tracked = String(v); proto.set.call(this, v); },
  });
  window.__controlled = window.__controlled || [];
  window.__controlled.push([input, key]);
  input.addEventListener("input", () => {
    const now = proto.get.call(input);
    if (now === tracked) return;
    tracked = now;
    window.__state[key] = now;
    for (const [el, k] of window.__controlled) el.value = window.__state[k] ?? "";
  });
  field(key, input);
};
