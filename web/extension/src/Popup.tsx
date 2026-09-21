import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage, setBaseUrl, setSessionLostHandler, setTokensChangedHandler } from "../../src/lib/api";
import { indexItems } from "../../src/lib/entities";
import { loadItems, login, refresh, setDeviceLabel, type DecodedItem, type SessionState } from "../../src/lib/session";
import { loginMatches } from "../../src/lib/urimatch";
import type { Login, TokenPair } from "../../src/lib/types";
import { GeneratorPanel } from "../../src/components/GeneratorPanel";
import { PasswordStrength } from "../../src/components/PasswordStrength";
import { TotpCode } from "../../src/components/TotpCode";
import { TotpList } from "../../src/components/TotpList";
import { LoginForm } from "../../src/components/forms/LoginForm";
import { IconDice, IconGlobe, IconLogin, IconShieldClock, IconStar } from "../../src/components/secret-icons";
import { IconChevronDown, IconChevronRight, IconCopy, IconEdit, IconExternal, IconLock, IconPlus, IconRefresh, IconSearch, IconTrash, IconVault } from "../../src/components/ui-icons";
import { copyText, PasswordInput, SecretValue } from "../../src/components/ui";
import { clearLockReason, lock, lockReason, loadItemsCache, loadSession, loadSettings, saveItemsCache, saveSession, saveSettings, saveTokens, touchLock, type ItemsCache, type LockReason, type Settings } from "./store";
import { deleteLogin, saveLogin } from "./vaultops";

setDeviceLabel("Extension GuiVault");

type Screen = { kind: "loading" } | { kind: "login"; reason: LockReason | null } | { kind: "vault"; state: SessionState };
type Tab = "vaults" | "totp" | "generator";
type View = { kind: "list" } | { kind: "detail"; id: string } | { kind: "edit"; id: string } | { kind: "new"; vaultId: string };

interface LoginEntry {
  vaultId: string;
  vaultName: string;
  item: DecodedItem & { ok: true };
  login: Login;
}

const COLLAPSED_KEY = "guivault.ext.collapsed";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Le popup : connexion, puis l'onglet Vaults — « Identifiants sur cette
 * page » quand il y en a, puis chaque vault en section repliable — et le
 * générateur. On y lit, remplit, copie, crée, modifie et supprime des
 * identifiants ; pour le reste (dossiers, autres types, partage), « Ouvrir
 * le coffre » mène à l'interface web. */
export function Popup() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [cache, setCache] = useState<ItemsCache>({});
  const [tab, setTab] = useState<Tab>("vaults");
  const [view, setView] = useState<View>({ kind: "list" });
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);

  const say = useCallback((m: string) => {
    setNotice(m);
    setTimeout(() => setNotice((n) => (n === m ? null : n)), 2500);
  }, []);

  const reloadCache = useCallback(async () => setCache(await loadItemsCache()), []);

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
      if (stored?.tokens) await saveSession(state, stored.tokens);
      setScreen({ kind: "vault", state: { ...state } });
    } catch (e) {
      say(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }, [say]);

  // Les réglages du générateur (localStorage du popup) sont recopiés dans
  // `chrome.storage.local` : le service worker les lit pour « Générer »
  // depuis une page.
  useEffect(() => {
    const mirror = () => {
      try {
        const raw = localStorage.getItem("guivault.generator");
        if (raw) void chrome.storage.local.set({ generator: JSON.parse(raw) });
      } catch {
        // rien à recopier
      }
    };
    mirror();
    window.addEventListener("storage", mirror);
    const t = setInterval(mirror, 2000);
    return () => { window.removeEventListener("storage", mirror); clearInterval(t); };
  }, []);

  useEffect(() => {
    setTokensChangedHandler((t) => { if (t) void saveTokens(t); });
    setSessionLostHandler(() => { void lock("expired").then(() => setScreen({ kind: "login", reason: "expired" })); });
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
        setScreen({ kind: "login", reason: await lockReason() });
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

  const canFill = !!pageUrl && /^https?:/.test(pageUrl);
  const forPage = useMemo(() => (canFill ? entries.filter((e) => loginMatches(e.login, pageUrl!)) : []), [entries, pageUrl, canFill]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchesQuery = (e: LoginEntry) => terms.every((t) => `${e.login.name} ${e.login.username} ${e.login.uris.map((u) => u.uri).join(" ")}`.toLowerCase().includes(t));

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

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // sans stockage, l'état vaut pour cette ouverture
      }
      return next;
    });

  const doLock = async () => {
    await lock("manual");
    setScreen({ kind: "login", reason: "manual" });
  };

  if (!settings || screen.kind === "loading") return <div className="p-4 text-[12px] text-[var(--c-text-muted)]">Chargement…</div>;

  const current = view.kind === "detail" || view.kind === "edit" ? entries.find((e) => e.item.id === view.id) ?? null : null;

  return (
    <div className="flex h-[560px] flex-col bg-[var(--c-bg2)] text-[var(--c-text)]">
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
          reason={screen.reason}
          onSettings={(s) => { setSettings(s); void saveSettings(s); }}
          onSession={async (state, tokens) => {
            await saveSession(state, tokens);
            await clearLockReason();
            await touchLock(settings.lockMinutes);
            setScreen({ kind: "vault", state });
            void sync(state, {});
          }}
        />
      ) : view.kind === "edit" && current ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <LoginForm
            initial={current.login}
            index={indexItems(cache[current.vaultId]?.items ?? [])}
            onSave={async (p) => {
              if (p.kind !== "login") return;
              await saveLogin(current.vaultId, p.login, current.item.revision);
              await reloadCache();
              say(`« ${p.login.name} » enregistré.`);
              setView({ kind: "detail", id: p.login.id });
            }}
            onCancel={() => setView({ kind: "detail", id: current.item.id })}
          />
        </div>
      ) : view.kind === "new" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <label className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-3 py-1.5 text-[12px] text-[var(--c-text-secondary)]">
            Dans le vault
            <select value={view.vaultId} onChange={(e) => setView({ kind: "new", vaultId: e.target.value })} className="input h-6 w-auto text-[12px]" aria-label="Vault">
              {screen.state.vaults.filter((v) => v.role !== "reader").map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <LoginForm
            index={indexItems(cache[view.vaultId]?.items ?? [])}
            onSave={async (p) => {
              if (p.kind !== "login") return;
              if (canFill && p.login.uris.length === 0) p.login.uris = [{ uri: new URL(pageUrl!).origin, match: null }];
              await saveLogin(view.vaultId, p.login);
              await reloadCache();
              say(`« ${p.login.name} » enregistré.`);
              setView({ kind: "detail", id: p.login.id });
            }}
            onCancel={() => setView({ kind: "list" })}
          />
        </div>
      ) : view.kind === "detail" && current ? (
        <Detail
          entry={current}
          canFill={canFill}
          onBack={() => setView({ kind: "list" })}
          onFill={fill}
          onEdit={() => setView({ kind: "edit", id: current.item.id })}
          onDelete={async () => {
            try {
              await deleteLogin(current.vaultId, current.item.id);
              await reloadCache();
              say(`« ${current.login.name} » supprimé.`);
              setView({ kind: "list" });
            } catch (e) {
              say(errorMessage(e));
            }
          }}
          say={say}
        />
      ) : (
        <>
          <nav className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
            {(["vaults", "totp", "generator"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`btn btn-sm ${tab === t ? "btn-toggled" : "btn-ghost"}`}>
                {t === "vaults" ? <><IconVault size={12} /> Vaults</> : t === "totp" ? <><IconShieldClock size={12} /> Codes</> : <><IconDice size={12} /> Générateur</>}
              </button>
            ))}
            {tab === "vaults" && screen.state.vaults.some((v) => v.role !== "reader") && (
              <button onClick={() => setView({ kind: "new", vaultId: (screen.state.vaults.find((v) => v.kind === "personal") ?? screen.state.vaults[0]).id })} className="btn btn-primary btn-sm ml-auto" title="Nouvel identifiant"><IconPlus size={11} /> Nouveau</button>
            )}
          </nav>
          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2">
            {tab === "generator" && <GeneratorPanel compact />}
            {tab === "totp" && <TotpList compact entries={entries.filter((e) => e.login.totp).map((e) => ({ id: e.item.id, vaultName: e.vaultName, login: e.login }))} />}
            {tab === "vaults" && (
              <>
                <div className="relative mb-2">
                  <IconSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher…" aria-label="Rechercher" className="input pl-7" />
                </div>
                {forPage.length > 0 && terms.length === 0 && (
                  <Section id="page" title="Identifiants sur cette page" icon={<IconGlobe size={12} />} count={forPage.length} collapsed={collapsed.has("page")} onToggle={() => toggleCollapsed("page")} accent>
                    {forPage.map((e) => <Row key={e.item.id} entry={e} canFill onFill={fill} onOpen={() => setView({ kind: "detail", id: e.item.id })} say={say} />)}
                  </Section>
                )}
                {screen.state.vaults.map((v) => {
                  const rows = entries.filter((e) => e.vaultId === v.id && matchesQuery(e));
                  if (terms.length && rows.length === 0) return null;
                  return (
                    <Section key={v.id} id={v.id} title={v.name} icon={<IconVault size={12} />} count={rows.length} collapsed={collapsed.has(v.id) && terms.length === 0} onToggle={() => toggleCollapsed(v.id)}>
                      {rows.length === 0 ? <p className="px-2 py-2 text-[11.5px] text-[var(--c-text-muted)]">Aucun identifiant.</p> : rows.map((e) => <Row key={e.item.id} entry={e} canFill={canFill} onFill={fill} onOpen={() => setView({ kind: "detail", id: e.item.id })} say={say} />)}
                    </Section>
                  );
                })}
                {entries.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">Aucun identifiant pour l'instant : « Nouveau », ou enregistrez-en un depuis une page de connexion.</p>}
              </>
            )}
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

/** Une section repliable : « Identifiants sur cette page », ou un vault. */
function Section({ id, title, icon, count, collapsed, onToggle, accent, children }: { id: string; title: string; icon: React.ReactNode; count: number; collapsed: boolean; onToggle: () => void; accent?: boolean; children: React.ReactNode }) {
  return (
    <section className="mb-2" data-section={id}>
      <button onClick={onToggle} aria-expanded={!collapsed} className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.06em] hover:bg-[var(--c-hover)] ${accent ? "text-[var(--c-accent-text)]" : "text-[var(--c-text-muted)]"}`}>
        {collapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
        {icon}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="text-[10px] font-normal text-[var(--c-text-faint)]">{count}</span>
      </button>
      {!collapsed && <div className="mt-0.5">{children}</div>}
    </section>
  );
}

function Row({ entry, canFill, onFill, onOpen, say }: { entry: LoginEntry; canFill: boolean; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; onOpen: () => void; say: (m: string) => void }) {
  const l = entry.login;
  const copy = (label: string, v: string) => () => copyText(v).then((ok) => say(ok ? `${label} copié.` : "Copie refusée par le navigateur."));
  return (
    <div className="list-row mb-0.5 flex-wrap py-1.5">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left" title="Ouvrir">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><IconLogin size={12} /></span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex items-center gap-1 truncate text-[12.5px] font-medium text-[var(--c-text)]">{l.name}{l.favorite && <IconStar size={10} filled className="text-[var(--c-warn)]" />}</span>
          <span className="truncate text-[10.5px] text-[var(--c-text-muted)]">{l.username || "—"}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5">
        {canFill && <button onClick={() => void onFill(entry, "credentials")} className="btn btn-secondary btn-sm" title="Remplir la page">Remplir</button>}
        {l.username && <button onClick={copy("Utilisateur", l.username)} className="btn btn-ghost btn-sm" title="Copier l'utilisateur" aria-label="Copier l'utilisateur">U</button>}
        {l.password && <button onClick={copy("Mot de passe", l.password)} className="btn btn-ghost btn-sm btn-icon" title="Copier le mot de passe" aria-label="Copier le mot de passe"><IconCopy size={11} /></button>}
      </span>
    </div>
  );
}

function Detail({ entry, canFill, onBack, onFill, onEdit, onDelete, say }: { entry: LoginEntry; canFill: boolean; onBack: () => void; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; onEdit: () => void; onDelete: () => Promise<void>; say: (m: string) => void }) {
  const l = entry.login;
  const [confirm, setConfirm] = useState(false);
  const copy = (label: string, v: string) => () => copyText(v).then((ok) => say(ok ? `${label} copié.` : "Copie refusée par le navigateur."));
  const row = (label: string, body: React.ReactNode) => (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-x-2 border-b border-[var(--c-border)] py-1.5">
      <span className="text-[11px] font-medium text-[var(--c-text-secondary)]">{label}</span>
      <span className="min-w-0 break-words text-[12.5px]">{body}</span>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
        <button onClick={onBack} className="btn btn-ghost btn-sm">←</button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{l.name}</span>
        <button onClick={onEdit} className="btn btn-secondary btn-sm" title="Modifier"><IconEdit size={11} /> Modifier</button>
        <button onClick={() => setConfirm(true)} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Supprimer" aria-label="Supprimer"><IconTrash size={11} /></button>
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 py-1">
        {row("Vault", <span className="flex items-center gap-1 text-[var(--c-text-secondary)]"><IconVault size={11} /> {entry.vaultName}</span>)}
        {row("Utilisateur", l.username ? <span className="flex items-center gap-1 font-mono text-[12px]">{l.username}<button onClick={copy("Utilisateur", l.username)} className="btn btn-ghost btn-sm btn-icon" title="Copier" aria-label="Copier l'utilisateur"><IconCopy size={11} /></button></span> : <span className="text-[var(--c-text-muted)]">—</span>)}
        {row("Mot de passe", l.password ? <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><SecretValue value={l.password} /><PasswordStrength password={l.password} /></span> : <span className="text-[var(--c-text-muted)]">—</span>)}
        {l.totp && row("TOTP", <span className="flex items-center gap-2"><TotpCode secret={l.totp} />{canFill && <button onClick={() => void onFill(entry, "totp")} className="btn btn-ghost btn-sm" title="Remplir le code dans la page" aria-label="Remplir le code dans la page">↵</button>}</span>)}
        {l.uris.length > 0 && row(l.uris.length > 1 ? "Sites" : "Site", <span className="flex flex-col gap-0.5">{l.uris.map((u, i) => <a key={i} href={/^[a-z][a-z0-9+.-]*:/i.test(u.uri) ? u.uri : `https://${u.uri}`} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-[11.5px] text-[var(--c-accent-text)] hover:underline">{u.uri}</a>)}</span>)}
        {l.notes && row("Notes", <span className="whitespace-pre-wrap text-[12px]">{l.notes}</span>)}
        {l.passkeys.length > 0 && row("Passkeys", <span className="text-[12px]">{l.passkeys.map((k) => k.rpName || k.rpId).join(", ")}</span>)}
        {canFill && <button onClick={() => void onFill(entry, "credentials")} className="btn btn-primary btn-sm mt-3 w-full">Remplir la page</button>}
      </div>
      {confirm && (
        <div className="shrink-0 border-t border-[var(--c-border)] bg-[var(--c-bg)] p-3">
          <p className="mb-2 text-[12px]">Supprimer « {l.name} » ? Une pierre tombale est laissée pour vos autres appareils.</p>
          <div className="flex justify-end gap-1.5">
            <button onClick={() => setConfirm(false)} className="btn btn-ghost btn-sm">Annuler</button>
            <button onClick={() => void onDelete()} className="btn btn-danger btn-sm">Supprimer</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LoginView({ settings, reason, onSettings, onSession }: { settings: Settings; reason: LockReason | null; onSettings: (s: Settings) => void; onSession: (state: SessionState, tokens: TokenPair) => Promise<void> }) {
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [email, setEmail] = useState(settings.email);
  const [password, setPassword] = useState("");
  const [lockMinutes, setLockMinutes] = useState(settings.lockMinutes);
  const [inlineAutofill, setInlineAutofill] = useState(settings.inlineAutofill);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState<{ verify: (code: string) => Promise<SessionState> } | null>(null);
  const [code, setCode] = useState("");
  const [more, setMore] = useState(!settings.serverUrl);

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
      {reason === "expired" && <p className="callout callout-warn">La session au serveur a expiré ou a été révoquée : reconnectez-vous.</p>}
      {reason === "timeout" && <p className="callout">Verrouillé après inactivité.</p>}
      {more ? (
        <label className="block">
          <span className="field-label">Serveur GuiVault</span>
          <input type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://vault.example.com" required className="input input-mono" />
        </label>
      ) : (
        <p className="flex items-center justify-between text-[11.5px] text-[var(--c-text-muted)]"><span className="truncate font-mono">{serverUrl}</span><button type="button" onClick={() => setMore(true)} className="btn btn-ghost btn-sm">Réglages</button></p>
      )}
      <label className="block">
        <span className="field-label">E-mail</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required className="input" />
      </label>
      <label className="block">
        <span className="field-label">Mot de passe maître</span>
        <PasswordInput value={password} onChange={setPassword} autoFocus={!!settings.email} autoComplete="current-password" />
      </label>
      {more && (
        <>
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
            <span>Proposer le remplissage dans les pages<span className="help-text block">Un bouton GuiVault dans les formulaires de connexion quand le coffre a quelque chose pour le site.</span></span>
          </label>
        </>
      )}
      {error && <p className="callout callout-danger">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <span className="help-text">Déchiffré ici, jamais sur disque.</span>
        <button type="submit" disabled={!serverUrl.trim() || !email.trim() || !password || busy !== null} className="btn btn-primary btn-sm">{busy ?? "Déverrouiller"}</button>
      </div>
    </form>
  );
}
