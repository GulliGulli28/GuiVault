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
import type { CredentialsReply, FillReply, FillTabReply, FrameInfo, MatchesReply, MatchSummary, OffscreenMessage, PasskeyToBackground, Pending, PopupToBackground, ToBackground, ToContent, TotpReply, VaultsReply } from "./messages";
import { hostOf, parentUrl, pickFrame, senderUrl, shortcutFrame, type FrameCandidate } from "./frames";
import { clearClipboardIfUnchanged } from "./clipboardDom";
import * as passkeys from "./passkeys";
import { CLIPBOARD_ALARM, LOCK_ALARM, loadItemsCache, loadSession, loadSettings, lock, noteRecentFill, parseOtpPatterns, recentFill, saveTokens, scheduleClipboardClear, takeClipboardClear } from "./store";
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

const summary = (l: Login): MatchSummary => ({ id: l.id, name: l.name, username: l.username, hasTotp: !!l.totp, favorite: !!l.favorite });

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

/** Les cadres où le script de page a vu un formulaire de connexion, par
 * onglet (`frameId` → URL du cadre) : le badge ne compte que là — un site
 * où l'on a des identifiants mais pas de formulaire sous les yeux n'a rien
 * à signaler. */
type Forms = Record<string, Record<string, string>>;

async function formFrames(tabId: number): Promise<Record<string, string>> {
  const r = await chrome.storage.session.get("forms");
  return ((r.forms as Forms | undefined) ?? {})[tabId] ?? {};
}

/** `frameId` absent : on oublie tout l'onglet (nouvelle page). */
async function setFormPresent(tabId: number, present: boolean, frameId?: number, url?: string) {
  const r = await chrome.storage.session.get("forms");
  const all = (r.forms as Forms | undefined) ?? {};
  const frames = { ...(all[tabId] ?? {}) };
  if (frameId === undefined) {
    if (!all[tabId]) return;
    delete all[tabId];
  } else {
    if (present === (frameId in frames) && (!present || frames[frameId] === url)) return;
    if (present && url) frames[frameId] = url;
    else delete frames[frameId];
    if (Object.keys(frames).length) all[tabId] = frames;
    else delete all[tabId];
  }
  await chrome.storage.session.set({ forms: all });
}

async function updateBadge(tabId: number) {
  let url: string | undefined;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {
    return;
  }
  // Ce qui correspond à l'onglet, et à chaque cadre qui montre un
  // formulaire (une connexion servie dans un cadre par son fournisseur).
  const frames = await formFrames(tabId);
  let count = 0;
  if (Object.keys(frames).length) {
    const ids = new Set<string>();
    for (const u of new Set([url, ...Object.values(frames)])) for (const l of (await matchesFor(u)) ?? []) ids.add(l.id);
    count = ids.size;
  }
  const text = count > 0 ? String(count) : "";
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
  /** L'URL du cadre où le formulaire a été soumis. */
  url: string;
  /** Celle de l'onglet quand c'est un autre site (connexion dans un cadre) :
   * l'identifiant enregistré vaudra pour les deux. */
  parentUrl?: string;
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
async function classify(urls: string[], username: string, password: string): Promise<Pick<Captured, "mode" | "loginId" | "loginName"> | null> {
  const lists = await Promise.all(urls.map((u) => matchesFor(u)));
  if (lists.some((l) => l === null)) return null;
  const m = [...new Map(lists.flatMap((l) => l ?? []).map((l) => [l.id, l])).values()];
  const same = m.find((l) => l.username.toLowerCase() === username.toLowerCase());
  if (same && same.password === password) return null;
  if (same) return { mode: "update", loginId: same.id, loginName: same.name };
  if (m.some((l) => l.password === password && !l.username)) return null;
  return { mode: "new", loginId: null, loginName: null };
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
    const host = hostOf(c.parentUrl ?? c.url);
    const login: Login = { id: uuid(), name: host.replace(/^www\./, ""), groupId: null, tags: [], username: c.username, password: c.password, uris: urisFor(c.url, c.parentUrl), totp: null, passkeys: [], passwordHistory: [] };
    await saveLogin(vaultId, login);
    await setPending(tabId, null);
    return { ok: true, name: login.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Les URI d'un identifiant créé dans un cadre : celle du cadre, et celle
 * de l'onglet si c'est un autre site — rempli ensuite sans confirmation
 * dans ce cadre, et proposé dans le popup sur la page. */
function urisFor(url: string, parent?: string): Login["uris"] {
  const origin = new URL(url).origin;
  const uris: Login["uris"] = [{ uri: origin, match: null }];
  if (parent) {
    const p = new URL(parent).origin;
    if (p !== origin) uris.unshift({ uri: p, match: null });
  }
  return uris;
}

/** Ce que chaque cadre de l'onglet montre (après y avoir mis le script de
 * page s'il n'y était pas). Un cadre inaccessible (autre schéma, page du
 * navigateur) est simplement absent. */
async function tabFrames(tabId: number): Promise<FrameCandidate[]> {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] }).catch(() => undefined);
  const results = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: () => (window as Window & { __guivaultFrameInfo?: () => FrameInfo }).__guivaultFrameInfo?.() ?? null })
    .catch(() => [] as chrome.scripting.InjectionResult<FrameInfo | null>[]);
  return results.flatMap((r) => (r.result ? [{ frameId: r.frameId, info: r.result as FrameInfo }] : []));
}

/** Le popup demande de remplir un identifiant dans l'onglet : le worker
 * choisit **un** cadre — jamais tous à la fois, un cadre tiers n'a pas à
 * recevoir le mot de passe du site. */
async function fillTab(tabId: number, loginId: string, what: "credentials" | "totp", confirmedFrame?: number): Promise<FillTabReply> {
  const all = await logins();
  if (!all) return { ok: false, reason: "locked" };
  const login = all.find((l) => l.id === loginId);
  if (!login) return { ok: false, reason: "not-found" };
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, reason: "no-page" };
  }
  if (!tab.url || !/^https?:/.test(tab.url)) return { ok: false, reason: "no-page" };
  const frames = await tabFrames(tabId);
  let frameId: number;
  if (confirmedFrame !== undefined && frames.some((f) => f.frameId === confirmedFrame)) {
    frameId = confirmedFrame;
  } else {
    const pick = pickFrame(frames, (u) => loginMatches(login, u), what);
    if (!pick) return { ok: false, reason: "no-fields" };
    if ("confirm" in pick) return { ok: false, reason: "confirm", frameId: pick.confirm, frameHost: pick.host };
    frameId = pick.fill;
  }
  const p = what === "totp" && login.totp ? parseTotp(login.totp) : null;
  const msg: ToContent = what === "totp" ? { type: "guivault-fill", totp: p ? await totpCode(p) : "" } : { type: "guivault-fill", username: login.username, password: login.password };
  const filled = await chrome.tabs.sendMessage<ToContent, FillReply | undefined>(tabId, msg, { frameId }).catch(() => undefined);
  if (!filled) return { ok: false, reason: "no-fields" };
  if (filled.username || filled.password) await noteRecentFill(tabId, login.id);
  return { ok: true, filled };
}

// ─── Messages du script de page ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ToBackground | PasskeyToBackground | PopupToBackground, sender, reply: (r: unknown) => void) => {
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;
  // D'une page de l'extension seulement (le popup) : un script de page,
  // dont l'URL est celle du site, n'a rien à programmer sur le
  // presse-papiers.
  if (msg.type === "guivault-clipboard-clear") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
    void scheduleClipboardClear(msg.hash, msg.delayMs).then(() => reply(true));
    return true;
  }
  // Remplir depuis le popup : une page de l'extension seulement — un script
  // de page n'ordonne pas de remplir un autre onglet.
  if (msg.type === "guivault-fill-tab") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
    void fillTab(msg.tabId, msg.loginId, msg.what, msg.frameId).then(reply, (e) => reply({ ok: false, reason: "no-fields", error: String(e) }));
    return true;
  }
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
      // L'URL est celle que le navigateur connaît de l'expéditeur — du
      // **cadre**, pas de l'onglet : un cadre tiers ne reçoit pas les
      // identifiants du site qui l'héberge. Ceux-là, il ne les a qu'à
      // confirmer (`parent`).
      const url = senderUrl(sender);
      const m = await matchesFor(url);
      if (!m) return reply({ locked: true } satisfies MatchesReply);
      const top = parentUrl(sender);
      const fromTop = top ? ((await matchesFor(top)) ?? []).filter((l) => !m.some((x) => x.id === l.id)) : [];
      const parent = top && url && fromTop.length ? { host: hostOf(top), frameHost: hostOf(url), logins: fromTop.map(summary) } : null;
      const settings = await loadSettings();
      const tabId = sender.tab?.id;
      const recentId = tabId != null ? await recentFill(tabId) : null;
      const recent = recentId && !m.some((l) => l.id === recentId) ? (await logins())?.find((l) => l.id === recentId && l.totp) ?? null : null;
      const otpPatterns = parseOtpPatterns(settings.otpPatterns).rules.filter((r) => !r.url || (url ? r.url.test(url) : false)).map((r) => r.field.source);
      return reply({ locked: false, enabled: settings.inlineAutofill, logins: m.map(summary), parent, recent: recent ? summary(recent) : null, autoTotp: settings.autoTotp, otpPatterns } satisfies MatchesReply);
    }
    if (msg.type === "guivault-totp") {
      const url = senderUrl(sender);
      const tabId = sender.tab?.id;
      const m = await matchesFor(url);
      let l = m?.find((x) => x.id === msg.id);
      // Pas un identifiant du site : seulement le dernier rempli dans cet
      // onglet — la page de SSO qui suit, sur son propre domaine.
      if (!l && tabId != null && (await recentFill(tabId)) === msg.id) l = (await logins())?.find((x) => x.id === msg.id);
      const p = l?.totp ? parseTotp(l.totp) : null;
      return reply((p ? { code: await totpCode(p) } : null) satisfies TotpReply);
    }
    if (msg.type === "guivault-captured") {
      const tabId = sender.tab?.id;
      const url = senderUrl(sender);
      if (tabId == null || !url || !msg.password) return reply(null);
      const top = parentUrl(sender);
      const parentOther = top && new URL(top).origin !== new URL(url).origin ? top : undefined;
      const cls = await classify(parentOther ? [url, parentOther] : [url], msg.username, msg.password);
      if (!cls) return reply(null);
      await setPending(tabId, { url, parentUrl: parentOther, username: msg.username, password: msg.password, ...cls, at: Date.now() });
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
      const host = c.parentUrl ? `${hostOf(c.parentUrl)} (formulaire de ${hostOf(c.url)})` : hostOf(c.url);
      const p: Pending = { host, username: c.username, mode: c.mode, loginName: c.loginName, vaults, defaultVaultId: personal?.id ?? vaults[0]?.id ?? "" };
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
      const url = senderUrl(sender);
      if (sender.tab?.id != null && url) {
        await setFormPresent(sender.tab.id, msg.present, sender.frameId ?? 0, url);
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
      const url = senderUrl(sender);
      if (!sender.tab?.url || !url) return reply({ ok: false, error: "pas d'onglet" });
      const uri = msg.uri.trim() || new URL(url).origin;
      // Créé dans un cadre d'un autre site : l'identifiant vaut aussi pour
      // la page qui l'héberge.
      const top = parentUrl(sender);
      const uris: Login["uris"] = [{ uri, match: null }];
      if (top && new URL(top).origin !== new URL(url).origin && !msg.uri.includes(new URL(top).host)) uris.unshift({ uri: new URL(top).origin, match: null });
      const login: Login = { id: uuid(), name: msg.name.trim() || hostOf(uri), groupId: null, tags: [], username: msg.username.trim(), password: msg.password, uris, totp: null, passkeys: [], passwordHistory: [] };
      try {
        await saveLogin(msg.vaultId, login);
        return reply({ ok: true, name: login.name });
      } catch (e) {
        return reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (msg.type === "guivault-credentials") {
      // Un identifiant du cadre ; ou, confirmé par l'utilisateur dans la
      // page (clic réel), un identifiant de l'onglet qui l'héberge.
      const m = await matchesFor(senderUrl(sender));
      let l = m?.find((x) => x.id === msg.id);
      const top = parentUrl(sender);
      if (!l && msg.crossFrame && top) l = (await matchesFor(top))?.find((x) => x.id === msg.id);
      if (!l) return reply(null);
      if (sender.tab?.id != null) await noteRecentFill(sender.tab.id, l.id);
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
    if (!m || !tab.url || !/^https?:/.test(tab.url)) return;
    // Un seul cadre décide (celui qui a le focus, sinon celui qui a un
    // formulaire), avec ses propres correspondances ; le script de page y
    // est d'ordinaire déjà, l'injecter n'en crée pas un second.
    const frameId = shortcutFrame(await tabFrames(tab.id));
    await chrome.tabs.sendMessage<ToContent, FillReply | undefined>(tab.id, { type: "guivault-shortcut" }, { frameId }).catch(() => undefined);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM) void lock("timeout");
  if (alarm.name === CLIPBOARD_ALARM) void takeClipboardClear().then((hash) => (hash ? clearClipboard(hash) : undefined));
});

// ─── Presse-papiers ─────────────────────────────────────────────────────────

/** Chrome : le worker n'a pas de DOM, un document hors écran le fait pour
 * lui, le temps de l'opération. Firefox : la page d'arrière-plan a un DOM. */
async function clearClipboard(hash: string) {
  if (typeof chrome.offscreen === "undefined") {
    if (typeof document !== "undefined") clearClipboardIfUnchanged(hash);
    return;
  }
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: "Effacer du presse-papiers ce qui a été copié depuis GuiVault",
      });
    }
    await chrome.runtime.sendMessage<OffscreenMessage>({ type: "guivault-offscreen-clipboard-clear", hash });
  } finally {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener((tabId) => { void setPending(tabId, null); void setFormPresent(tabId, false); });
