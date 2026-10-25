import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage, setBaseUrl, setSessionLostHandler, setTokensChangedHandler } from "../../src/lib/api";
import { filterEntities, indexItems, toEntities } from "../../src/lib/entities";
import { buildVaultTree } from "../../src/lib/vaultTree";
import { describeSecret, isSecret, uriHost } from "../../src/lib/items";
import { openOffline, acceptIntegrity, acceptRollback, closeLocal, loadItems, login, openLocal, payloadEntity, payloadName, refresh, setDeviceLabel, type DecodedItem, type SessionState, type VaultView } from "../../src/lib/session";
import { applyBackend } from "./backend";
import { coffreLabel, knownCoffres, nativeCoffre } from "./nativeHost";
import { loginMatches } from "../../src/lib/urimatch";
import { canWrite, KIND_LABELS, KIND_LABELS_PLURAL, type CustomIcon, type GuiVaultEntity, type ItemKind, type Login, type Payload, type TokenPair } from "../../src/lib/types";
import { GeneratorPanel } from "../../src/components/GeneratorPanel";
import { ItemView } from "../../src/components/ItemView";
import { ItemTile, ItemTree, KIND_ICONS } from "../../src/components/ItemTree";
import { TotpCode } from "../../src/components/TotpCode";
import { TotpList } from "../../src/components/TotpList";
import { ItemForm } from "../../src/components/forms/ItemForm";
import { IconGlobe, IconIdentity } from "../../src/components/secret-icons";
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconEdit, IconExternal, IconLock, IconPlus, IconRefresh, IconSearch, IconSettings, IconTrash } from "../../src/components/ui-icons";
import { useVaultColors, vaultColor } from "../../src/lib/vaultColors";
import { personInitials } from "../../src/lib/tiles";
import { AppearanceSettings, SettingsSyncToggle } from "../../src/components/AppearanceSettings";
import { onSettingsApplied, registerSettingsSection, settingsChanged, startSettingsSync } from "../../src/lib/syncedSettings";
import "../../src/lib/settingsSections";
import { Logo } from "../../src/components/Logo";
import { CLEAR_CHOICES, clipboardHash, loadClearSeconds, saveClearSeconds, setClearScheduler } from "../../src/lib/clipboard";
import { IntegrityBanner } from "../../src/components/IntegrityBanner";
import { RollbackBanner } from "../../src/components/RollbackBanner";
import { useMerge } from "../../src/components/MergeDialog";
import { AttachmentsPanel } from "../../src/components/AttachmentsPanel";
import { RepromptContext, useReprompt, useRepromptHost } from "../../src/components/Reprompt";
import { needsReprompt } from "../../src/lib/reprompt";
import { OfflineSetting } from "../../src/components/OfflineSetting";
import { loadOfflineCopy, refreshOfflineCopy, type OfflineCopy } from "../../src/lib/offline";
import { copyText, formatAgo, InfoTip, PasswordInput, SettingRow } from "../../src/components/ui";
import { clearLockReason, lock, lockReason, loadItemsCache, loadPopupState, loadSession, loadSettings, parseOtpPatterns, POPUP_STATE_TTL_MS, saveItemsCache, savePopupState, saveSession, saveSettings, saveTokens, touchLock, type ItemsCache, type LockReason, type PopupView, type Settings } from "./store";
import { deleteItem, saveLogin, savePayload } from "./vaultops";
import type { FillTabReply, PopupToBackground } from "./messages";

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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
      if (state.offline) {
        // Hors ligne : rien vers le serveur. Le cache d'items vient de la
        // copie à l'ouverture (`openOffline`), puis reste tel quel — c'est
        // lui que le service worker lit pour remplir les pages.
        const next: ItemsCache = { ...current };
        for (const v of state.vaults) {
          if (!next[v.id]) next[v.id] = await loadItems(v).then((p) => ({ revision: p.revision, items: p.items, problems: p.problems }));
        }
        setCache(next);
        await saveItemsCache(next);
        setScreen({ kind: "vault", state: { ...state } });
        return;
      }
      await refresh(state);
      const next: ItemsCache = {};
      for (const v of state.vaults) {
        const c = current[v.id];
        next[v.id] = c && c.revision === v.revision ? c : await loadItems(v).then((p) => ({ revision: p.revision, items: p.items, problems: p.problems }));
      }
      setCache(next);
      await saveItemsCache(next);
      const stored = (await chrome.storage.session.get("session")).session as { tokens?: TokenPair } | undefined;
      if (stored?.tokens) await saveSession(state, stored.tokens);
      setScreen({ kind: "vault", state: { ...state } });
      // La copie hors ligne, si elle est activée dans ce navigateur, suit.
      void refreshOfflineCopy(state).catch(() => {});
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
      // Le serveur, ou le coffre local par l'hôte natif.
      applyBackend(restored.state, s);
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
      if (!restored.state.offline) void startSettingsSync(restored.state.account.userKey);
      await touchLock(s.lockMinutes);
      void sync(restored.state, cached);
    })();
    return () => {
      setTokensChangedHandler(null);
      setSessionLostHandler(null);
    };
  }, [sync]);

  useEffect(() => {
    if (!newMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNewMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newMenu]);

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
  const pageHost = useMemo(() => { try { return pageUrl ? new URL(pageUrl).hostname.replace(/^www\./, "") : ""; } catch { return ""; } }, [pageUrl]);
  const colors = useVaultColors();

  /** Le seul formulaire est dans un cadre servi par un autre site que
   * l'identifiant : on demande avant d'y mettre un mot de passe. */
  const [frameConfirm, setFrameConfirm] = useState<{ entry: LoginEntry; what: "credentials" | "totp"; frameId: number; host: string } | null>(null);
  // Un identifiant protégé (`reprompt`) : le mot de passe maître avant de le
  // remplir ou de le montrer — le menu de la page, lui, n'en reçoit rien.
  const [ask, repromptDialog] = useRepromptHost(screen.kind === "vault" ? screen.state : null);

  /** Le service worker choisit le cadre où remplir (jamais tous : un cadre
   * tiers n'a pas à recevoir le mot de passe du site). */
  const fill = async (e: LoginEntry, what: "credentials" | "totp", frameId?: number) => {
    if (tabId == null) return;
    if (!(await ask({ kind: "login", login: e.login }))) return;
    try {
      const r = await chrome.runtime.sendMessage<PopupToBackground, FillTabReply>({ type: "guivault-fill-tab", tabId, loginId: e.login.id, what, frameId });
      if (!r) return say("Pas de réponse de la page.");
      if (!r.ok) {
        if (r.reason === "confirm") return setFrameConfirm({ entry: e, what, frameId: r.frameId, host: r.frameHost });
        return say(r.reason === "locked" ? "GuiVault est verrouillé." : r.reason === "no-page" ? "Impossible de remplir sur cette page." : r.reason === "not-found" ? "Identifiant introuvable." : what === "totp" ? "Aucun champ de code trouvé." : "Aucun champ de connexion trouvé sur cette page.");
      }
      const f = r.filled;
      if (what === "totp") say(f.totp ? "Code rempli." : "Aucun champ de code trouvé.");
      else say(f.password ? (f.username ? "Rempli." : "Mot de passe rempli (utilisateur non trouvé).") : f.username ? "Utilisateur rempli (pas de champ mot de passe)." : "Aucun champ de connexion trouvé sur cette page.");
      if (f.password || f.username || f.totp) window.close();
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
    // Un coffre local : `api` revient au serveur.
    await closeLocal();
    go({ kind: "list" });
    setScreen({ kind: "login", reason: "manual" });
  };

  // Modifier un élément qui a changé entre-temps : la fusion champ par
  // champ, comme sur la page du vault (`useMerge`).
  const editing = view.kind === "edit" ? entries.find((e) => e.item.id === view.id) ?? null : null;
  const editingIndex = useMemo(() => indexItems(editing ? cache[editing.vaultId]?.items ?? [] : []), [editing, cache]);
  const merging = useMerge({
    vault: screen.kind === "vault" && editing ? screen.state.vaults.find((v) => v.id === editing.vaultId) : undefined,
    index: editingIndex,
    write: async (p, revision) => {
      if (editing) await savePayload(editing.vaultId, p, revision);
    },
    done: async (p, message) => {
      await reloadCache();
      say(message);
      go({ kind: "detail", id: payloadEntity(p).id });
    },
    discard: () => {
      void reloadCache();
      if (editing) go({ kind: "detail", id: editing.item.id });
    },
  });

  if (!settings || screen.kind === "loading") return <div className="p-4 text-[12px] text-[var(--c-text-muted)]">Chargement…</div>;

  /** Prendre acte d'un écart au manifeste, puis relire le vault. */
  const acceptProblems = async (vault: VaultView) => {
    try {
      await acceptIntegrity(vault);
      const p = await loadItems(vault);
      const next: ItemsCache = { ...(await loadItemsCache()), [vault.id]: { revision: p.revision, items: p.items, problems: p.problems } };
      setCache(next);
      await saveItemsCache(next);
    } catch (e) {
      say(errorMessage(e));
    }
  };

  const current = view.kind === "detail" || view.kind === "edit" ? entries.find((e) => e.item.id === view.id) ?? null : null;
  const indexFor = (vaultId: string) => indexItems(cache[vaultId]?.items ?? []);

  return (
    <RepromptContext.Provider value={ask}>
    <div className="relative flex h-[600px] flex-col bg-[var(--c-bg2)] text-[var(--c-text)]">
      <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-[var(--c-border)] pl-3.5 pr-2">
        {/* Le logo grise quand le coffre est verrouillé — comme l'icône de
            l'extension dans la barre du navigateur. */}
        <Logo size={24} locked={screen.kind !== "vault"} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">GuiVault</span>
        {screen.kind === "vault" ? (
          <span className="flex items-center">
            <button onClick={() => void sync(screen.state, cache)} className="btn btn-ghost btn-icon" title="Rafraîchir" aria-label="Rafraîchir"><IconRefresh size={15} className={refreshing ? "animate-spin" : ""} /></button>
            {!screen.state.local && <a href={settings.serverUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-icon" title="Ouvrir le coffre (interface web)" aria-label="Ouvrir le coffre"><IconExternal size={15} /></a>}
            <button onClick={() => go(view.kind === "settings" ? { kind: "list" } : { kind: "settings" })} className={`btn btn-icon ${view.kind === "settings" ? "btn-toggled" : "btn-ghost"}`} title="Réglages" aria-label="Réglages" aria-pressed={view.kind === "settings"}><IconSettings size={15} /></button>
            <button onClick={() => void doLock()} className="btn btn-ghost btn-icon" title="Verrouiller" aria-label="Verrouiller"><IconLock size={15} /></button>
          </span>
        ) : screen.kind === "login" && <span className="tag">Verrouillé</span>}
      </header>
      {screen.kind === "vault" && screen.state.offline && (
        <div role="status" className="shrink-0 px-3.5 pt-2.5">
          <div className="callout callout-warn flex items-center gap-2 py-2">
            <span className="min-w-0 flex-1 truncate">Hors ligne · copie du {new Date(screen.state.offline.savedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
            <button onClick={() => void doLock()} className="btn btn-secondary btn-sm shrink-0">Se reconnecter</button>
          </div>
        </div>
      )}
      {screen.kind === "vault" && (
        <RollbackBanner compact rollbacks={screen.state.rollbacks} onAccept={(id) => { acceptRollback(screen.state, id); setScreen({ kind: "vault", state: { ...screen.state } }); }} />
      )}
      {screen.kind === "vault" && screen.state.vaults.map((v) => {
        const entry = cache[v.id];
        if (!entry?.problems?.length) return null;
        const nameOf = (id: string) => { const it = entry.items.find((i) => i.id === id); return it?.ok ? payloadName(it.payload) : undefined; };
        return <IntegrityBanner key={v.id} compact name={v.name} problems={entry.problems} canFix={canWrite(v.role)} nameOf={nameOf} onAccept={() => acceptProblems(v)} />;
      })}

      {screen.kind === "login" ? (
        <LoginChooser
          settings={settings}
          reason={screen.reason}
          onSettings={(s) => { setSettings(s); void saveSettings(s); }}
          onSession={async (state, tokens) => {
            await saveSession(state, tokens);
            await clearLockReason();
            await touchLock(settings.lockMinutes);
            setRestored(true);
            setScreen({ kind: "vault", state });
            if (!state.offline) void startSettingsSync(state.account.userKey);
            void sync(state, {});
          }}
        />
      ) : view.kind === "settings" ? (
        <SettingsView settings={settings} state={screen.kind === "vault" ? screen.state : null} say={say} onSettings={(s) => { setSettings(s); void saveSettings(s).then(() => settingsChanged("extension")); void touchLock(s.lockMinutes); }} onBack={() => go({ kind: "list" })} />
      ) : view.kind === "edit" && current ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ItemForm
            kind={current.payload.kind}
            initial={current.payload}
            draft={seed ?? undefined}
            onDraft={setDraft}
            index={indexFor(current.vaultId)}
            onSave={async (p) => {
              try {
                await savePayload(current.vaultId, p, current.item.revision);
              } catch (e) {
                if (merging.offer(current.payload, p, e)) return;
                throw e;
              }
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
          vault={screen.state.vaults.find((v) => v.id === current.vaultId)}
          offline={!!screen.state.offline}
          index={indexFor(current.vaultId)}
          canFill={canFill}
          writable={screen.state.vaults.find((v) => v.id === current.vaultId)?.role !== "reader"}
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
          <div className="shrink-0 px-3.5 pt-2.5">
            <div className="segmented flex w-full" role="tablist" aria-label="Vue">
              {(["vaults", "totp", "generator"] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} data-active={tab === t} onClick={() => setTab(t)} className="flex-1">
                  {t === "vaults" ? "Coffres" : t === "totp" ? "Codes" : "Générateur"}
                </button>
              ))}
            </div>
          </div>
          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3.5 pb-4 pt-3">
            {tab === "generator" && <GeneratorPanel compact />}
            {tab === "totp" && forPage.some((e) => e.login.totp) && (
              <section data-section="page-codes" className="mb-3.5 flex flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5 px-0.5 text-[12px] font-medium text-[var(--c-text-muted)]">
                  <IconGlobe size={13} />
                  <span className="min-w-0 flex-1 truncate">Sur {pageHost}</span>
                </div>
                <div className="card divide-y divide-[var(--c-border)]">
                  {forPage.filter((e) => e.login.totp).map((e) => (
                    <div key={e.item.id} className="flex min-w-0 items-center gap-2.5 py-2.5 pl-3 pr-2.5">
                      <ItemTile entity={e.entity} customIcons={e.customIcons} size={32} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] font-medium">{e.name}</span>
                        <TotpCode secret={e.login.totp!} />
                      </div>
                      <button onClick={() => void fill(e, "totp")} className="btn btn-primary" title="Remplir le code dans la page">Remplir</button>
                    </div>
                  ))}
                </div>
              </section>
            )}
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
              <div className="flex flex-col gap-3.5">
                {forPage.length > 0 && terms.length === 0 && filter === "all" && (
                  <section data-section="page" className="flex flex-col gap-1.5">
                    <div className="flex min-w-0 items-center gap-1.5 px-0.5 text-[12px] font-medium text-[var(--c-text-muted)]">
                      <IconGlobe size={13} />
                      <span className="min-w-0 flex-1 truncate">Sur {pageHost}</span>
                      <span>{forPage.length}</span>
                    </div>
                    <div className="card divide-y divide-[var(--c-border)]">
                      {forPage.map((e) => <SiteRow key={e.item.id} entry={e} onFill={fill} onOpen={() => go({ kind: "detail", id: e.item.id })} say={say} />)}
                    </div>
                  </section>
                )}
                <label className="flex h-9 min-w-0 items-center gap-2 rounded-[9px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2.5 text-[var(--c-text-muted)] focus-within:border-[var(--c-accent)]">
                  <IconSearch size={14} />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Rechercher dans ${screen.state.vaults.length > 1 ? `${screen.state.vaults.length} coffres` : "le coffre"}`} aria-label="Rechercher" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-muted)] focus-visible:outline-none" />
                </label>
                {entries.some((e) => e.payload.kind !== "login") && (
                  <div className="-mx-3.5 flex gap-1.5 overflow-x-auto px-3.5 [scrollbar-width:none]" role="tablist" aria-label="Type d'élément">
                    {FILTERS.filter((f) => f === "all" || (counts[f] ?? 0) > 0).map((f) => (
                      <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] ${filter === f ? "border-[var(--c-text)] bg-[var(--c-text)] text-[var(--c-bg2)]" : "border-[var(--c-border)] text-[var(--c-text-secondary)] hover:border-[var(--c-border-strong)]"}`}>
                        {f === "all" ? "Tout" : capitalize(KIND_LABELS_PLURAL[f])}<span className="opacity-60">{counts[f]}</span>
                      </button>
                    ))}
                  </div>
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
                    <Section key={v.id} id={v.id} title={v.name} dot={vaultColor(v.id, v.kind === "personal", colors)} count={count} collapsed={collapsed.has(v.id) && terms.length === 0} onToggle={() => toggleCollapsed(v.id)}>
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
                {entries.length === 0 && <p className="px-2 py-8 text-center text-[13px] text-[var(--c-text-muted)]">Rien pour l'instant.</p>}
              </div>
            )}
          </div>
          <footer className="flex min-h-[40px] shrink-0 items-center gap-2 border-t border-[var(--c-border)] pl-3.5 pr-2 text-[12px] text-[var(--c-text-muted)]">
            <span className="min-w-0 flex-1 truncate">{canFill ? <>Remplir depuis la page : <span className="kbd">Ctrl Maj L</span></> : "Cet onglet n'est pas une page web."}</span>
            {screen.state.vaults.some((v) => v.role !== "reader") && (
              <div className="relative">
                <button onClick={() => setNewMenu((m) => !m)} className="btn btn-ghost btn-sm text-[var(--c-accent-text)]" aria-haspopup="menu" aria-expanded={newMenu}><IconPlus size={13} /> Nouveau</button>
                {newMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setNewMenu(false)} />
                    <div className="popover absolute bottom-full right-0 z-20 mb-1.5 max-h-[calc(100vh-110px)] w-52 overflow-y-auto py-1" role="menu">
                      {NEW_KINDS.map((k, i) => {
                        if (k === "sep") return <div key={i} className="menu-sep" />;
                        const Icon = KIND_ICONS[k];
                        return (
                          <button key={k} role="menuitem" onClick={() => { setNewMenu(false); go({ kind: "new", itemKind: k, vaultId: (screen.state.vaults.find((v) => v.kind === "personal") ?? screen.state.vaults[0]).id }); }} className="menu-item">
                            <Icon size={14} /> {capitalize(KIND_LABELS[k])}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </footer>
        </>
      )}
      {frameConfirm && (
        <div role="alertdialog" aria-label="Remplir dans un cadre" className="callout callout-warn absolute inset-x-3 bottom-12 z-30 space-y-2.5 shadow-[var(--shadow-md)]">
          <p><b className="font-semibold">Remplir dans {frameConfirm.host} ?</b> Ce cadre ne correspond pas à « {frameConfirm.entry.login.name} » : seulement si c'est bien la connexion du site, pas une publicité.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setFrameConfirm(null)} className="btn btn-ghost">Annuler</button>
            <button onClick={() => { const c = frameConfirm; setFrameConfirm(null); void fill(c.entry, c.what, c.frameId); }} className="btn btn-primary">Remplir quand même</button>
          </div>
        </div>
      )}
      {notice && (
        <div role="status" className="popover absolute inset-x-3 bottom-12 z-20 flex items-center gap-2.5 px-3 py-2.5 text-[13px]">
          <IconCheck size={15} className="shrink-0 text-[var(--c-ok)]" />
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          {/copié/.test(notice) && <span className="shrink-0 text-[12px] text-[var(--c-text-muted)]">vidé après le délai</span>}
        </div>
      )}
      {merging.dialog}
      {repromptDialog}
    </div>
    </RepromptContext.Provider>
  );
}

/** Une section repliable : « Identifiants sur cette page », ou un vault. */
function Section({ id, title, dot, count, collapsed, onToggle, children }: { id: string; title: string; dot: string; count: number; collapsed: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section data-section={id}>
      <button onClick={onToggle} aria-expanded={!collapsed} className="flex w-full min-w-0 items-center gap-2 rounded-md px-0.5 py-1 text-left text-[12px] font-medium text-[var(--c-text-muted)] hover:text-[var(--c-text)]">
        <span className="vdot" style={{ background: dot }} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="font-normal">{count}</span>
        {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
      </button>
      {!collapsed && <div className="-mx-1.5 mt-0.5">{children}</div>}
    </section>
  );
}

/** Un identifiant du site ouvert : « Remplir » d'abord, copier à côté. */
function SiteRow({ entry, onFill, onOpen, say }: { entry: LoginEntry; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; onOpen: () => void; say: (m: string) => void }) {
  const ask = useReprompt();
  const copy = async () => {
    if (!(await ask(entry.payload))) return;
    say((await copyText(entry.login.password)) ? "Mot de passe copié." : "Copie refusée par le navigateur.");
  };
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-2.5 pl-3 pr-2.5">
      <ItemTile entity={entry.entity} customIcons={entry.customIcons} size={32} />
      <button onClick={onOpen} className="flex min-w-0 flex-1 flex-col text-left" title={`Ouvrir « ${entry.name} »`}>
        <span className="truncate text-[13.5px] font-medium">{entry.name}</span>
        <span className="truncate text-[12.5px] text-[var(--c-text-muted)]">{entry.login.username || entry.subtitle || "—"}</span>
      </button>
      {entry.login.password && <button onClick={() => void copy()} className="btn btn-ghost btn-icon" title="Copier le mot de passe" aria-label="Copier le mot de passe"><IconCopy size={15} /></button>}
      <button onClick={() => void onFill(entry, "credentials")} className="btn btn-primary" title="Remplir la page">Remplir</button>
    </div>
  );
}

/** Remplir, copier l'utilisateur, copier le mot de passe — sur une ligne
 * d'identifiant, où qu'elle soit. */
function LoginActions({ entry, canFill, onFill, say }: { entry: LoginEntry; canFill: boolean; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; say: (m: string) => void }) {
  const ask = useReprompt();
  const copy = (label: string, v: string, guarded = false) => async () => {
    if (guarded && !(await ask(entry.payload))) return;
    say((await copyText(v)) ? `${label} copié.` : "Copie refusée par le navigateur.");
  };
  return (
    <>
      {entry.login.username && <button onClick={copy("Utilisateur", entry.login.username)} className="btn btn-ghost btn-sm btn-icon" title="Copier l'utilisateur" aria-label="Copier l'utilisateur"><IconIdentity size={13} /></button>}
      {entry.login.password && <button onClick={copy("Mot de passe", entry.login.password, true)} className="btn btn-ghost btn-sm btn-icon" title="Copier le mot de passe" aria-label="Copier le mot de passe"><IconCopy size={13} /></button>}
      {canFill && <button onClick={() => void onFill(entry, "credentials")} className="btn btn-secondary btn-sm" title="Remplir la page">Remplir</button>}
    </>
  );
}

function Detail({ entry, vault, offline, index, canFill, writable, onBack, onFill, onEdit, onDelete, say }: { entry: Entry; vault: VaultView | undefined; offline: boolean; index: ReturnType<typeof indexItems>; canFill: boolean; writable: boolean; onBack: () => void; onFill: (e: LoginEntry, what: "credentials" | "totp") => Promise<void>; onEdit: () => void; onDelete: () => Promise<void>; say: (m: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const login = isLoginEntry(entry) ? entry : null;
  const site = login?.login.uris[0]?.uri;
  const ask = useReprompt();
  const [, setUnlocks] = useState(0);
  const locked = needsReprompt(entry.payload);
  const copy = (label: string, v: string) => async () => {
    if (!(await ask(entry.payload))) return;
    say((await copyText(v)) ? `${label} copié.` : "Copie refusée par le navigateur.");
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[48px] shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-1.5">
        <button onClick={onBack} className="btn btn-ghost btn-icon" title="Retour" aria-label="Retour"><IconChevronRight size={15} className="rotate-180" /></button>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--c-text-muted)]">{entry.vaultName}{entry.entity.path ? ` · ${entry.entity.path}` : ""}</span>
        {/* Un vault en lecture (ou la copie hors ligne) ne se modifie pas d'ici. */}
        {writable && <button onClick={() => void ask(entry.payload).then((ok) => { if (ok) onEdit(); })} className="btn btn-ghost btn-icon" title="Modifier" aria-label="Modifier"><IconEdit size={15} /></button>}
        {writable && <button onClick={() => setConfirm(true)} className="btn btn-ghost btn-icon hover:text-[var(--c-danger)]" title="Supprimer" aria-label="Supprimer"><IconTrash size={15} /></button>}
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3.5 pb-5 pt-4">
        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <ItemTile entity={entry.entity} customIcons={entry.customIcons} size={52} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h1 className="clamp-2 text-[18px] font-semibold leading-tight tracking-[-0.015em]" title={entry.name}>{entry.name}</h1>
              {site
                ? <a href={/^[a-z][a-z0-9+.-]*:/i.test(site) ? site : `https://${site}`} target="_blank" rel="noopener noreferrer" className="truncate text-[12.5px]">{uriHost(site)}</a>
                : <span className="truncate text-[12.5px] text-[var(--c-text-muted)]">{capitalize(KIND_LABELS[entry.payload.kind])}</span>}
            </div>
          </div>
          {login && (canFill || login.login.password) && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                {canFill && <button onClick={() => void onFill(login, "credentials")} className="btn btn-primary btn-lg min-w-0 flex-1">Remplir la page<span className="kbd">Ctrl Maj L</span></button>}
                {login.login.password && <button onClick={copy("Mot de passe", login.login.password)} className={`btn btn-secondary btn-lg ${canFill ? "" : "flex-1"}`}><IconCopy size={15} /> Mot de passe</button>}
              </div>
              {canFill && login.login.totp && <button onClick={() => void onFill(login, "totp")} className="btn btn-secondary w-full">Remplir le code 2FA</button>}
            </div>
          )}
          {locked ? (
            <div className="card flex items-center gap-3 px-3.5 py-3">
              <IconLock size={16} className="shrink-0 text-[var(--c-text-muted)]" />
              <span className="min-w-0 flex-1 text-[13px]">Protégé par le mot de passe maître</span>
              <button onClick={() => void ask(entry.payload).then((ok) => { if (ok) setUnlocks((n) => n + 1); })} className="btn btn-primary">Afficher</button>
            </div>
          ) : (
            <>
              <ItemView payload={entry.payload} index={index} />
              {/* Les pièces jointes : lecture et téléchargement (joindre se fait
                  dans l'interface web — le sélecteur de fichier fermerait le popup). */}
              {vault && isSecret(entry.payload) && (
                <AttachmentsPanel vault={vault} item={entry.item} writable={false} offline={offline} onChanged={() => {}} notify={say} error={say} />
              )}
            </>
          )}
        </div>
      </div>
      <footer className="flex min-h-[36px] shrink-0 items-center border-t border-[var(--c-border)] px-3.5 text-[12px] text-[var(--c-text-muted)]">
        <span className="truncate" title={entry.item.updatedAt}>Modifié {formatAgo(entry.item.updatedAt)}</span>
      </footer>
      {confirm && (
        <div className="popover absolute inset-x-3 bottom-12 z-30 p-3.5">
          <p className="mb-3 text-[13px]">Supprimer « <span className="font-medium">{entry.name}</span> » ? Il reste dans la corbeille du vault.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirm(false)} className="btn btn-ghost">Annuler</button>
            <button onClick={() => void onDelete()} className="btn btn-danger">Supprimer</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Les réglages, une fois connecté : le verrouillage et le remplissage
 * (les mêmes que sous « Réglages » à la connexion), et l'apparence — la
 * même page que dans l'interface web et dans Guiterm, en une colonne. */
function SettingsView({ settings, state, say, onSettings, onBack }: { settings: Settings; state: SessionState | null; say: (m: string) => void; onSettings: (s: Settings) => void; onBack: () => void }) {
  const toggle = (label: string, on: boolean, set: (v: boolean) => void) => (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)} className="switch" />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-[48px] shrink-0 items-center gap-1 border-b border-[var(--c-border)] px-1.5">
        <button onClick={onBack} className="btn btn-ghost btn-icon" title="Retour" aria-label="Retour"><IconChevronRight size={15} className="rotate-180" /></button>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">Réglages</span>
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-3.5 pb-5 pt-4 [&_.setting-row]:px-3.5 [&_.setting-row]:py-3">
        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">Dans les pages</h2>
          <div className="card">
            <SettingRow title="Bouton GuiVault dans les champs" desc="Sur les sites dont vous avez un identifiant.">
              {toggle("Bouton GuiVault dans les champs", settings.inlineAutofill, (v) => onSettings({ ...settings, inlineAutofill: v }))}
            </SettingRow>
            <SettingRow title="Remplir le code 2FA tout seul" desc="Quand un seul identifiant du site en a un.">
              {toggle("Remplir le code 2FA tout seul", settings.autoTotp, (v) => onSettings({ ...settings, autoTotp: v }))}
            </SettingRow>
            <OtpPatterns settings={settings} onSettings={onSettings} />
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">Sécurité</h2>
          <div className="card">
            <SettingRow htmlFor="ext-lock" title="Verrouiller après">
              <select id="ext-lock" value={settings.lockMinutes} onChange={(e) => onSettings({ ...settings, lockMinutes: Number(e.target.value) })} className="input w-auto">
                {LOCK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </SettingRow>
            <ClipboardSelect />
            {state && <OfflineSetting session={state} notify={say} error={say} />}
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">Apparence</h2>
          <SettingsSyncToggle />
          <AppearanceSettings compact />
        </section>
        <p className="truncate text-center text-[12px] text-[var(--c-text-muted)]" title={settings.serverUrl}>{state?.local ? "Coffre local" : settings.serverUrl}</p>
      </div>
    </div>
  );
}

const LOCK_OPTIONS = [
  { value: 5, label: "5 min" },
  { value: 15, label: "15 min" },
  { value: 60, label: "1 heure" },
  { value: 480, label: "8 heures" },
  { value: 0, label: "Navigateur fermé" },
];

/** Les champs de code que la détection ne reconnaît pas : une ligne qui se
 * déplie sur ses règles (une regex par ligne). */
function OtpPatterns({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(settings.otpPatterns);
  const { errors } = useMemo(() => parseOtpPatterns(text), [text]);
  const count = settings.otpPatterns.split("\n").filter((l) => l.trim()).length;
  return (
    <div className="setting-row flex-col items-stretch">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 items-center gap-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="setting-title block">Champs de code personnalisés</span>
          <span className="setting-desc block">Pour les sites que GuiVault ne reconnaît pas.</span>
        </span>
        <span className="tag">{count} règle{count > 1 ? "s" : ""}</span>
        {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { if (text !== settings.otpPatterns) onSettings({ ...settings, otpPatterns: text }); }}
            rows={3}
            spellCheck={false}
            aria-label="Règles des champs de code"
            placeholder={"verif_code\nsso\\.exemple\\.fr => ^pin$"}
            className="input input-mono text-[12.5px]"
          />
          <p className="flex items-center gap-1.5 text-[12.5px] text-[var(--c-text-muted)]">
            Une regex par ligne
            <InfoTip label="Syntaxe des règles" align="right" items={[
              { text: "Comparée au nom, à l'id, au libellé et à l'aide du champ." },
              { text: <><span className="font-mono">regex d'URL =&gt; regex de champ</span> la limite à certaines pages.</> },
              { text: "Les champs « one-time-code », « 2FA », « OTP » et les codes en cases sont reconnus d'office.", tone: "ok" },
            ]} />
          </p>
          {errors.length > 0 && <p className="callout callout-warn">Ligne{errors.length > 1 ? "s" : ""} {errors.join(", ")} : regex invalide, ignorée.</p>}
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
  /** Le serveur ne répond pas : la copie hors ligne de ce compte, s'il y en
   * a une dans ce navigateur (`lib/offline.ts`). */
  const [unreachable, setUnreachable] = useState(false);
  const [offlineCopy, setOfflineCopy] = useState<OfflineCopy | null>(null);
  useEffect(() => {
    const url = serverUrl.trim().replace(/\/+$/, "");
    const e = email.trim();
    if (!/^https?:\/\//.test(url) || !e.includes("@")) { setOfflineCopy(null); return; }
    const t = setTimeout(() => { setBaseUrl(url); void loadOfflineCopy(e).then(setOfflineCopy); }, 250);
    return () => clearTimeout(t);
  }, [serverUrl, email]);

  const openCopy = async () => {
    if (!offlineCopy || !password) return;
    setError(null);
    setBusy("Ouverture de la copie…");
    try {
      const { session } = await openOffline(offlineCopy, password);
      onSettings({ ...settings, email: email.trim().toLowerCase(), lockMinutes, inlineAutofill });
      // Pas de jetons : rien ne part vers le serveur d'une session hors ligne.
      await onSession(session, { access_token: "", refresh_token: "", access_expires_in: 0 });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

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
      const down = !(err instanceof ApiError) || err.status >= 500;
      if (down) setUnreachable(true);
      setError(down && !(err instanceof ApiError) ? "Serveur injoignable." : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (totp) {
    return (
      <form onSubmit={async (e) => { e.preventDefault(); setBusy("Vérification…"); setError(null); try { await totp.verify(code); } catch (err) { setError(errorMessage(err)); } finally { setBusy(null); } }} className="flex flex-col gap-4 px-7 py-6">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Second facteur</h1>
          <p className="page-sub">Le code de votre application, ou un code de récupération.</p>
        </div>
        <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" aria-label="Code" className="input input-mono h-[42px] text-center text-[16px] tracking-[0.2em]" />
        {error && <p className="callout callout-danger">{error}</p>}
        <button type="submit" disabled={!code.trim() || busy !== null} className="btn btn-primary btn-lg w-full">{busy ?? "Valider"}</button>
        <button type="button" onClick={() => { setTotp(null); setCode(""); }} className="btn btn-ghost w-full">Revenir</button>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="sidebar-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pb-5 pt-5">
        {reason === "expired" && <p className="callout callout-warn">Session expirée ou révoquée : reconnectez-vous.</p>}
        {reason === "timeout" && <p className="callout">Verrouillé après inactivité.</p>}
        {!more && settings.email ? (
          <div className="card flex min-w-0 items-center gap-3 px-3 py-2.5">
            <span className="tile h-[34px] w-[34px] rounded-full text-[12px]" style={{ "--tile-h": 238 } as React.CSSProperties}>{personInitials(email)}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{email}</span>
              <span className="truncate text-[12.5px] text-[var(--c-text-muted)]">{serverUrl.replace(/^https?:\/\//, "")}</span>
            </span>
            <button type="button" onClick={() => setMore(true)} className="btn btn-ghost text-[var(--c-accent-text)]">Changer</button>
          </div>
        ) : (
          <>
            <label className="block">
              <span className="field-label">Serveur GuiVault</span>
              <input type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://vault.example.com" required className="input input-mono" />
            </label>
            <label className="block">
              <span className="field-label">E-mail</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required className="input" />
            </label>
          </>
        )}
        <label className="block">
          <span className="field-label">Mot de passe maître</span>
          <PasswordInput value={password} onChange={setPassword} autoFocus={!!settings.email} autoComplete="current-password" />
        </label>
        {error && <p className="callout callout-danger">{error}</p>}
        {unreachable && offlineCopy && (
          <div className="card flex flex-col gap-2.5 p-3">
            <p className="text-[13px]"><b className="font-semibold">Serveur injoignable.</b> <span className="text-[var(--c-text-muted)]">Copie hors ligne du {new Date(offlineCopy.savedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}, en lecture seule.</span></p>
            <button type="button" onClick={() => void openCopy()} disabled={!password || busy !== null} className="btn btn-secondary w-full">Ouvrir la copie hors ligne</button>
          </div>
        )}
        <button type="submit" disabled={!serverUrl.trim() || !email.trim() || !password || busy !== null} className="btn btn-primary btn-lg w-full">{busy ?? "Déverrouiller"}</button>
        {more && (
          <div className="card [&_.setting-row]:px-3.5 [&_.setting-row]:py-3">
            <SettingRow htmlFor="ext-login-lock" title="Verrouiller après">
              <select id="ext-login-lock" value={lockMinutes} onChange={(e) => setLockMinutes(Number(e.target.value))} className="input w-auto">
                {LOCK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </SettingRow>
            <SettingRow title="Bouton dans les champs" desc="Sur les sites dont vous avez un identifiant.">
              <button type="button" role="switch" aria-checked={inlineAutofill} aria-label="Bouton dans les champs" onClick={() => setInlineAutofill(!inlineAutofill)} className="switch" />
            </SettingRow>
          </div>
        )}
      </div>
      <footer className="flex min-h-[36px] shrink-0 items-center gap-2 border-t border-[var(--c-border)] px-3.5 text-[12px] text-[var(--c-text-muted)]">
        <IconLock size={13} />
        <span className="min-w-0 flex-1 truncate">Déchiffré ici{offlineCopy ? " · copie chiffrée gardée" : ", jamais sur disque"}</span>
      </footer>
    </form>
  );
}

/** Serveur ou coffre local : le choix, retenu dans les réglages. */
function LoginChooser(props: { settings: Settings; reason: LockReason | null; onSettings: (s: Settings) => void; onSession: (state: SessionState, tokens: TokenPair) => Promise<void> }) {
  const mode = props.settings.mode ?? "server";
  const setMode = (m: Settings["mode"]) => props.onSettings({ ...props.settings, mode: m });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-7 pt-5">
        <div className="segmented flex w-full" role="tablist" aria-label="Ouvrir">
          <button type="button" role="tab" aria-selected={mode === "server"} data-active={mode === "server"} onClick={() => setMode("server")} className="flex-1">Serveur</button>
          <button type="button" role="tab" aria-selected={mode === "local"} data-active={mode === "local"} onClick={() => setMode("local")} className="flex-1">Coffre local</button>
        </div>
      </div>
      {mode === "local" ? <LocalLoginView {...props} /> : <LoginView {...props} />}
    </div>
  );
}

/** Un coffre local de l'application GuiVault, par son hôte natif : ceux que
 * l'app a ouverts sur cet ordinateur, et le mot de passe maître — déchiffré
 * ici, comme face à un serveur. */
function LocalLoginView({ settings, reason, onSettings, onSession }: { settings: Settings; reason: LockReason | null; onSettings: (s: Settings) => void; onSession: (state: SessionState, tokens: TokenPair) => Promise<void> }) {
  const [coffres, setCoffres] = useState<string[] | null>(null);
  const [path, setPath] = useState(settings.localPath);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    knownCoffres()
      .then((list) => {
        setCoffres(list);
        setPath((p) => (list.includes(p) ? p : list[0] ?? ""));
      })
      .catch((e) => { setCoffres([]); setError(errorMessage(e)); });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!path) return;
    setError(null);
    setBusy("Dérivation de la clé…");
    try {
      const state = await openLocal(nativeCoffre(path), path, password);
      onSettings({ ...settings, mode: "local", localPath: path });
      // Pas de jetons : un coffre local n'a pas de serveur.
      await onSession(state, { access_token: "", refresh_token: "", access_expires_in: 0 });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="sidebar-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pb-5 pt-5">
        {reason === "timeout" && <p className="callout">Verrouillé après inactivité.</p>}
        {coffres === null ? (
          <p className="text-[13px] text-[var(--c-text-muted)]">Recherche des coffres de l'application…</p>
        ) : coffres.length > 0 ? (
          <div role="radiogroup" aria-label="Coffre" className="flex flex-col gap-1.5">
            <span className="field-label">Coffre</span>
            {coffres.map((p) => (
              <label key={p} className={`card flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2.5 ${path === p ? "border-[var(--c-accent)] shadow-[0_0_0_1px_var(--c-accent)]" : ""}`}>
                <input type="radio" name="coffre" checked={path === p} onChange={() => setPath(p)} className="sr-only" />
                <span className="tile tile-neutral" style={{ "--tile-size": "32px" } as React.CSSProperties}>{coffreLabel(p).charAt(0).toUpperCase()}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{coffreLabel(p)}</span>
                  <span className="truncate font-mono text-[11.5px] text-[var(--c-text-muted)]" title={p}>{p}</span>
                </span>
                {path === p && <IconCheck size={15} className="shrink-0 text-[var(--c-accent)]" />}
              </label>
            ))}
          </div>
        ) : !error ? (
          <p className="callout">Aucun coffre : ouvrez ou créez d'abord un coffre local dans l'application GuiVault.</p>
        ) : null}
        {coffres && coffres.length > 0 && (
          <label className="block">
            <span className="field-label">Mot de passe maître</span>
            <PasswordInput value={password} onChange={setPassword} autoFocus autoComplete="current-password" />
          </label>
        )}
        {error && <p className="callout callout-danger">{error}</p>}
        {coffres && coffres.length > 0 && <button type="submit" disabled={!path || !password || busy !== null} className="btn btn-primary btn-lg w-full">{busy ?? "Déverrouiller"}</button>}
      </div>
      <footer className="flex min-h-[36px] shrink-0 items-center gap-2 border-t border-[var(--c-border)] px-3.5 text-[12px] text-[var(--c-text-muted)]">
        <IconLock size={13} />
        <span className="min-w-0 flex-1 truncate">Déchiffré ici · l'application ne passe que du chiffré</span>
      </footer>
    </form>
  );
}

/** Le délai d'effacement du presse-papiers : un réglage qui suit le compte,
 * le même que dans l'interface web (`lib/clipboard.ts`). */
function ClipboardSelect() {
  const [seconds, setSeconds] = useState(loadClearSeconds);
  return (
    <SettingRow htmlFor="ext-clear" title="Vider le presse-papiers" desc="Seulement si la valeur copiée y est encore.">
      <select id="ext-clear" value={seconds} onChange={(e) => { const n = Number(e.target.value); setSeconds(n); saveClearSeconds(n); }} className="input w-auto">
        {CLEAR_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    </SettingRow>
  );
}
