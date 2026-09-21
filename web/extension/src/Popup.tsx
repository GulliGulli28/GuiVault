import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage, setBaseUrl, setSessionLostHandler, setTokensChangedHandler } from "../../src/lib/api";
import { loadItems, login, refresh, setDeviceLabel, type DecodedItem, type SessionState } from "../../src/lib/session";
import { loginMatches } from "../../src/lib/urimatch";
import type { Login, TokenPair } from "../../src/lib/types";
import { GeneratorPanel } from "../../src/components/GeneratorPanel";
import { TotpCode } from "../../src/components/TotpCode";
import { IconDice, IconGlobe, IconLogin, IconStar } from "../../src/components/secret-icons";
import { IconCopy, IconExternal, IconLock, IconRefresh, IconSearch } from "../../src/components/ui-icons";
import { copyText, PasswordInput } from "../../src/components/ui";
import { lock, loadItemsCache, loadSession, loadSettings, saveItemsCache, saveSession, saveSettings, saveTokens, touchLock, type ItemsCache, type Settings } from "./store";

setDeviceLabel("Extension GuiVault");

type Screen = { kind: "loading" } | { kind: "login" } | { kind: "vault"; state: SessionState };
type Tab = "page" | "all" | "generator";

interface LoginEntry {
  vaultId: string;
  vaultName: string;
  item: DecodedItem & { ok: true };
  login: Login;
}

/** Le popup : connexion, puis les identifiants de la page courante, la
 * recherche dans tout le coffre, et le générateur. Lecture seule — pour
 * modifier, « Ouvrir le coffre » mène à l'interface web du serveur. */
export function Popup() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [cache, setCache] = useState<ItemsCache>({});
  const [tab, setTab] = useState<Tab>("page");
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const say = useCallback((m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((n) => (n === m ? null : n)), 2000);
  }, []);

  /** Relit `/sync` et les vaults dont la révision a bougé. */
  const sync = useCallback(async (state: SessionState, current: ItemsCache) => {
    setRefreshing(true);
    try {
      await refresh(state);
      const next: ItemsCache = {};
      for (const v of state.vaults) {
        const c = current[v.id];
        next[v.id] = c && c.revision === v.revision ? c : await loadItems(v).then((p) => ({ revision: p.revision, items: p.items }));
      }
      setCache(next);
      await saveItemsCache(next);
      const stored = (await chrome.storage.session.get("session")).session as { tokens?: TokenPair } | undefined;
      const tokens = stored?.tokens;
      if (tokens) await saveSession(state, tokens);
      setScreen({ kind: "vault", state: { ...state } });
    } catch (e) {
      say(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }, [say]);

  useEffect(() => {
    setTokensChangedHandler((t) => { if (t) void saveTokens(t); });
    setSessionLostHandler(() => { void lock(); setScreen({ kind: "login" }); });
    (async () => {
      const s = await loadSettings();
      setSettings(s);
      if (s.serverUrl) setBaseUrl(s.serverUrl);
      // `?tab=<id>` : le popup ouvert comme une page (tests) vise cet onglet
      // plutôt que lui-même.
      const override = Number(new URLSearchParams(location.search).get("tab"));
      const tabInfo = override ? await chrome.tabs.get(override) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      setPageUrl(tabInfo?.url ?? null);
      setTabId(tabInfo?.id ?? null);
      const restored = await loadSession();
      if (!restored) {
        setScreen({ kind: "login" });
        return;
      }
      const cached = await loadItemsCache();
      setCache(cached);
      setScreen({ kind: "vault", state: restored.state });
      await touchLock(s.lockMinutes);
      void sync(restored.state, cached);
    })();
    return () => {
      setTokensChangedHandler(null);
      setSessionLostHandler(null);
    };
  }, [sync]);

  const entries = useMemo<LoginEntry[]>(() => {
    if (screen.kind !== "vault") return [];
    const out: LoginEntry[] = [];
    for (const v of screen.state.vaults) {
      for (const it of cache[v.id]?.items ?? []) {
        if (it.ok && it.payload.kind === "login") out.push({ vaultId: v.id, vaultName: v.name, item: it, login: it.payload.login });
      }
    }
    return out.sort((a, b) => Number(!!b.login.favorite) - Number(!!a.login.favorite) || a.login.name.localeCompare(b.login.name));
  }, [screen, cache]);

  const forPage = useMemo(() => (pageUrl && /^https?:/.test(pageUrl) ? entries.filter((e) => loginMatches(e.login, pageUrl)) : []), [entries, pageUrl]);

  const fill = async (e: LoginEntry, what: "credentials" | "totp") => {
    if (tabId == null) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      const msg = what === "totp" ? { type: "guivault-fill", totp: e.login.totp ? await currentTotp(e.login.totp) : "" } : { type: "guivault-fill", username: e.login.username, password: e.login.password };
      const r = (await chrome.tabs.sendMessage(tabId, msg)) as { username: boolean; password: boolean; totp: boolean } | undefined;
      if (!r) say("Pas de réponse de la page.");
      else if (what === "totp") say(r.totp ? "Code rempli." : "Aucun champ de code trouvé.");
      else say(r.password ? (r.username ? "Rempli." : "Mot de passe rempli (utilisateur non trouvé).") : r.username ? "Utilisateur rempli (pas de champ mot de passe)." : "Aucun champ de connexion trouvé sur cette page.");
      if (r?.password || r?.username || r?.totp) window.close();
    } catch (err) {
      say(`Impossible sur cette page : ${errorMessage(err)}`);
    }
  };

  const doLock = async () => {
    await lock();
    setScreen({ kind: "login" });
  };

  if (!settings || screen.kind === "loading") return <div className="p-4 text-[12px] text-[var(--c-text-muted)]">Chargement…</div>;

  return (
    <div className="flex h-[540px] flex-col bg-[var(--c-bg2)] text-[var(--c-text)]">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] bg-[var(--c-bg)] px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--c-accent-dim)] text-[var(--c-accent-text)]"><IconLogin size={13} /></span>
        <span className="text-[13px] font-semibold">GuiVault</span>
        <span className="ml-auto flex items-center gap-0.5">
          {screen.kind === "vault" && (
            <>
              <button onClick={() => void sync(screen.state, cache)} className="btn btn-ghost btn-sm btn-icon" title="Rafraîchir" aria-label="Rafraîchir"><IconRefresh size={12} className={refreshing ? "animate-spin" : ""} /></button>
              <a href={settings.serverUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm btn-icon" title="Ouvrir le coffre (interface web)" aria-label="Ouvrir le coffre"><IconExternal size={12} /></a>
              <button onClick={() => void doLock()} className="btn btn-ghost btn-sm btn-icon" title="Verrouiller" aria-label="Verrouiller"><IconLock size={12} /></button>
            </>
          )}
        </span>
      </header>

      {screen.kind === "login" ? (
        <LoginView
          settings={settings}
          onSettings={(s) => { setSettings(s); void saveSettings(s); }}
          onSession={async (state, tokens) => {
            await saveSession(state, tokens);
            await touchLock(settings.lockMinutes);
            setScreen({ kind: "vault", state });
            void sync(state, {});
          }}
        />
      ) : (
        <>
          <nav className="flex shrink-0 gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
            {(["page", "all", "generator"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`btn btn-sm ${tab === t ? "btn-toggled" : "btn-ghost"}`}>
                {t === "page" ? <><IconGlobe size={12} /> Cette page{forPage.length ? <span className="tag tag-accent">{forPage.length}</span> : null}</> : t === "all" ? <><IconSearch size={12} /> Tout</> : <><IconDice size={12} /> Générateur</>}
              </button>
            ))}
          </nav>
          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2">
            {tab === "generator" && <GeneratorPanel compact />}
            {tab === "page" && (
              forPage.length === 0 ? (
                <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">{pageUrl && /^https?:/.test(pageUrl) ? `Aucun identifiant pour ${new URL(pageUrl).hostname}.` : "Pas de page web active."}</p>
              ) : (
                forPage.map((e) => <Row key={e.item.id} entry={e} onFill={fill} say={say} canFill />)
              )
            )}
            {tab === "all" && <AllView entries={entries} onFill={fill} say={say} canFill={!!pageUrl && /^https?:/.test(pageUrl)} />}
          </div>
        </>
      )}
      {notice && <div role="status" className="shrink-0 border-t border-[var(--c-border)] bg-[var(--c-bg)] px-3 py-1.5 text-[11.5px] text-[var(--c-text-secondary)]">{notice}</div>}
    </div>
  );
}

async function currentTotp(secret: string): Promise<string> {
  const { parseTotp, totpCode } = await import("../../src/lib/totp");
  const p = parseTotp(secret);
  return p ? totpCode(p) : "";
}

function AllView({ entries, onFill, say, canFill }: { entries: LoginEntry[]; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; say: (m: string) => void; canFill: boolean }) {
  const [q, setQ] = useState("");
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries.filter((e) => {
    if (!terms.length) return true;
    const hay = `${e.login.name} ${e.login.username} ${e.login.uris.map((u) => u.uri).join(" ")} ${e.vaultName}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  return (
    <>
      <div className="relative mb-1.5">
        <IconSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Rechercher…" aria-label="Rechercher" className="input pl-7" />
      </div>
      {shown.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">{entries.length ? "Rien ne correspond." : "Aucun identifiant. Ajoutez-en depuis l'interface web."}</p>}
      {shown.slice(0, 200).map((e) => <Row key={e.item.id} entry={e} onFill={onFill} say={say} canFill={canFill} showVault />)}
    </>
  );
}

function Row({ entry, onFill, say, canFill, showVault }: { entry: LoginEntry; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; say: (m: string) => void; canFill: boolean; showVault?: boolean }) {
  const l = entry.login;
  const copy = (label: string, v: string) => () => copyText(v).then((ok) => say(ok ? `${label} copié.` : "Copie refusée par le navigateur."));
  return (
    <div className="list-row mb-0.5 flex-wrap py-1.5">
      <button onClick={() => (canFill ? void onFill(entry, "credentials") : copy("Mot de passe", l.password)())} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={canFill ? "Remplir la page" : "Copier le mot de passe"}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconLogin size={12} /></span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex items-center gap-1 truncate text-[12.5px] font-medium text-[var(--c-text)]">{l.name}{l.favorite && <IconStar size={10} filled className="text-[var(--c-warn)]" />}</span>
          <span className="truncate text-[10.5px] text-[var(--c-text-muted)]">{l.username || "—"}{showVault ? ` · ${entry.vaultName}` : ""}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5">
        {l.username && <button onClick={copy("Utilisateur", l.username)} className="btn btn-ghost btn-sm" title="Copier l'utilisateur" aria-label="Copier l'utilisateur">U</button>}
        {l.password && <button onClick={copy("Mot de passe", l.password)} className="btn btn-ghost btn-sm btn-icon" title="Copier le mot de passe" aria-label="Copier le mot de passe"><IconCopy size={11} /></button>}
        {l.totp && <span className="pl-1"><TotpCode secret={l.totp} compact /></span>}
        {l.totp && canFill && <button onClick={() => void onFill(entry, "totp")} className="btn btn-ghost btn-sm" title="Remplir le code dans la page" aria-label="Remplir le code dans la page">↵</button>}
      </span>
    </div>
  );
}

function LoginView({ settings, onSettings, onSession }: { settings: Settings; onSettings: (s: Settings) => void; onSession: (state: SessionState, tokens: TokenPair) => Promise<void> }) {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [email, setEmail] = useState(settings.email);
  const [password, setPassword] = useState("");
  const [lockMinutes, setLockMinutes] = useState(settings.lockMinutes);
  const [inlineAutofill, setInlineAutofill] = useState(settings.inlineAutofill);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState<{ verify: (code: string) => Promise<SessionState> } | null>(null);
  const [code, setCode] = useState("");

  // Les jetons de la connexion arrivent par `setTokens` : on les attrape au
  // passage pour les persister avec la session.
  const capture = () =>
    new Promise<TokenPair>((resolve) => {
      setTokensChangedHandler((t) => { if (t) resolve(t); });
    });

  const finish = async (state: SessionState, tokensP: Promise<TokenPair>) => {
    const tokens = await tokensP;
    setTokensChangedHandler((t) => { if (t) void saveTokens(t); });
    await onSession(state, tokens);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const url = serverUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) {
      setError("L'adresse du serveur doit commencer par https:// (ou http:// en local).");
      return;
    }
    setBusy("Vérification du serveur…");
    try {
      setBaseUrl(url);
      await api.health();
      onSettings({ serverUrl: url, email: email.trim().toLowerCase(), lockMinutes, inlineAutofill });
      setBusy("Dérivation de la clé…");
      const tokensP = capture();
      const out = await login(email, password);
      if (out.kind === "ok") await finish(out.session, tokensP);
      else setTotp({ verify: async (c) => { const s = await out.verify(c); await finish(s, tokensP); return s; } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (totp) {
    return (
      <form onSubmit={async (e) => { e.preventDefault(); setBusy("Vérification…"); setError(null); try { await totp.verify(code); } catch (err) { setError(errorMessage(err)); } finally { setBusy(null); } }} className="space-y-3 p-3">
        <p className="text-[12.5px] text-[var(--c-text-secondary)]">Code de votre application d'authentification, ou code de récupération.</p>
        <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" className="input input-mono text-center tracking-[0.2em]" />
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => { setTotp(null); setCode(""); }} className="btn btn-ghost btn-sm">Annuler</button>
          <button type="submit" disabled={!code.trim() || busy !== null} className="btn btn-primary btn-sm">{busy ?? "Valider"}</button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 p-3">
      <label className="block">
        <span className="field-label">Serveur GuiVault</span>
        <input type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://vault.example.com" required className="input input-mono" />
      </label>
      <label className="block">
        <span className="field-label">E-mail</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required className="input" />
      </label>
      <label className="block">
        <span className="field-label">Mot de passe maître</span>
        <PasswordInput value={password} onChange={setPassword} autoFocus={!!settings.email} autoComplete="current-password" />
      </label>
      <label className="block">
        <span className="field-label">Verrouiller après</span>
        <select value={lockMinutes} onChange={(e) => setLockMinutes(Number(e.target.value))} className="input">
          <option value={5}>5 minutes d'inactivité</option>
          <option value={15}>15 minutes d'inactivité</option>
          <option value={60}>1 heure d'inactivité</option>
          <option value={480}>8 heures d'inactivité</option>
          <option value={0}>À la fermeture du navigateur</option>
        </select>
      </label>
      <label className="flex cursor-pointer items-start gap-2 text-[12.5px]">
        <input type="checkbox" checked={inlineAutofill} onChange={(e) => setInlineAutofill(e.target.checked)} className="mt-0.5" />
        <span>Proposer le remplissage dans les pages<span className="help-text block">Un bouton GuiVault dans les champs de mot de passe quand le coffre a quelque chose pour le site.</span></span>
      </label>
      {error && <p className="callout callout-danger">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <span className="help-text">Déchiffré ici, jamais sur disque.</span>
        <button type="submit" disabled={!serverUrl.trim() || !email.trim() || !password || busy !== null} className="btn btn-primary btn-sm">{busy ?? "Déverrouiller"}</button>
      </div>
    </form>
  );
}
