import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage, setBaseUrl, setSessionLostHandler, setTokensChangedHandler } from "../../src/lib/api";
import { filterEntities, indexItems, toEntities } from "../../src/lib/entities";
import { buildVaultTree } from "../../src/lib/vaultTree";
import { describeSecret } from "../../src/lib/items";
import { acceptRollback, loadItems, login, payloadEntity, payloadName, refresh, setDeviceLabel, type DecodedItem, type SessionState } from "../../src/lib/session";
import { loginMatches } from "../../src/lib/urimatch";
import { KIND_LABELS, KIND_LABELS_PLURAL, type CustomIcon, type GuiVaultEntity, type ItemKind, type Login, type Payload, type TokenPair } from "../../src/lib/types";
import { GeneratorPanel } from "../../src/components/GeneratorPanel";
import { ItemView } from "../../src/components/ItemView";
import { EntityIcon, ItemTree, KIND_ICONS } from "../../src/components/ItemTree";
import { PasswordStrength } from "../../src/components/PasswordStrength";
import { TotpCode } from "../../src/components/TotpCode";
import { TotpList } from "../../src/components/TotpList";
import { ItemForm } from "../../src/components/forms/ItemForm";
import { IconDice, IconGlobe, IconShieldClock, IconStar } from "../../src/components/secret-icons";
import { IconChevronDown, IconChevronRight, IconCopy, IconEdit, IconExternal, IconLock, IconPlus, IconRefresh, IconSearch, IconSettings, IconTrash, IconVault } from "../../src/components/ui-icons";
import { AppearanceSettings, SettingsSyncToggle } from "../../src/components/AppearanceSettings";
import { onSettingsApplied, registerSettingsSection, settingsChanged, startSettingsSync } from "../../src/lib/syncedSettings";
import "../../src/lib/settingsSections";
import { Logo } from "../../src/components/Logo";
import { CLEAR_CHOICES, clipboardHash, loadClearSeconds, saveClearSeconds, setClearScheduler } from "../../src/lib/clipboard";
import { RollbackBanner } from "../../src/components/RollbackBanner";
import { copyText, PasswordInput, SecretValue } from "../../src/components/ui";
import { clearLockReason, lock, lockReason, loadItemsCache, loadPopupState, loadSession, loadSettings, noteRecentFill, parseOtpPatterns, POPUP_STATE_TTL_MS, saveItemsCache, savePopupState, saveSession, saveSettings, saveTokens, touchLock, type ItemsCache, type LockReason, type PopupView, type Settings } from "./store";
import { deleteItem, saveLogin, savePayload } from "./vaultops";
import type { PopupToBackground } from "./messages";

/** Les entrées du menu « Nouveau » : les secrets d'abord, puis les entités
 * Guiterm — le même menu que l'interface web. */
const NEW_KINDS: (ItemKind | "sep")[] = ["login", "note", "card", "identity", "api-key", "aws", "sep", "host", "group", "sql-connection", "key", "snippet", "runbook", "icon"];
type Filter = "all" | ItemKind;
const FILTERS: Filter[] = ["all", "login", "note", "card", "identity", "api-key", "aws", "host", "sql-connection", "key", "snippet", "runbook", "group", "icon"];

setDeviceLabel("Extension GuiVault");

// Ce qui, des réglages de l'extension, suit le compte : le remplissage et
// les codes. Le serveur, l'e-mail et le délai de verrouillage restent ici.
// Le popup se ferme au premier clic ailleurs, et ses minuteries avec :
// l'effacement du presse-papiers est confié au service worker, qui n'en
// garde que l'empreinte.
setClearScheduler((value, delayMs) => {
  void chrome.runtime.sendMessage<PopupToBackground>({ type: "guivault-clipboard-clear", hash: clipboardHash(value), delayMs }).catch(() => {});
});

registerSettingsSection({
  key: "extension",
  read: async () => {
    const s = await loadSettings();
    return { inlineAutofill: s.inlineAutofill, autoTotp: s.autoTotp, otpPatterns: s.otpPatterns };
  },
  write: async (v) => {
    if (!v || typeof v !== "object") return;
    const r = v as Partial<Settings>;
    const s = await loadSettings();
    await saveSettings({
      ...s,
      inlineAutofill: typeof r.inlineAutofill === "boolean" ? r.inlineAutofill : s.inlineAutofill,
      autoTotp: typeof r.autoTotp === "boolean" ? r.autoTotp : s.autoTotp,
      otpPatterns: typeof r.otpPatterns === "string" ? r.otpPatterns : s.otpPatterns,
    });
  },
});

type Screen = { kind: "loading" } | { kind: "login"; reason: LockReason | null } | { kind: "vault"; state: SessionState };
type Tab = "vaults" | "totp" | "generator";
type View = PopupView;

/** Un item déchiffré, avec son vault. */
interface Entry {
  vaultId: string;
  vaultName: string;
  item: DecodedItem & { ok: true };
  payload: Payload;
  name: string;
  subtitle: string;
  search: string;
  /** La même description que l'arborescence de l'interface web : icône
   * choisie, genre d'hôte, moteur, tags. */
  entity: GuiVaultEntity;
  /** Les icônes du vault, pour dessiner celle d'un hôte ou d'un dossier. */
  customIcons: CustomIcon[];
}

interface LoginEntry extends Entry {
  login: Login;
}

function isLoginEntry(e: Entry): e is LoginEntry {
  return e.payload.kind === "login";
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
  const [filter, setFilter] = useState<Filter>("all");
  const [newMenu, setNewMenu] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  // Le formulaire en cours, repris à la réouverture : `seed` est celui qu'on
  // rend au formulaire (une fois), `draft` le dernier capturé.
  const [draft, setDraft] = useState<Payload | null>(null);
  const [seed, setSeed] = useState<Payload | null>(null);
  const [restored, setRestored] = useState(false);

  /** Changer d'écran oublie le brouillon du précédent. */
  const go = useCallback((v: View) => {
    setView(v);
    setDraft(null);
    setSeed(null);
  }, []);

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
      // Rouvrir là où l'on était : un formulaire commencé toujours, le reste
      // s'il n'y a pas trop longtemps.
      const ps = await loadPopupState();
      if (ps) {
        const fresh = Date.now() - ps.at < POPUP_STATE_TTL_MS;
        if (ps.draft && (ps.view.kind === "new" || ps.view.kind === "edit")) {
          setView(ps.view);
          setDraft(ps.draft);
          setSeed(ps.draft);
        } else if (fresh) setView(ps.view);
        if (fresh) {
          setTab(ps.tab);
          setQuery(ps.query);
          setFilter(ps.filter as Filter);
        }
      }
      setRestored(true);
      setScreen({ kind: "vault", state: restored.state });
      void startSettingsSync(restored.state.account.userKey);
      await touchLock(s.lockMinutes);
      void sync(restored.state, cached);
    })();
    return () => {
      setTokensChangedHandler(null);
      setSessionLostHandler(null);
    };
  }, [sync]);

  // Réglages de l'extension reçus d'un autre appareil.
  useEffect(() => onSettingsApplied(() => void loadSettings().then(setSettings)), []);

  useEffect(() => {
    if (!restored) return;
    void savePopupState({ tab, view, query, filter, draft: view.kind === "new" || view.kind === "edit" ? draft : null, at: Date.now() });
  }, [restored, tab, view, query, filter, draft]);

  const entries = useMemo<Entry[]>(() => {
    if (screen.kind !== "vault") return [];
    const out: Entry[] = [];
    for (const v of screen.state.vaults) {
      const items = cache[v.id]?.items ?? [];
      const entities = new Map(toEntities(items).map((e) => [e.id, e]));
      const customIcons = indexItems(items).icons;
      for (const it of items) {
        if (!it.ok) continue;
        const p = it.payload;
        const { search } = describeSecret(p);
        const entity = entities.get(it.id)!;
        const sub = entity.subtitle ?? (p.kind === "key" ? p.key.path : "");
        const base: Entry = { vaultId: v.id, vaultName: v.name, item: it, payload: p, name: payloadName(p) || "(sans nom)", subtitle: sub, search: `${search} ${sub}`, entity, customIcons };
        const entry: Entry = p.kind === "login" ? ({ ...base, login: p.login } as LoginEntry) : base;
        out.push(entry);
      }
    }
    return out.sort((a, b) => Number(!!payloadEntity(b.payload).favorite) - Number(!!payloadEntity(a.payload).favorite) || a.name.localeCompare(b.name));
  }, [screen, cache]);
  const logins = useMemo(() => entries.filter(isLoginEntry), [entries]);
  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: entries.length };
    for (const e of entries) c[e.payload.kind] = (c[e.payload.kind] ?? 0) + 1;
    return c;
  }, [entries]);

  const canFill = !!pageUrl && /^https?:/.test(pageUrl);
  const forPage = useMemo(() => (canFill ? logins.filter((e) => loginMatches(e.login, pageUrl!)) : []), [logins, pageUrl, canFill]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const fill = async (e: LoginEntry, what: "credentials" | "totp") => {
    if (tabId == null) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      const msg = what === "totp" ? { type: "guivault-fill", totp: e.login.totp ? await currentTotp(e.login.totp) : "" } : { type: "guivault-fill", username: e.login.username, password: e.login.password };
      const r = (await chrome.tabs.sendMessage(tabId, msg)) as { username: boolean; password: boolean; totp: boolean } | undefined;
      if (!r) say("Pas de réponse de la page.");
      else if (what === "totp") say(r.totp ? "Code rempli." : "Aucun champ de code trouvé.");
      else say(r.password ? (r.username ? "Rempli." : "Mot de passe rempli (utilisateur non trouvé).") : r.username ? "Utilisateur rempli (pas de champ mot de passe)." : "Aucun champ de connexion trouvé sur cette page.");
      if (r?.password || r?.username) void noteRecentFill(tabId, e.login.id);
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
    go({ kind: "list" });
    setScreen({ kind: "login", reason: "manual" });
  };

  if (!settings || screen.kind === "loading") return <div className="p-4 text-[12px] text-[var(--c-text-muted)]">Chargement…</div>;

  const current = view.kind === "detail" || view.kind === "edit" ? entries.find((e) => e.item.id === view.id) ?? null : null;
  const indexFor = (vaultId: string) => indexItems(cache[vaultId]?.items ?? []);

  return (
    <div className="flex h-[600px] flex-col bg-[var(--c-bg2)] text-[var(--c-text)]">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] bg-[var(--c-bg)] px-3 py-2">
        {/* Le logo grise quand le coffre est verrouillé — comme l'icône de
            l'extension dans la barre du navigateur. */}
        <Logo size={22} locked={screen.kind !== "vault"} />
        <span className="text-[13px] font-semibold">GuiVault</span>
        <span className="ml-auto flex items-center gap-0.5">
          {screen.kind === "vault" && (
            <>
              <button onClick={() => void sync(screen.state, cache)} className="btn btn-ghost btn-sm btn-icon" title="Rafraîchir" aria-label="Rafraîchir"><IconRefresh size={12} className={refreshing ? "animate-spin" : ""} /></button>
              <a href={settings.serverUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm btn-icon" title="Ouvrir le coffre (interface web)" aria-label="Ouvrir le coffre"><IconExternal size={12} /></a>
              <button onClick={() => go(view.kind === "settings" ? { kind: "list" } : { kind: "settings" })} className={`btn btn-sm btn-icon ${view.kind === "settings" ? "btn-toggled" : "btn-ghost"}`} title="Réglages" aria-label="Réglages" aria-pressed={view.kind === "settings"}><IconSettings size={12} /></button>
              <button onClick={() => void doLock()} className="btn btn-ghost btn-sm btn-icon" title="Verrouiller" aria-label="Verrouiller"><IconLock size={12} /></button>
            </>
          )}
        </span>
      </header>
      {screen.kind === "vault" && (
        <RollbackBanner compact rollbacks={screen.state.rollbacks} onAccept={(id) => { acceptRollback(screen.state, id); setScreen({ kind: "vault", state: { ...screen.state } }); }} />
      )}

      {screen.kind === "login" ? (
        <LoginView
          settings={settings}
          reason={screen.reason}
          onSettings={(s) => { setSettings(s); void saveSettings(s); }}
          onSession={async (state, tokens) => {
            await saveSession(state, tokens);
            await clearLockReason();
            await touchLock(settings.lockMinutes);
            setRestored(true);
            setScreen({ kind: "vault", state });
            void startSettingsSync(state.account.userKey);
            void sync(state, {});
          }}
        />
      ) : view.kind === "settings" ? (
        <SettingsView settings={settings} onSettings={(s) => { setSettings(s); void saveSettings(s).then(() => settingsChanged("extension")); void touchLock(s.lockMinutes); }} onBack={() => go({ kind: "list" })} />
      ) : view.kind === "edit" && current ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ItemForm
            kind={current.payload.kind}
            initial={current.payload}
            draft={seed ?? undefined}
            onDraft={setDraft}
            index={indexFor(current.vaultId)}
            onSave={async (p) => {
              await savePayload(current.vaultId, p, current.item.revision);
              await reloadCache();
              say(`« ${payloadName(p)} » enregistré.`);
              go({ kind: "detail", id: payloadEntity(p).id });
            }}
            onCancel={() => go({ kind: "detail", id: current.item.id })}
          />
        </div>
      ) : view.kind === "new" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <label className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-3 py-1.5 text-[12px] text-[var(--c-text-secondary)]">
            {KIND_LABELS_PLURAL[view.itemKind].replace(/s$/, "")} dans
            <select value={view.vaultId} onChange={(e) => { setView({ ...view, vaultId: e.target.value }); setSeed(draft); }} className="input h-6 w-auto text-[12px]" aria-label="Vault">
              {screen.state.vaults.filter((v) => v.role !== "reader").map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <ItemForm
            key={`${view.vaultId}-${view.itemKind}`}
            kind={view.itemKind}
            draft={seed ?? undefined}
            onDraft={setDraft}
            index={indexFor(view.vaultId)}
            onSave={async (p) => {
              if (p.kind === "login" && canFill && p.login.uris.length === 0) p.login.uris = [{ uri: new URL(pageUrl!).origin, match: null }];
              await savePayload(view.vaultId, p);
              await reloadCache();
              say(`« ${payloadName(p)} » enregistré.`);
              go({ kind: "detail", id: payloadEntity(p).id });
            }}
            onCancel={() => go({ kind: "list" })}
          />
        </div>
      ) : view.kind === "detail" && current ? (
        <Detail
          entry={current}
          index={indexFor(current.vaultId)}
          canFill={canFill}
          onBack={() => go({ kind: "list" })}
          onFill={fill}
          onEdit={() => go({ kind: "edit", id: current.item.id })}
          onDelete={async () => {
            try {
              await deleteItem(current.vaultId, current.item.id);
              await reloadCache();
              say(`« ${current.name} » supprimé.`);
              go({ kind: "list" });
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
              <div className="relative ml-auto">
                <button onClick={() => setNewMenu((m) => !m)} className="btn btn-primary btn-sm" aria-haspopup="menu" aria-expanded={newMenu}><IconPlus size={11} /> Nouveau <IconChevronDown size={10} /></button>
                {newMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setNewMenu(false)} />
                    <div className="popover absolute right-0 z-20 mt-1 w-44 py-1" role="menu">
                      {NEW_KINDS.map((k, i) => {
                        if (k === "sep") return <div key={i} className="menu-sep" />;
                        const Icon = KIND_ICONS[k];
                        return (
                          <button key={k} role="menuitem" onClick={() => { setNewMenu(false); go({ kind: "new", itemKind: k, vaultId: (screen.state.vaults.find((v) => v.kind === "personal") ?? screen.state.vaults[0]).id }); }} className="menu-item">
                            <Icon size={13} /> {KIND_LABELS[k].charAt(0).toUpperCase() + KIND_LABELS[k].slice(1)}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </nav>
          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2">
            {tab === "generator" && <GeneratorPanel compact />}
            {tab === "totp" && (
              <TotpList
                compact
                entries={logins.filter((e) => e.login.totp).map((e) => ({ id: e.item.id, vaultId: e.vaultId, vaultName: e.vaultName, login: e.login, revision: e.item.revision }))}
                onRemove={async (e) => {
                  try {
                    await saveLogin(e.vaultId, { ...e.login, totp: null }, e.revision);
                    await reloadCache();
                    say(`Code de « ${e.login.name} » retiré.`);
                  } catch (err) {
                    say(errorMessage(err));
                  }
                }}
              />
            )}
            {tab === "vaults" && (
              <>
                <div className="relative mb-1.5">
                  <IconSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher…" aria-label="Rechercher" className="input pl-7" />
                </div>
                {entries.some((e) => e.payload.kind !== "login") && (
                  <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Type d'élément">
                    {FILTERS.filter((f) => f === "all" || (counts[f] ?? 0) > 0).map((f) => (
                      <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`btn btn-sm shrink-0 ${filter === f ? "btn-toggled" : "btn-ghost"}`}>
                        {f === "all" ? "Tout" : KIND_LABELS_PLURAL[f]}<span className="text-[10px] text-[var(--c-text-faint)]">{counts[f]}</span>
                      </button>
                    ))}
                  </div>
                )}
                {forPage.length > 0 && terms.length === 0 && filter === "all" && (
                  <Section id="page" title="Identifiants sur cette page" icon={<IconGlobe size={12} />} count={forPage.length} collapsed={collapsed.has("page")} onToggle={() => toggleCollapsed("page")} accent>
                    {forPage.map((e) => <Row key={e.item.id} entry={e} canFill onFill={fill} onOpen={() => go({ kind: "detail", id: e.item.id })} say={say} />)}
                  </Section>
                )}
                {screen.state.vaults.map((v) => {
                  // Le contenu du vault dans son arborescence — la même que
                  // l'interface web, dossiers compris, sans ceux que le
                  // filtre de type laisserait vides.
                  const mine = entries.filter((e) => e.vaultId === v.id);
                  const all = mine.map((e) => e.entity);
                  const ents = filter === "all" ? all : filter === "group" ? all.filter((e) => e.kind === "group") : filterEntities(all, (e) => e.kind === filter);
                  const shown = new Set(buildVaultTree(ents, query).visibleKeys);
                  const count = ents.filter((e) => e.kind !== "group" && shown.has(e.id)).length;
                  if (terms.length && count === 0) return null;
                  return (
                    <Section key={v.id} id={v.id} title={v.name} icon={<IconVault size={12} />} count={count} collapsed={collapsed.has(v.id) && terms.length === 0} onToggle={() => toggleCollapsed(v.id)}>
                      <ItemTree
                        entities={ents}
                        customIcons={mine[0]?.customIcons ?? []}
                        query={query}
                        selected={null}
                        onSelect={(id) => go({ kind: "detail", id })}
                        emptyMessage="Rien ici."
                        rowActions={(entity) => {
                          const e = mine.find((x) => x.item.id === entity.id);
                          return e && isLoginEntry(e) ? <LoginActions entry={e} canFill={canFill} onFill={fill} say={say} /> : null;
                        }}
                      />
                    </Section>
                  );
                })}
                {entries.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">Rien pour l'instant : « Nouveau », ou enregistrez un identifiant depuis une page de connexion.</p>}
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

function Row({ entry, canFill, onFill, onOpen, say }: { entry: Entry; canFill: boolean; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; onOpen: () => void; say: (m: string) => void }) {
  const favorite = !!payloadEntity(entry.payload).favorite;
  const { entity } = entry;
  return (
    <div className="list-row mb-0.5 flex-wrap py-1.5">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={`Ouvrir (${KIND_LABELS[entry.payload.kind]})`}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)] [&>.host-icon]:h-[72%] [&>.host-icon]:w-[72%] [&>.host-icon>*]:h-full [&>.host-icon>*]:w-full"><EntityIcon entity={entity} customIcons={entry.customIcons} size={12} /></span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex items-center gap-1 truncate text-[12.5px] font-medium text-[var(--c-text)]">{entry.name}{favorite && <IconStar size={10} filled className="text-[var(--c-warn)]" />}{entity.badge && <span className="tag">{entity.badge}</span>}</span>
          <span className={`truncate text-[10.5px] text-[var(--c-text-muted)] ${entity.mono && entry.subtitle ? "font-mono" : ""}`}>{entry.subtitle || KIND_LABELS[entry.payload.kind]}</span>
        </span>
      </button>
      {isLoginEntry(entry) && <span className="flex shrink-0 items-center gap-0.5"><LoginActions entry={entry} canFill={canFill} onFill={onFill} say={say} /></span>}
    </div>
  );
}

/** Remplir, copier l'utilisateur, copier le mot de passe — sur une ligne
 * d'identifiant, où qu'elle soit. */
function LoginActions({ entry, canFill, onFill, say }: { entry: LoginEntry; canFill: boolean; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; say: (m: string) => void }) {
  const copy = (label: string, v: string) => () => copyText(v).then((ok) => say(ok ? `${label} copié.` : "Copie refusée par le navigateur."));
  return (
    <>
      {canFill && <button onClick={() => void onFill(entry, "credentials")} className="btn btn-secondary btn-sm" title="Remplir la page">Remplir</button>}
      {entry.login.username && <button onClick={copy("Utilisateur", entry.login.username)} className="btn btn-ghost btn-sm" title="Copier l'utilisateur" aria-label="Copier l'utilisateur">U</button>}
      {entry.login.password && <button onClick={copy("Mot de passe", entry.login.password)} className="btn btn-ghost btn-sm btn-icon" title="Copier le mot de passe" aria-label="Copier le mot de passe"><IconCopy size={11} /></button>}
    </>
  );
}

function Detail({ entry, index, canFill, onBack, onFill, onEdit, onDelete, say }: { entry: Entry; index: ReturnType<typeof indexItems>; canFill: boolean; onBack: () => void; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; onEdit: () => void; onDelete: () => Promise<void>; say: (m: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const header = (
    <div className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
      <button onClick={onBack} className="btn btn-ghost btn-sm">←</button>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{entry.name}</span>
      <button onClick={onEdit} className="btn btn-secondary btn-sm" title="Modifier"><IconEdit size={11} /> Modifier</button>
      <button onClick={() => setConfirm(true)} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Supprimer" aria-label="Supprimer"><IconTrash size={11} /></button>
    </div>
  );
  const confirmBox = confirm && (
    <div className="shrink-0 border-t border-[var(--c-border)] bg-[var(--c-bg)] p-3">
      <p className="mb-2 text-[12px]">Supprimer « {entry.name} » ? Une pierre tombale est laissée pour vos autres appareils.</p>
      <div className="flex justify-end gap-1.5">
        <button onClick={() => setConfirm(false)} className="btn btn-ghost btn-sm">Annuler</button>
        <button onClick={() => void onDelete()} className="btn btn-danger btn-sm">Supprimer</button>
      </div>
    </div>
  );
  if (!isLoginEntry(entry)) {
    // Les autres types : la fiche de l'interface web, telle quelle.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <p className="mb-2 flex items-center gap-1 text-[11px] text-[var(--c-text-muted)]"><IconVault size={11} /> {entry.vaultName} · {KIND_LABELS[entry.payload.kind]}</p>
          <ItemView payload={entry.payload} index={index} />
        </div>
        {confirmBox}
      </div>
    );
  }
  const l = entry.login;
  const copy = (label: string, v: string) => () => copyText(v).then((ok) => say(ok ? `${label} copié.` : "Copie refusée par le navigateur."));
  const row = (label: string, body: React.ReactNode) => (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-x-2 border-b border-[var(--c-border)] py-1.5">
      <span className="text-[11px] font-medium text-[var(--c-text-secondary)]">{label}</span>
      <span className="min-w-0 break-words text-[12.5px]">{body}</span>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
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
      {confirmBox}
    </div>
  );
}

/** Les réglages, une fois connecté : le verrouillage et le remplissage
 * (les mêmes que sous « Réglages » à la connexion), et l'apparence — la
 * même page que dans l'interface web et dans Guiterm, en une colonne. */
function SettingsView({ settings, onSettings, onBack }: { settings: Settings; onSettings: (s: Settings) => void; onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-2 py-1.5">
        <button onClick={onBack} className="btn btn-ghost btn-sm" aria-label="Retour">←</button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">Réglages</span>
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <section className="space-y-2">
          <p className="eyebrow">Extension</p>
          <p className="flex items-center justify-between gap-2 text-[11.5px] text-[var(--c-text-muted)]"><span>Serveur</span><span className="truncate font-mono">{settings.serverUrl}</span></p>
          <label className="block">
            <span className="field-label">Verrouiller après</span>
            <select value={settings.lockMinutes} onChange={(e) => onSettings({ ...settings, lockMinutes: Number(e.target.value) })} className="input">
              <option value={5}>5 minutes d'inactivité</option>
              <option value={15}>15 minutes d'inactivité</option>
              <option value={60}>1 heure d'inactivité</option>
              <option value={480}>8 heures d'inactivité</option>
              <option value={0}>À la fermeture du navigateur</option>
            </select>
          </label>
          <ClipboardSelect />
          <label className="flex cursor-pointer items-start gap-2 text-[12.5px]">
            <input type="checkbox" checked={settings.inlineAutofill} onChange={(e) => onSettings({ ...settings, inlineAutofill: e.target.checked })} className="mt-0.5" />
            <span>Proposer le remplissage dans les pages<span className="help-text block">Un bouton GuiVault dans les formulaires de connexion quand le coffre a quelque chose pour le site.</span></span>
          </label>
        </section>
        <OtpSettings settings={settings} onSettings={onSettings} />
        <SettingsSyncToggle />
        <AppearanceSettings compact />
      </div>
    </div>
  );
}

/** Les codes à usage unique (TOTP) : remplissage automatique, et motifs
 * pour les champs que la détection ne reconnaît pas. */
function OtpSettings({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const [text, setText] = useState(settings.otpPatterns);
  const { errors } = useMemo(() => parseOtpPatterns(text), [text]);
  return (
    <section className="space-y-2">
      <p className="eyebrow">Codes à usage unique</p>
      <label className="flex cursor-pointer items-start gap-2 text-[12.5px]">
        <input type="checkbox" checked={settings.autoTotp} onChange={(e) => onSettings({ ...settings, autoTotp: e.target.checked })} className="mt-0.5" />
        <span>Remplir le code tout seul<span className="help-text block">Quand une page demande un code et qu'un seul identifiant du site a un secret TOTP. Sinon, le bouton GuiVault du champ propose les codes.</span></span>
      </label>
      <label className="block">
        <span className="field-label">Champs de code supplémentaires</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => { if (text !== settings.otpPatterns) onSettings({ ...settings, otpPatterns: text }); }}
          rows={3}
          spellCheck={false}
          placeholder={"verif_code\nsso\\.exemple\\.fr => ^pin$"}
          className="input input-mono h-auto py-1.5 text-[11.5px]"
        />
      </label>
      <p className="help-text">Une regex par ligne, comparée au nom, à l'id, au libellé et au texte d'aide du champ ; <span className="kbd">regex d'URL =&gt; regex de champ</span> pour la limiter à certaines pages. Les champs <span className="kbd">autocomplete="one-time-code"</span>, « code de vérification », « 2FA », « OTP »… sont reconnus d'office, de même que les codes en cases séparées.</p>
      {errors.length > 0 && <p className="callout callout-warn">Ligne{errors.length > 1 ? "s" : ""} {errors.join(", ")} : regex invalide, ignorée.</p>}
    </section>
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
      onSettings({ ...settings, serverUrl: url, email: email.trim().toLowerCase(), lockMinutes, inlineAutofill });
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

/** Le délai d'effacement du presse-papiers : un réglage qui suit le compte,
 * le même que dans l'interface web (`lib/clipboard.ts`). */
function ClipboardSelect() {
  const [seconds, setSeconds] = useState(loadClearSeconds);
  return (
    <label className="block">
      <span className="field-label">Effacer ce que GuiVault copie</span>
      <select value={seconds} onChange={(e) => { const n = Number(e.target.value); setSeconds(n); saveClearSeconds(n); }} className="input">
        {CLEAR_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.value === 0 ? c.label : `Après ${c.label}`}</option>)}
      </select>
      <span className="help-text block">S'il est encore dans le presse-papiers : ce que vous avez copié ailleurs entre-temps n'est pas touché.</span>
    </label>
  );
}
