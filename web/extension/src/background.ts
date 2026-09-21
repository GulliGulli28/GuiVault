/** Le service worker : il meurt au bout de 30 s d'inactivité (MV3), donc il
 * ne garde rien — la session vit dans `chrome.storage.session`. Il fait
 * trois choses, toutes à partir de ce stockage :
 *
 * - le **badge** sur l'icône : combien d'identifiants correspondent à
 *   l'onglet actif ;
 * - répondre au **script de page** (quels identifiants pour cette URL, puis
 *   les secrets de celui qu'on a choisi) ;
 * - le **raccourci clavier** de remplissage et l'alarme de verrouillage. */
import { parseTotp, totpCode } from "../../src/lib/totp";
import { loginMatches } from "../../src/lib/urimatch";
import type { Login } from "../../src/lib/types";
import { setTokensChangedHandler } from "../../src/lib/api";
import { uuid } from "../../src/lib/bytes";
import { DEFAULT_GENERATOR, generate, type GeneratorOptions } from "../../src/lib/generator";
import type { CredentialsReply, FillReply, MatchesReply, PasskeyToBackground, Pending, ToBackground, ToContent, VaultsReply } from "./messages";
import * as passkeys from "./passkeys";
import { LOCK_ALARM, loadItemsCache, loadSession, loadSettings, lock, saveTokens } from "./store";
import { findLogin, saveLogin } from "./vaultops";

// Une écriture depuis ici (enregistrer une passkey) peut rafraîchir les
// jetons : ils doivent revenir dans la session.
setTokensChangedHandler((t) => { if (t) void saveTokens(t); });

/** Les identifiants déchiffrés en session, sans ouvrir de clé : le cache
 * d'items est déjà en clair dans `chrome.storage.session`. `null` si
 * verrouillé. */
async function logins(): Promise<Login[] | null> {
  const has = await chrome.storage.session.get("session");
  if (!has.session) return null;
  const cache = await loadItemsCache();
  const out: Login[] = [];
  for (const v of Object.values(cache)) {
    for (const it of v.items) if (it.ok && it.payload.kind === "login") out.push(it.payload.login);
  }
  return out;
}

async function matchesFor(url: string | undefined): Promise<Login[] | null> {
  if (!url || !/^https?:/.test(url)) return [];
  const all = await logins();
  return all ? all.filter((l) => loginMatches(l, url)).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name)) : null;
}

// ─── Icône : grise quand il faut se reconnecter ─────────────────────────────

async function updateIcon() {
  const has = await chrome.storage.session.get("session");
  const p = has.session ? "icons/icon" : "icons/gray";
  await chrome.action.setIcon({ path: { 16: `${p}16.png`, 32: `${p}32.png`, 48: `${p}48.png`, 128: `${p}128.png` } }).catch(() => {});
  await chrome.action.setTitle({ title: has.session ? "GuiVault" : "GuiVault — verrouillé, cliquez pour vous reconnecter" }).catch(() => {});
}

// ─── Badge ──────────────────────────────────────────────────────────────────

/** Les onglets où le script de page a vu un formulaire de connexion : le
 * badge ne compte que là — un site où l'on a des identifiants mais pas de
 * formulaire sous les yeux n'a rien à signaler. */
async function formPresent(tabId: number): Promise<boolean> {
  const r = await chrome.storage.session.get("forms");
  return !!((r.forms as Record<string, boolean> | undefined) ?? {})[tabId];
}

async function setFormPresent(tabId: number, present: boolean) {
  const r = await chrome.storage.session.get("forms");
  const all = (r.forms as Record<string, boolean> | undefined) ?? {};
  if (all[tabId] === present) return;
  if (present) all[tabId] = true;
  else delete all[tabId];
  await chrome.storage.session.set({ forms: all });
}

async function updateBadge(tabId: number) {
  let url: string | undefined;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {
    return;
  }
  const m = (await formPresent(tabId)) ? await matchesFor(url) : null;
  const text = m && m.length > 0 ? String(m.length) : "";
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => {});
}

async function updateActiveBadges() {
  const tabs = await chrome.tabs.query({ active: true });
  for (const t of tabs) if (t.id != null) await updateBadge(t.id);
}

chrome.tabs.onActivated.addListener(({ tabId }) => void updateBadge(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Nouvelle page : on oublie le formulaire de l'ancienne, le script de
  // page redira ce qu'il voit.
  if (info.status === "loading") void setFormPresent(tabId, false).then(() => updateBadge(tabId));
  else if (info.url || info.status === "complete") void updateBadge(tabId);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.session || changes.items || changes.forms) void updateActiveBadges();
  if (changes.session) void updateIcon();
});
chrome.runtime.onStartup.addListener(() => { void updateActiveBadges(); void updateIcon(); });
chrome.runtime.onInstalled.addListener(() => { void updateActiveBadges(); void updateIcon(); });
void updateIcon();

// ─── Saisie capturée : proposer d'enregistrer ───────────────────────────────
//
// La page soumet son formulaire puis navigue : la bannière ne peut pas
// vivre dans la page qui part. On garde la saisie ici (mémoire de session,
// par onglet), la page suivante la demande et l'affiche.

interface Captured {
  url: string;
  username: string;
  password: string;
  mode: "new" | "update";
  loginId: string | null;
  loginName: string | null;
  at: number;
}

const PENDING_TTL_MS = 2 * 60_000;

async function pendingFor(tabId: number): Promise<Captured | null> {
  const r = await chrome.storage.session.get("pending");
  const all = (r.pending as Record<string, Captured> | undefined) ?? {};
  const c = all[tabId];
  return c && Date.now() - c.at < PENDING_TTL_MS ? c : null;
}

async function setPending(tabId: number, c: Captured | null) {
  const r = await chrome.storage.session.get("pending");
  const all = (r.pending as Record<string, Captured> | undefined) ?? {};
  if (c) all[tabId] = c;
  else delete all[tabId];
  await chrome.storage.session.set({ pending: all });
}

/** Une saisie vaut la peine d'être proposée si aucun identifiant du site
 * n'a déjà ce couple, ou si l'un a ce nom mais un autre mot de passe. */
async function classify(url: string, username: string, password: string): Promise<Pick<Captured, "mode" | "loginId" | "loginName"> | null> {
  const m = await matchesFor(url);
  if (!m) return null;
  const same = m.find((l) => l.username.toLowerCase() === username.toLowerCase());
  if (same && same.password === password) return null;
  if (same) return { mode: "update", loginId: same.id, loginName: same.name };
  if (m.some((l) => l.password === password && !l.username)) return null;
  return { mode: "new", loginId: null, loginName: null };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function saveCaptured(tabId: number, vaultId: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const c = await pendingFor(tabId);
  if (!c) return { ok: false, error: "rien à enregistrer" };
  try {
    if (c.mode === "update" && c.loginId) {
      const found = await findLogin(c.loginId);
      if (!found) return { ok: false, error: "identifiant introuvable" };
      const { login, revision } = found;
      const history = login.password ? [{ password: login.password, changedAt: new Date().toISOString() }, ...login.passwordHistory].slice(0, 10) : login.passwordHistory;
      await saveLogin(found.vaultId, { ...login, password: c.password, passwordHistory: history }, revision);
      await setPending(tabId, null);
      return { ok: true, name: login.name };
    }
    const host = hostOf(c.url);
    const login: Login = { id: uuid(), name: host.replace(/^www\./, ""), groupId: null, tags: [], username: c.username, password: c.password, uris: [{ uri: new URL(c.url).origin, match: null }], totp: null, passkeys: [], passwordHistory: [] };
    await saveLogin(vaultId, login);
    await setPending(tabId, null);
    return { ok: true, name: login.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Messages du script de page ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ToBackground | PasskeyToBackground, sender, reply: (r: unknown) => void) => {
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
  (async () => {
    // ── Passkeys : l'origine est celle que le navigateur connaît de
    // l'expéditeur ; l'identifiant de partie utilisatrice doit lui
    // appartenir, sinon une page pourrait signer pour un autre site.
    if (msg.type === "guivault-passkey-candidates") {
      if (!passkeys.rpIdAllowed(msg.rpId, origin)) return reply({ error: "rpId non autorisé pour cette origine" });
      return reply({ candidates: await passkeys.candidates(msg.rpId, msg.allow) });
    }
    if (msg.type === "guivault-passkey-assert") {
      if (!passkeys.rpIdAllowed(msg.rpId, origin)) return reply({ error: "rpId non autorisé pour cette origine" });
      return reply({ assertion: await passkeys.assert(msg.credentialId, msg.rpId, msg.challenge, origin) });
    }
    if (msg.type === "guivault-passkey-logins") {
      if (!passkeys.rpIdAllowed(msg.rpId, origin)) return reply({ error: "rpId non autorisé pour cette origine" });
      return reply({ logins: await passkeys.loginsForRp(msg.rpId) });
    }
    if (msg.type === "guivault-passkey-register") {
      if (!passkeys.rpIdAllowed(msg.rpId, origin)) return reply({ error: "rpId non autorisé pour cette origine" });
      const { type: _t, ...req } = msg;
      return reply({ attestation: await passkeys.register({ ...req, origin }) });
    }
    if (msg.type === "guivault-matches") {
      // L'URL est celle que le navigateur connaît de l'expéditeur, pas
      // celle que la page prétend.
      const url = sender.tab?.url ?? sender.url ?? msg.url;
      const m = await matchesFor(url);
      if (!m) return reply({ locked: true } satisfies MatchesReply);
      const settings = await loadSettings();
      return reply({ locked: false, enabled: settings.inlineAutofill, logins: m.map((l) => ({ id: l.id, name: l.name, username: l.username, hasTotp: !!l.totp, favorite: !!l.favorite })) } satisfies MatchesReply);
    }
    if (msg.type === "guivault-captured") {
      const tabId = sender.tab?.id;
      const url = sender.tab?.url ?? sender.url;
      if (tabId == null || !url || !msg.password) return reply(null);
      const cls = await classify(url, msg.username, msg.password);
      if (!cls) return reply(null);
      await setPending(tabId, { url, username: msg.username, password: msg.password, ...cls, at: Date.now() });
      return reply({ ok: true });
    }
    if (msg.type === "guivault-pending") {
      const tabId = sender.tab?.id;
      if (tabId == null) return reply(null);
      const c = await pendingFor(tabId);
      const s = c ? await loadSession() : null;
      if (!c || !s) return reply(null);
      const vaults = s.state.vaults.filter((v) => v.role !== "reader").map((v) => ({ id: v.id, name: v.name }));
      const personal = s.state.vaults.find((v) => v.kind === "personal");
      const p: Pending = { host: hostOf(c.url), username: c.username, mode: c.mode, loginName: c.loginName, vaults, defaultVaultId: personal?.id ?? vaults[0]?.id ?? "" };
      return reply(p);
    }
    if (msg.type === "guivault-save-captured") {
      const tabId = sender.tab?.id;
      if (tabId == null) return reply({ ok: false, error: "pas d'onglet" });
      return reply(await saveCaptured(tabId, msg.vaultId));
    }
    if (msg.type === "guivault-dismiss-captured") {
      if (sender.tab?.id != null) await setPending(sender.tab.id, null);
      return reply({ ok: true });
    }
    if (msg.type === "guivault-form") {
      if (sender.tab?.id != null && sender.frameId === 0) {
        await setFormPresent(sender.tab.id, msg.present);
        await updateBadge(sender.tab.id);
      }
      return reply({ ok: true });
    }
    if (msg.type === "guivault-vaults") {
      const s = await loadSession();
      if (!s) return reply({ locked: true } satisfies VaultsReply);
      const vaults = s.state.vaults.filter((v) => v.role !== "reader").map((v) => ({ id: v.id, name: v.name }));
      const personal = s.state.vaults.find((v) => v.kind === "personal");
      return reply({ locked: false, vaults, defaultVaultId: personal?.id ?? vaults[0]?.id ?? "" } satisfies VaultsReply);
    }
    if (msg.type === "guivault-generator-options") {
      const r = await chrome.storage.local.get("generator");
      return reply({ options: (r.generator as GeneratorOptions | undefined) ?? DEFAULT_GENERATOR });
    }
    if (msg.type === "guivault-generator-options-set") {
      await chrome.storage.local.set({ generator: msg.options });
      return reply({ ok: true });
    }
    if (msg.type === "guivault-generate") {
      // Les réglages du générateur du popup, si on les a (miroir de son
      // `localStorage` dans `chrome.storage.local`), sinon les défauts.
      const r = await chrome.storage.local.get("generator");
      const opts = (r.generator as GeneratorOptions | undefined) ?? DEFAULT_GENERATOR;
      return reply({ password: generate(opts) });
    }
    if (msg.type === "guivault-create-login") {
      if (!sender.tab?.url) return reply({ ok: false, error: "pas d'onglet" });
      const uri = msg.uri.trim() || new URL(sender.tab.url).origin;
      const login: Login = { id: uuid(), name: msg.name.trim() || hostOf(uri), groupId: null, tags: [], username: msg.username.trim(), password: msg.password, uris: [{ uri, match: null }], totp: null, passkeys: [], passwordHistory: [] };
      try {
        await saveLogin(msg.vaultId, login);
        return reply({ ok: true, name: login.name });
      } catch (e) {
        return reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (msg.type === "guivault-credentials") {
      const url = sender.tab?.url ?? sender.url;
      const m = await matchesFor(url);
      const l = m?.find((x) => x.id === msg.id);
      if (!l) return reply(null);
      const p = l.totp ? parseTotp(l.totp) : null;
      return reply({ username: l.username, password: l.password, totp: p ? await totpCode(p) : null } satisfies CredentialsReply);
    }
  })().catch((e) => reply({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});

// ─── Raccourci clavier ──────────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command !== "autofill") return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const m = await matchesFor(tab.url);
    if (!m || m.length === 0) return;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const msg: ToContent = m.length === 1 ? { type: "guivault-fill", username: m[0].username, password: m[0].password } : { type: "guivault-pick" };
    await chrome.tabs.sendMessage<ToContent, FillReply | undefined>(tab.id, msg).catch(() => undefined);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM) void lock("timeout");
});

chrome.tabs.onRemoved.addListener((tabId) => { void setPending(tabId, null); void setFormPresent(tabId, false); });
