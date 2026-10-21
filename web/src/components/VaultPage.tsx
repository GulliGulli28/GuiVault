import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageContext } from "../App";
import { errorMessage, supports } from "../lib/api";
import { autoTypeBridge } from "../lib/platform";
import { performAutoType } from "./AutoType";
import { filterEntities, indexItems, SORT_LABELS, toEntities, withParent, type SortMode } from "../lib/entities";
import { plainShortcut } from "../lib/keyboard";
import { uuid } from "../lib/bytes";
import { isSecret, primarySecret, primaryUser, uriHost, withArticle } from "../lib/items";
import { parseTotp, totpCode } from "../lib/totp";
import { ACCENT_COLORS } from "../lib/preferences";
import { setVaultColor, useVaultColors, VAULT_COLORS, vaultColor, vaultColorName } from "../lib/vaultColors";
import { pinnedEmailFor } from "../lib/pins";
import { navigate } from "../lib/route";
import { problemItem, problemText, type ManifestProblem } from "../lib/manifest";
import { acceptIntegrity, deleteItem, findVault, loadItems, moveItem, payloadEntity, payloadName, putPayload, RevisionConflict, type DecodedItem, type VaultView } from "../lib/session";
import { canWrite, KIND_LABELS, KIND_LABELS_PLURAL, ROLE_HINTS, ROLE_LABELS, type CustomIcon, type GuiVaultEntity, type ItemKind, type Payload } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { ItemTile, ItemTree, KIND_ICONS, type FolderNaming } from "./ItemTree";
import { ItemView } from "./ItemView";
import { ItemForm } from "./forms/ItemForm";
import { IconDots, IconFolderPlus, IconHistory, IconLink, IconShieldClock, IconSort, IconStar, IconTools } from "./secret-icons";
import { ShareLinkDialog } from "./SendsPage";
import { ItemHistory } from "./ItemHistory";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { IntegrityBanner } from "./IntegrityBanner";
import { useMerge } from "./MergeDialog";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconEdit, IconExternal, IconFolder, IconKeyboard, IconPlus, IconRefresh, IconSearch, IconSettings, IconTrash, IconVault } from "./ui-icons";
import { copyText, Dropdown, formatAgo, formatWhen, Loading, useDelayed } from "./ui";
import { PaneHandle, usePersistedPane } from "../hooks/usePersistedPane";
import { TOUCH, useMediaQuery } from "../hooks/useMediaQuery";

/** `groupId` : le dossier où créer (bouton « + » d'un dossier) ; absent, le
 * dossier de l'élément sélectionné. */
type Mode = { kind: "view" } | { kind: "edit" } | { kind: "new"; itemKind: ItemKind; groupId?: string | null };

/** Les entrées du menu « Nouveau » : les secrets d'abord, puis les entités
 * Guiterm, un trait entre les deux. */
const NEW_KINDS: (ItemKind | "sep")[] = ["login", "note", "card", "identity", "api-key", "aws", "sep", "host", "group", "sql-connection", "key", "snippet", "runbook", "icon"];

type Filter = "all" | "favorites" | ItemKind;
/** Les filtres proposés, dans l'ordre ; ceux sans élément sont masqués. */
const FILTERS: Filter[] = ["all", "favorites", "login", "note", "card", "identity", "api-key", "aws", "host", "sql-connection", "key", "snippet", "runbook", "group", "icon"];

/** Un vault : son contenu à gauche, la fiche ou le formulaire à droite. */
export function VaultPage({ ctx, vaultId, itemId, create }: { ctx: PageContext; vaultId: string; itemId?: string; create?: string }) {
  const vault = findVault(ctx.session, vaultId);
  if (!vault) return <p className="p-6 text-[13px] text-[var(--c-text-muted)]">Ce vault n'existe pas (ou plus).</p>;
  const kind = NEW_KINDS.find((k): k is ItemKind => k !== "sep" && k === create);
  return <VaultBody key={vault.id} ctx={ctx} vault={vault} itemId={itemId} create={kind} />;
}

const SORT_KEY = "guivault.sort";

function loadSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return v === "updated" || v === "created" ? v : "name";
  } catch {
    return "name";
  }
}

function VaultBody({ ctx, vault, itemId, create }: { ctx: PageContext; vault: VaultView; itemId?: string; create?: ItemKind }) {
  const [items, setItems] = useState<DecodedItem[] | null>(null);
  /** Les écarts au manifeste de la dernière lecture : tant qu'il y en a, le
   * vault est en lecture seule d'ici (`IntegrityError`). */
  const [problems, setProblems] = useState<ManifestProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(itemId ?? null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [sort, setSortState] = useState<SortMode>(loadSort);
  const [help, setHelp] = useState(false);
  // Stable : `useModalSurface` rend le focus à l'ouvreur quand `onClose`
  // change, ce qu'une fonction recréée à chaque rendu ferait sans cesse.
  const closeHelp = useCallback(() => setHelp(false), []);
  const filterRef = useRef<HTMLInputElement>(null);
  const setSort = (s: SortMode) => {
    setSortState(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      // sans stockage, le tri vaut pour la session
    }
  };
  // Ouvert depuis la recherche globale : l'élément demandé, sans filtre qui
  // le cacherait.
  useEffect(() => {
    if (!itemId) return;
    setSelected(itemId);
    setMode({ kind: "view" });
    setQuery("");
    setFilter("all");
  }, [itemId]);
  // Créer, demandé depuis l'accueil (`#/vault/<id>/new/<genre>`).
  useEffect(() => {
    if (create && canWrite(vault.role)) setMode({ kind: "new", itemKind: create });
  }, [create, vault.role]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState(false);
  // Stable, comme `closeHelp` : `useModalSurface` rend le focus à l'ouvreur
  // quand `onClose` change.
  const closeHistory = useCallback(() => setHistory(false), []);
  const [sharing, setSharing] = useState(false);
  const closeSharing = useCallback(() => setSharing(false), []);
  /** Remis par un accès d'urgence : lecture seule, sans corbeille, historique
   * ni réglages (ce compte n'en est pas membre). */
  const emergency = vault.emergency;
  const [moveTo, setMoveTo] = useState<VaultView | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const colors = useVaultColors();
  const newButton = useRef<HTMLButtonElement>(null);
  const touch = useMediaQuery(TOUCH);
  // Le menu « Nouveau » se referme à Échap, et rend le focus à son bouton.
  useEffect(() => {
    if (!newMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setNewMenu(false);
      newButton.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [newMenu]);
  const [stale, setStale] = useState(false);
  const [naming, setNaming] = useState<FolderNaming | null>(null);
  /** Le menu « + » d'un dossier, posé à l'endroit du bouton. */
  const [folderMenu, setFolderMenu] = useState<{ folderId: string; x: number; y: number } | null>(null);
  const slow = useDelayed(loading);
  const writable = canWrite(vault.role) && problems.length === 0;
  // La colonne de la liste se redimensionne, comme les panneaux de Guiterm.
  const list = usePersistedPane("vault-list", { initial: 380, min: 300, max: 720, axis: "horizontal", mode: "px" });
  const editingRef = useRef(false);
  editingRef.current = mode.kind !== "view";
  // `vault` et `ctx` changent d'identité à chaque `/sync` ou notification :
  // `load` les lit par référence pour ne pas recharger les items à chaque
  // fois — seulement au montage et quand le serveur le dit (`tick`).
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  /** Le nom de chaque élément lu depuis l'ouverture : un élément que le
   * serveur ne sert plus (« retenu ») garde ainsi le sien dans l'alerte. */
  const names = useRef(new Map<string, string>());
  const nameOf = useCallback((id: string) => names.current.get(id), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await loadItems(vaultRef.current);
      for (const it of page.items) if (it.ok) names.current.set(it.id, payloadName(it.payload));
      setItems(page.items);
      setProblems(page.problems);
    } catch (e) {
      ctxRef.current.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Le serveur dit que le vault a changé : on recharge, sauf au milieu d'une
  // saisie — on le signale alors, et le verrou de révision fera le reste.
  const tick = ctx.vaultTicks[vault.id] ?? 0;
  useEffect(() => {
    if (tick === 0) return;
    if (editingRef.current) setStale(true);
    else void load();
  }, [tick, load]);

  const index = useMemo(() => indexItems(items ?? []), [items]);
  const entities = useMemo(() => toEntities(items ?? []), [items]);
  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: entities.length, favorites: entities.filter((e) => e.favorite).length };
    for (const e of entities) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entities]);
  // Filtrer par type garde les dossiers qui mènent à quelque chose, pas les
  // autres.
  const filtered = useMemo(() => {
    if (filter === "all") return entities;
    if (filter === "group") return entities.filter((e) => e.kind === "group");
    if (filter === "favorites") return filterEntities(entities, (e) => !!e.favorite);
    return filterEntities(entities, (e) => e.kind === filter);
  }, [entities, filter]);
  const current = selected ? items?.find((i) => i.id === selected) ?? null : null;
  const alerts = useMemo(() => {
    const out = new Map<string, string>();
    for (const p of problems) {
      const id = problemItem(p);
      if (id) out.set(id, problemText(p, nameOf));
    }
    return out;
  }, [problems, nameOf]);

  const acceptProblems = async () => {
    try {
      await acceptIntegrity(vault);
      ctx.notify(canWrite(vault.role) && !emergency ? "Manifeste réécrit d'après ce que sert le serveur." : "Pris acte.");
    } catch (e) {
      ctx.error(errorMessage(e));
    }
    await load();
  };

  const leaveEdit = async (payload: Payload, message: string) => {
    ctx.notify(message);
    setMode({ kind: "view" });
    setStale(false);
    await load();
    setSelected(payloadIdOf(payload));
  };

  // Enregistrer une modification refusée parce que l'élément a changé
  // entre-temps : la fusion plutôt qu'un rechargement qui perdrait la saisie.
  const merging = useMerge({
    vault,
    index,
    write: async (p, revision) => {
      await putPayload(vault, p, revision);
    },
    done: leaveEdit,
    discard: () => {
      setMode({ kind: "view" });
      setStale(false);
      void load();
    },
  });

  const save = async (payload: Payload, baseRevision?: number) => {
    try {
      await putPayload(vault, payload, baseRevision);
    } catch (e) {
      if (e instanceof RevisionConflict) {
        if (baseRevision !== undefined && current?.ok && merging.offer(current.payload, payload, e)) return;
        await load();
      }
      throw e;
    }
    await leaveEdit(payload, `« ${payloadName(payload)} » enregistré.`);
  };

  const remove = async () => {
    if (!current) return;
    setConfirmDelete(false);
    try {
      await deleteItem(vault, current.id);
      ctx.notify("Élément supprimé.");
      setSelected(null);
      await load();
    } catch (e) {
      ctx.error(errorMessage(e));
    }
  };

  const doMove = async () => {
    if (!current || !current.ok || !moveTo) return;
    const dest = moveTo;
    setMoveTo(null);
    try {
      await moveItem(vault, dest, current);
      ctx.notify(`« ${payloadName(current.payload)} » déplacé vers « ${dest.name} ».`);
      setSelected(null);
      await load();
    } catch (e) {
      ctx.error(errorMessage(e));
    }
  };

  const toggleFavorite = async () => {
    if (!current?.ok) return;
    const p = current.payload;
    const flip = <T extends { favorite?: boolean }>(e: T): T => ({ ...e, favorite: e.favorite ? undefined : true });
    let next: Payload;
    switch (p.kind) {
      case "login": next = { ...p, login: flip(p.login) }; break;
      case "note": next = { ...p, note: flip(p.note) }; break;
      case "card": next = { ...p, card: flip(p.card) }; break;
      case "identity": next = { ...p, identity: flip(p.identity) }; break;
      case "aws": next = { ...p, aws: flip(p.aws) }; break;
      case "api-key": next = { ...p, apiKey: flip(p.apiKey) }; break;
      default: return;
    }
    try {
      await putPayload(vault, next, current.revision);
      await load();
    } catch (e) {
      ctx.error(errorMessage(e));
      if (e instanceof RevisionConflict) await load();
    }
  };

  /** Copier l'utilisateur ou le mot de passe depuis la liste, sans ouvrir. */
  const rowActions = (entity: GuiVaultEntity) => {
    const it = index.byId.get(entity.id);
    if (!it || it.payload.kind !== "login") return null;
    const l = it.payload.login;
    const copy = (label: string, value: string) => () => copyText(value).then((ok) => ok && ctx.notify(`${label} copié.`));
    return (
      <>
        {l.username && <button onClick={copy("Utilisateur", l.username)} className="btn btn-ghost btn-sm" title="Copier l'utilisateur" aria-label="Copier l'utilisateur">U</button>}
        {l.password && <button onClick={copy("Mot de passe", l.password)} className="btn btn-ghost btn-sm btn-icon" title="Copier le mot de passe" aria-label="Copier le mot de passe"><IconCopy size={11} /></button>}
      </>
    );
  };

  // ─── Dossiers, comme dans le panneau des hôtes de Guiterm ──────────────

  /** Deux dossiers de même nom au même niveau : refusé, comme Guiterm. */
  const nameTaken = (name: string, parentId: string | null, except?: string) =>
    index.groups.some((g) => g.id !== except && (g.parentId ?? null) === parentId && g.name.toLowerCase() === name.toLowerCase());

  const submitFolderName = async (name: string) => {
    const n = naming;
    setNaming(null);
    if (!n) return;
    try {
      if (n.mode === "create") {
        if (nameTaken(name, n.parentId)) return ctx.error(`Un dossier « ${name} » existe déjà à ce niveau.`);
        await putPayload(vault, { kind: "group", group: { id: uuid(), name, parentId: n.parentId, color: null } });
        ctx.notify(`Dossier « ${name} » créé.`);
      } else {
        const it = index.byId.get(n.id);
        if (!it || it.payload.kind !== "group") return;
        const g = it.payload.group;
        if (nameTaken(name, g.parentId ?? null, g.id)) return ctx.error(`Un dossier « ${name} » existe déjà à ce niveau.`);
        await putPayload(vault, { kind: "group", group: { ...g, name } }, it.revision);
        ctx.notify(`Dossier renommé en « ${name} ».`);
      }
    } catch (e) {
      ctx.error(errorMessage(e));
    }
    await load();
  };

  /** Glisser-déposer : l'élément change de dossier, rien d'autre. */
  const moveToFolder = async (id: string, folderId: string | null) => {
    const it = index.byId.get(id);
    if (!it) return;
    const next = withParent(it.payload, folderId);
    if (!next) return;
    if (next.kind === "group" && nameTaken(next.group.name, folderId, id)) return ctx.error(`Un dossier « ${next.group.name} » existe déjà à cet endroit.`);
    try {
      await putPayload(vault, next, it.revision);
      const dest = folderId ? index.groups.find((g) => g.id === folderId)?.name : null;
      ctx.notify(`« ${payloadName(next)} » rangé ${dest ? `dans « ${dest} »` : "à la racine"}.`);
    } catch (e) {
      ctx.error(errorMessage(e));
    }
    await load();
  };

  const folderActions = (folder: GuiVaultEntity) => (
    <>
      <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setFolderMenu({ folderId: folder.id, x: r.right, y: r.bottom }); }} className="btn btn-ghost btn-sm btn-icon" title="Nouvel élément dans ce dossier" aria-label={`Nouvel élément dans ${folder.name}`}><IconPlus size={12} /></button>
      <button onClick={() => setNaming({ mode: "create", parentId: folder.id })} className="btn btn-ghost btn-sm btn-icon" title="Nouveau sous-dossier" aria-label={`Nouveau sous-dossier dans ${folder.name}`}><IconFolder size={12} /></button>
      <button onClick={() => setNaming({ mode: "rename", id: folder.id })} className="btn btn-ghost btn-sm btn-icon" title="Renommer" aria-label={`Renommer ${folder.name}`}><IconEdit size={12} /></button>
      <button onClick={() => { setSelected(folder.id); setMode({ kind: "view" }); }} className={`btn btn-ghost btn-sm ${selected === folder.id ? "btn-toggled" : ""}`} title="Ouvrir le dossier : icône, couleur, suppression">ouvrir</button>
    </>
  );

  /** Une icône importée depuis le sélecteur d'un hôte ou d'un dossier :
   * un item de plus, et l'index se recharge pour que le sélecteur la voie. */
  const addIcon = async (icon: CustomIcon) => {
    await putPayload(vault, { kind: "icon", icon });
    await load();
  };

  const otherWritable = ctx.session.vaults.filter((v) => v.id !== vault.id && canWrite(v.role));
  const selectedGroupId = current?.ok && current.payload.kind === "group" ? current.id : current?.ok && "groupId" in payloadEntity(current.payload) ? (payloadEntity(current.payload).groupId as string | null) : null;
  const isSecretItem = current?.ok && isSecret(current.payload);

  // ─── Clavier (« ? » pour la liste) ───────────────────────────────────────
  const shortcutsRef = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcutsRef.current = (e: KeyboardEvent) => {
    if (!plainShortcut(e)) return;
    if (e.key === "/") { e.preventDefault(); filterRef.current?.focus(); return; }
    if (e.key === "?") { e.preventDefault(); setHelp(true); return; }
    if (mode.kind !== "view" || !current?.ok) return;
    const copy = (what: { label: string; value: string } | null) => {
      if (!what) return;
      e.preventDefault();
      void copyText(what.value).then((ok) => ok && ctx.notify(`${what.label} copié.`));
    };
    switch (e.key) {
      case "c": copy(primarySecret(current.payload)); break;
      case "u": copy(primaryUser(current.payload)); break;
      case "h": if (!emergency) { e.preventDefault(); setHistory(true); } break;
      case "e": if (writable) { e.preventDefault(); setMode({ kind: "edit" }); } break;
      case "f": if (writable && isSecretItem) { e.preventDefault(); void toggleFavorite(); } break;
      case "Delete": if (writable) { e.preventDefault(); setConfirmDelete(true); } break;
    }
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => shortcutsRef.current(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const entity = current?.ok ? entities.find((e) => e.id === current.id) : undefined;
  const filterLabel = (f: Filter) => (f === "all" ? "Tous les types" : f === "favorites" ? "Favoris" : capitalize(KIND_LABELS_PLURAL[f]));
  const copyValue = (what: { label: string; value: string } | null) => {
    if (!what) return;
    void copyText(what.value).then((ok) => (ok ? ctx.notify(`${what.label} copié.`) : ctx.error("Copie refusée par le navigateur.")));
  };
  const copyTotp = (secret: string) => {
    const params = parseTotp(secret);
    if (!params) return ctx.error("Secret TOTP illisible.");
    void totpCode(params).then((code) => copyValue({ label: "Code 2FA", value: code }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IntegrityBanner name={vault.name} problems={problems} canFix={canWrite(vault.role) && !emergency} nameOf={nameOf} onAccept={acceptProblems} />

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <section
          aria-label="Éléments du vault"
          style={{ "--list-w": `${list.value}px` } as React.CSSProperties}
          className={`flex min-h-0 flex-col bg-[var(--c-bg)] xl:w-[var(--list-w)] xl:shrink-0 ${mode.kind !== "view" || current ? "max-xl:hidden" : "max-xl:flex-1"}`}
        >
          <header className="shrink-0 space-y-3 px-4 pb-3 pt-[18px] max-md:pl-14">
            <div className="flex min-w-0 items-center gap-2">
              <span className="vdot h-2.5 w-2.5" style={{ background: vaultColor(vault.id, vault.kind === "personal", colors) }} />
              <h1 className="min-w-0 truncate text-[18px] font-semibold tracking-[-0.015em] text-[var(--c-text)]" title={vault.name}>{vault.name}</h1>
              <span className="shrink-0 whitespace-nowrap text-[12.5px] text-[var(--c-text-muted)]" title={`Révision ${vault.revision}`}>{items ? `${entities.filter((e) => e.kind !== "group" && e.kind !== "icon").length} éléments` : ""}</span>
              <span className="flex-1" />
              <Dropdown
                label="Le vault"
                className="w-60"
                trigger={({ open, toggle }) => <button onClick={toggle} aria-expanded={open} aria-haspopup="menu" className="btn btn-ghost btn-icon" title="Le vault : couleur, corbeille, import, réglages" aria-label="Actions du vault"><IconDots size={16} /></button>}
              >
                {(close) => (
                  <>
                    <div className="px-3.5 pb-2 pt-1.5">
                      <p className="mb-2 text-[12px] font-medium text-[var(--c-text-muted)]">Couleur</p>
                      <div className="flex flex-wrap gap-1.5">
                        {VAULT_COLORS.map((c) => {
                          const on = vaultColorName(vault.id, vault.kind === "personal", colors) === c;
                          return <button key={c} onClick={() => setVaultColor(vault.id, c)} aria-pressed={on} title={ACCENT_COLORS[c].label} aria-label={`Couleur ${ACCENT_COLORS[c].label}`} className={`h-5 w-5 rounded-full ${on ? "ring-2 ring-[var(--c-text)] ring-offset-2 ring-offset-[var(--c-raised)]" : ""}`} style={{ background: ACCENT_COLORS[c].c500 }} />;
                        })}
                      </div>
                    </div>
                    <div className="menu-sep" />
                    <button role="menuitem" className="menu-item" onClick={() => { close(); void load(); }}><IconRefresh size={14} /> Recharger</button>
                    <button role="menuitem" className="menu-item" onClick={() => { close(); navigate({ page: "vault-tools", id: vault.id }); }}><IconTools size={14} /> {emergency ? "Exporter" : "Importer ou exporter"}</button>
                    {!emergency && <button role="menuitem" className="menu-item" onClick={() => { close(); navigate({ page: "vault-trash", id: vault.id }); }}><IconTrash size={14} /> Corbeille</button>}
                    {!emergency && <button role="menuitem" className="menu-item" onClick={() => { close(); navigate({ page: "vault-settings", id: vault.id }); }}><IconSettings size={14} /> Membres et réglages</button>}
                    <button role="menuitem" className="menu-item" onClick={() => { close(); setHelp(true); }}><IconKeyboard size={14} /> Raccourcis clavier</button>
                  </>
                )}
              </Dropdown>
              {writable && (
                <div className="relative">
                  <button ref={newButton} onClick={() => setNewMenu((m) => !m)} className="btn btn-primary" aria-haspopup="menu" aria-expanded={newMenu}><IconPlus size={14} /> Nouveau</button>
                  {newMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setNewMenu(false)} />
                      <div className="popover absolute right-0 z-20 mt-1.5 w-52 py-1" role="menu" aria-label="Nouvel élément">
                        {NEW_KINDS.map((k, i) => {
                          if (k === "sep") return <div key={i} className="menu-sep" />;
                          const Icon = KIND_ICONS[k];
                          return (
                            <button key={k} role="menuitem" onClick={() => { setNewMenu(false); if (k === "group") { setQuery(""); setFilter("all"); setNaming({ mode: "create", parentId: selectedGroupId }); } else setMode({ kind: "new", itemKind: k }); }} className="menu-item">
                              <Icon size={14} /> {capitalize(KIND_LABELS[k])}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            {(emergency || vault.kind !== "personal" || (vault.keyFrom.kind === "member" && !pinnedEmailFor(vault.keyFrom.fingerprint))) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {emergency ? (
                  <span className="tag tag-accent max-w-full truncate" title={`Confié par ${emergency.grantor} par l'accès d'urgence : lecture seule`}>Confié par {emergency.grantor}</span>
                ) : vault.kind !== "personal" && (
                  <span className="tag" title={ROLE_HINTS[vault.role]}>{capitalize(ROLE_LABELS[vault.role])}</span>
                )}
                {vault.keyFrom.kind === "member" && !pinnedEmailFor(vault.keyFrom.fingerprint) && (
                  <button
                    type="button"
                    onClick={() => navigate({ page: "vault-settings", id: vault.id })}
                    className="tag tag-warn"
                    title="La clé de ce vault vous a été remise par quelqu'un dont vous n'avez pas vérifié l'empreinte — voir les réglages du vault"
                  >
                    Clé non vérifiée
                  </button>
                )}
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[9px] border border-[var(--c-border)] bg-[var(--c-surface)] px-2.5 text-[var(--c-text-muted)] focus-within:border-[var(--c-accent)]">
                <IconSearch size={14} />
                <input ref={filterRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.currentTarget.blur(); if (query) setQuery(""); } }} placeholder="Filtrer ce vault" aria-label="Filtrer ce vault" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-muted)] focus-visible:outline-none" />
                {!touch && !query && <span className="kbd">/</span>}
              </label>
              {entities.length > 0 && (
                <Dropdown
                  label="Type d'élément"
                  className="w-56"
                  trigger={({ open, toggle }) => (
                    <button onClick={toggle} aria-expanded={open} aria-haspopup="menu" className={`btn max-w-[9.5rem] ${filter === "all" ? "btn-secondary" : "btn-toggled"}`} title="Type d'élément">
                      <span className="truncate">{filterLabel(filter)}</span><IconChevronDown size={12} />
                    </button>
                  )}
                >
                  {(close) => FILTERS.filter((f) => f === "all" || (counts[f] ?? 0) > 0).map((f) => (
                    <button key={f} role="menuitemradio" aria-checked={filter === f} data-active={filter === f ? "true" : undefined} onClick={() => { setFilter(f); close(); }} className="menu-item">
                      <span className="min-w-0 flex-1 truncate">{filterLabel(f)}</span>
                      <span className="text-[12px] tabular-nums text-[var(--c-text-muted)]">{counts[f]}</span>
                    </button>
                  ))}
                </Dropdown>
              )}
              <Dropdown
                label="Trier"
                className="w-52"
                trigger={({ open, toggle }) => <button onClick={toggle} aria-expanded={open} aria-haspopup="menu" className="btn btn-secondary btn-icon" title={`Trier : ${SORT_LABELS[sort]}`} aria-label="Trier"><IconSort size={15} /></button>}
              >
                {(close) => (Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                  <button key={m} role="menuitemradio" aria-checked={sort === m} data-active={sort === m ? "true" : undefined} onClick={() => { setSort(m); close(); }} className="menu-item">
                    <span className="flex-1">{SORT_LABELS[m]}</span>
                    {sort === m && <IconCheck size={14} />}
                  </button>
                ))}
              </Dropdown>
              {writable && (
                <button onClick={() => { setQuery(""); setFilter("all"); setNaming({ mode: "create", parentId: null }); }} className="btn btn-secondary btn-icon shrink-0 max-sm:hidden" title="Nouveau dossier (à la racine ; le bouton d'un dossier en crée un dedans)" aria-label="Nouveau dossier"><IconFolderPlus size={15} /></button>
              )}
            </div>
          </header>
          <div className="sidebar-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {items === null ? (slow ? <Loading /> : null) : (
              <ItemTree
                entities={filtered}
                customIcons={index.icons}
                query={query}
                selected={selected}
                onSelect={(id) => { setSelected(id); setMode({ kind: "view" }); }}
                rowActions={rowActions}
                sort={sort}
                keyboard={mode.kind === "view"}
                alerts={alerts}
                emptyMessage={writable ? "Ce vault est vide." : "Rien ici pour l'instant."}
                {...(writable && sort === "name" ? { folderActions, naming, onName: (n: string) => void submitFolderName(n), onNameCancel: () => setNaming(null), onMove: (id: string, folderId: string | null) => void moveToFolder(id, folderId) } : {})}
              />
            )}
            {items !== null && entities.length === 0 && writable && (
              <div className="flex flex-wrap justify-center gap-2 px-2 pb-4">
                <button onClick={() => setMode({ kind: "new", itemKind: "login" })} className="btn btn-primary"><IconPlus size={14} /> Nouvel identifiant</button>
                <button onClick={() => navigate({ page: "vault-tools", id: vault.id })} className="btn btn-secondary">Importer</button>
              </div>
            )}
          </div>
        </section>

        <div className="hidden xl:contents"><PaneHandle onMouseDown={list.onMouseDown} /></div>
        <section className={`flex min-h-0 flex-1 flex-col border-l border-[var(--c-border)] max-xl:border-l-0 ${mode.kind === "view" && !current ? "max-xl:hidden" : ""} ${list.isDragging ? "pointer-events-none select-none" : ""}`}>
          {stale && mode.kind !== "view" && (
            <p className="callout callout-warn m-4 mb-0">Ce vault a changé entre-temps : l'enregistrement proposera de fusionner.</p>
          )}
          {mode.kind === "new" && (
            <ItemForm key={`${mode.itemKind}-${mode.groupId ?? ""}`} kind={mode.itemKind} index={index} defaultGroupId={mode.groupId !== undefined ? mode.groupId : selectedGroupId} onSave={(p) => save(p)} onCancel={() => setMode({ kind: "view" })} onAddIcon={addIcon} />
          )}
          {mode.kind === "edit" && current?.ok && (
            <ItemForm kind={current.payload.kind} initial={current.payload} index={index} onSave={(p) => save(p, current.revision)} onCancel={() => setMode({ kind: "view" })} onAddIcon={addIcon} />
          )}
          {mode.kind === "view" && !current && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center max-md:hidden">
              {items && items.length > 0 && (
                <>
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-dashed border-[var(--c-border-strong)] text-[var(--c-text-muted)]"><IconVault size={20} /></span>
                  <p className="text-[13.5px] text-[var(--c-text-muted)]">Choisissez un élément.</p>
                  {!touch && <p className="flex items-center gap-1.5 text-[12.5px] text-[var(--c-text-faint)]"><span className="kbd">/</span> filtrer <span className="kbd">?</span> raccourcis</p>}
                </>
              )}
            </div>
          )}
          {mode.kind === "view" && current && (
            <>
              <div className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-5 py-2 max-md:px-3">
                <button onClick={() => setSelected(null)} className="btn btn-ghost btn-sm xl:hidden">← Liste</button>
                <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-[var(--c-text-muted)] max-md:hidden">
                  <span className="truncate">{vault.name}</span>
                  {entity?.path && <><IconChevronRight size={12} className="shrink-0 text-[var(--c-text-faint)]" /><span className="truncate">{entity.path}</span></>}
                </div>
                <span className="flex-1 md:hidden" />
                {current.ok && current.payload.kind === "login" && autoTypeBridge() && (() => {
                  const login = current.payload.login;
                  return (
                    <button onClick={() => performAutoType(login).catch((e) => ctx.error(`Saisie automatique : ${errorMessage(e)}`))} disabled={login.autoType?.enabled === false} className="btn btn-ghost btn-icon" title={login.autoType?.enabled === false ? "Saisie automatique désactivée pour cet identifiant" : "Saisie automatique : GuiVault se réduit et le tape dans la fenêtre d'avant"} aria-label="Saisie automatique"><IconKeyboard size={15} /></button>
                  );
                })()}
                {!emergency && isSecretItem && supports("createSend") && (
                  <button onClick={() => setSharing(true)} className="btn btn-secondary" title="Partager par lien : une copie chiffrée, qui expire"><IconLink size={14} /> <span className="max-sm:hidden">Partager</span></button>
                )}
                {writable && current.ok && <button onClick={() => setMode({ kind: "edit" })} className="btn btn-secondary"><IconEdit size={14} /> <span className="max-sm:hidden">Modifier</span></button>}
                <Dropdown
                  label="Plus d'actions"
                  className="w-60"
                  trigger={({ open, toggle }) => <button onClick={toggle} aria-expanded={open} aria-haspopup="menu" className="btn btn-ghost btn-icon" title="Plus d'actions" aria-label="Plus d'actions"><IconDots size={16} /></button>}
                >
                  {(close) => (
                    <>
                      {!emergency && <button role="menuitem" className="menu-item" onClick={() => { close(); setHistory(true); }}><IconHistory size={14} /> Historique<span className="flex-1" />{!touch && <span className="kbd">H</span>}</button>}
                      {writable && current.ok && otherWritable.map((v) => (
                        <button key={v.id} role="menuitem" className="menu-item" onClick={() => { close(); setMoveTo(v); }}>
                          <span className="vdot" style={{ background: vaultColor(v.id, v.kind === "personal", colors) }} />
                          <span className="min-w-0 flex-1 truncate">Déplacer vers {v.name}</span>
                        </button>
                      ))}
                      {writable && <><div className="menu-sep" /><button role="menuitem" className="menu-item text-[var(--c-danger-text)]" onClick={() => { close(); setConfirmDelete(true); }}><IconTrash size={14} /> Supprimer<span className="flex-1" />{!touch && <span className="kbd">Suppr</span>}</button></>}
                    </>
                  )}
                </Dropdown>
              </div>
              <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-7 max-md:px-4 max-md:pt-5">
                <div className="flex max-w-[860px] flex-col gap-6">
                  {alerts.has(current.id) && <p className="callout callout-danger">{capitalize(alerts.get(current.id)!)} : ne vous y fiez pas avant de l'avoir vérifié.</p>}
                  {current.ok ? (
                    <>
                      <div className="flex min-w-0 items-center gap-4">
                        {entity && <ItemTile entity={entity} customIcons={index.icons} size={56} />}
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <h2 className="min-w-0 truncate text-[24px] font-semibold tracking-[-0.02em] text-[var(--c-text)]" title={payloadName(current.payload)}>{payloadName(current.payload) || "(sans nom)"}</h2>
                            {writable && isSecretItem && (() => {
                              const fav = !!(payloadEntity(current.payload).favorite);
                              return <button onClick={() => void toggleFavorite()} aria-pressed={fav} className="btn btn-ghost btn-icon shrink-0" style={{ color: fav ? "#f5c04a" : undefined }} title={fav ? "Retirer des épinglés" : "Épingler"} aria-label={fav ? "Retirer des épinglés" : "Épingler"}><IconStar size={17} filled={fav} /></button>;
                            })()}
                          </div>
                          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[var(--c-text-muted)]">
                            {current.payload.kind === "login" && current.payload.login.uris[0]?.uri && <><a href={current.payload.login.uris[0].uri} target="_blank" rel="noopener noreferrer" className="max-w-[260px] truncate">{uriHost(current.payload.login.uris[0].uri)}</a><span>·</span></>}
                            <span>{capitalize(KIND_LABELS[current.payload.kind])}</span>
                            <span>·</span>
                            <span title={`${formatWhen(current.updatedAt)} · révision ${current.revision}`}>Modifié {formatAgo(current.updatedAt)}</span>
                          </p>
                        </div>
                      </div>
                      {(() => {
                        const p = current.payload;
                        const secret = primarySecret(p);
                        const user = primaryUser(p);
                        const totp = p.kind === "login" ? p.login.totp : null;
                        const site = p.kind === "login" ? p.login.uris[0]?.uri : null;
                        if (!secret && !user && !totp && !site) return null;
                        return (
                          <div className="flex flex-wrap gap-2">
                            {secret && <button onClick={() => copyValue(secret)} className="btn btn-primary btn-lg"><IconCopy size={15} /> Copier {withArticle(secret.label)}{!touch && <span className="kbd">C</span>}</button>}
                            {user && <button onClick={() => copyValue(user)} className="btn btn-secondary btn-lg"><IconCopy size={15} /> Copier {withArticle(user.label)}</button>}
                            {totp && <button onClick={() => copyTotp(totp)} className="btn btn-secondary btn-lg"><IconShieldClock size={15} /> Copier le code 2FA</button>}
                            {site && /^https?:\/\//i.test(site) && <a href={site} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-lg hover:no-underline"><IconExternal size={15} /> Ouvrir le site</a>}
                          </div>
                        );
                      })()}
                      <ItemView payload={current.payload} index={index} />
                      {isSecret(current.payload) && (
                        <AttachmentsPanel key={current.id} vault={vault} item={current} writable={writable} offline={!!ctx.session.offline} session={ctx.session} onChanged={() => void load()} notify={ctx.notify} error={ctx.error} />
                      )}
                    </>
                  ) : (
                    <p className="callout callout-danger">Impossible de déchiffrer cet élément : {current.error}. Il a peut-être été chiffré avec une clé de vault antérieure, ou altéré.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {folderMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setFolderMenu(null)} />
          <div className="popover fixed z-40 w-44 py-1" role="menu" style={{ left: Math.max(8, Math.min(folderMenu.x - 176, window.innerWidth - 184)), top: Math.min(folderMenu.y + 4, window.innerHeight - 320) }}>
            {NEW_KINDS.filter((k) => k === "sep" || k === "group" || FOLDER_KINDS.has(k)).map((k, i) => {
              if (k === "sep") return <div key={i} className="menu-sep" />;
              const Icon = KIND_ICONS[k];
              return (
                <button key={k} role="menuitem" onClick={() => {
                  const folderId = folderMenu.folderId;
                  setFolderMenu(null);
                  if (k === "group") setNaming({ mode: "create", parentId: folderId });
                  else { setSelected(null); setMode({ kind: "new", itemKind: k, groupId: folderId }); }
                }} className="menu-item">
                  <Icon size={13} /> {capitalize(KIND_LABELS[k])}
                </button>
              );
            })}
          </div>
        </>
      )}
      {confirmDelete && current && (
        <ConfirmDialog
          title={`Supprimer « ${current.ok ? payloadName(current.payload) : current.id.slice(0, 8)} » ?`}
          message={(current.ok && current.payload.kind === "group" ? "Le dossier est supprimé ; ce qu'il contient remonte à la racine lors de la prochaine synchronisation de chaque appareil." : "Chaque appareil synchronisé le retire à son tour.") + " Il reste dans la corbeille du vault, d'où il peut être restauré."}
          confirmLabel="Supprimer"
          danger
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {help && <ShortcutsHelp onClose={closeHelp} />}
      {merging.dialog}
      {sharing && current?.ok && isSecret(current.payload) && <ShareLinkDialog session={ctx.session} item={current.payload} onClose={closeSharing} />}
      {history && current && (
        <ItemHistory
          vault={vault}
          item={current}
          index={index}
          writable={writable}
          onClose={closeHistory}
          onRestored={() => { setHistory(false); ctx.notify("Version restaurée."); void load(); }}
        />
      )}
      {moveTo && current?.ok && (
        <ConfirmDialog
          title={`Déplacer vers « ${moveTo.name} » ?`}
          message={`« ${payloadName(current.payload)} » est re-chiffré sous la clé de ${moveTo.name} et retiré d'ici. ${moveTo.kind === "shared" ? "Tous les membres de ce vault pourront le lire, secrets compris." : ""} Ce qu'il référence (dossier, clé du trousseau, relais) ne suit pas : déplacez-les aussi si besoin.`}
          confirmLabel="Déplacer"
          onConfirm={doMove}
          onCancel={() => setMoveTo(null)}
        >
          {current.payload.kind === "group" && <p className="callout callout-warn">Seul le dossier lui-même est déplacé, pas son contenu.</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Ce qui peut naître dans un dossier. */
const FOLDER_KINDS = new Set<ItemKind>(["login", "note", "card", "identity", "api-key", "aws", "host", "sql-connection"]);

function payloadIdOf(p: Payload): string {
  return payloadEntity(p).id;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
