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
import type { CredentialsReply, FillReply, MatchesReply, PasskeyToBackground, ToBackground, ToContent } from "./messages";
import * as passkeys from "./passkeys";
import { LOCK_ALARM, loadItemsCache, loadSettings, lock, saveTokens } from "./store";

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

// ─── Badge ──────────────────────────────────────────────────────────────────

async function updateBadge(tabId: number) {
  let url: string | undefined;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {
    return;
  }
  const m = await matchesFor(url);
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
  if (info.url || info.status === "complete") void updateBadge(tabId);
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "session") void updateActiveBadges();
});
chrome.runtime.onStartup.addListener(() => void updateActiveBadges());
chrome.runtime.onInstalled.addListener(() => void updateActiveBadges());

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
  if (alarm.name === LOCK_ALARM) void lock();
});
