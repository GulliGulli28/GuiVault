import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { VaultIndex } from "../../lib/entities";
import { groupPath } from "../../lib/entities";
import type { Group, Payload } from "../../lib/types";
import { Field } from "../ui";

export { Field };

/** Le brouillon d'un formulaire. Le popup de l'extension se ferme au premier
 * clic hors de lui : pour rouvrir un formulaire là où on l'avait laissé,
 * `ItemForm` fait construire à intervalles le payload que `onSave`
 * recevrait — sans rien enregistrer (`snapshot`) — et le rend au formulaire
 * suivant (`draft`, lu par `useSeed`). Sans fournisseur, rien de tout ça. */
export interface DraftContextValue {
  draft?: Payload;
  snapshot?: (save: () => Promise<void>) => void;
}

export const DraftContext = createContext<DraftContextValue>({});

/** Les valeurs de départ d'un formulaire : le brouillon s'il est du même
 * type, sinon l'élément modifié. `initial` garde son sens (titre
 * « Modifier », historique du mot de passe). */
export function useSeed<T>(initial: T | undefined, pick: (p: Payload) => T | undefined): T | undefined {
  const { draft } = useContext(DraftContext);
  const [seed] = useState(() => (draft ? pick(draft) : undefined) ?? initial);
  return seed;
}

/** L'enveloppe commune des formulaires : erreur en tête, boutons en pied,
 * Entrée soumet. `onSave` peut rejeter : le message s'affiche ici. */
export function FormShell({ title, onSave, onCancel, children, saveLabel = "Enregistrer", validate }: {
  title: string;
  onSave: () => Promise<void>;
  onCancel: () => void;
  children: ReactNode;
  saveLabel?: string;
  /** Un message qui bloque l'enregistrement, ou `null`. */
  validate?: () => string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { snapshot } = useContext(DraftContext);
  // Après chaque rendu (donc chaque frappe), un peu plus tard : le brouillon.
  useEffect(() => {
    if (!snapshot) return;
    const t = setTimeout(() => snapshot(onSave), 300);
    return () => clearTimeout(t);
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = validate?.() ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      {/* Mobile (maquette `MEdition`) : Annuler · titre · Enregistrer. */}
      <div className="flex min-h-[52px] shrink-0 items-center justify-between gap-2 border-b border-[var(--c-border)] px-5 py-2 max-md:min-h-[60px] max-md:px-3 max-md:pt-[calc(0.5rem+var(--inset-top))]">
        <button type="button" onClick={onCancel} className="shrink-0 px-1 text-[15px] text-[var(--c-accent-text)] md:hidden">Annuler</button>
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-[var(--c-text)] max-md:flex-1 max-md:text-center max-md:text-[17px]">{title}</h2>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onCancel} className="btn btn-ghost max-md:hidden">Annuler</button>
          <button type="submit" disabled={busy} className="btn btn-primary max-md:h-[38px] max-md:rounded-xl max-md:text-[15px]">{busy ? "Enregistrement…" : saveLabel}</button>
        </div>
      </div>
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-6 max-md:px-4">
        <div className="max-w-[720px] space-y-5">
          {error && <p className="callout callout-danger">{error}</p>}
          {children}
        </div>
      </div>
    </form>
  );
}

/** Le dossier, dans un `<select>` à plat avec le chemin complet — le
 * `GroupTreePicker` de Guiterm en plus simple. `exclude` écarte un dossier
 * et ses descendants (un dossier ne peut pas être son propre parent). */
export function GroupSelect({ groups, value, onChange, exclude }: { groups: Group[]; value: string | null; onChange: (id: string | null) => void; exclude?: string }) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const isUnder = (g: Group): boolean => {
    if (!exclude) return false;
    const seen = new Set<string>();
    let cur: string | null = g.id;
    while (cur && !seen.has(cur)) {
      if (cur === exclude) return true;
      seen.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    return false;
  };
  const options = groups
    .filter((g) => !isUnder(g))
    .map((g) => ({ id: g.id, path: groupPath(byId, g.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="input">
      <option value="">Racine</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.path}</option>)}
    </select>
  );
}

export function HostSelect({ index, value, onChange, none = "Aucun", exclude, label }: { index: VaultIndex; value: string | null; onChange: (id: string | null) => void; none?: string; exclude?: string; label?: string }) {
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="input">
      <option value="">{none}</option>
      {index.hosts.filter((h) => h.id !== exclude && (h.kind ?? "ssh") === "ssh").map((h) => <option key={h.id} value={h.id}>{h.label} — {h.username ? `${h.username}@` : ""}{h.address}</option>)}
    </select>
  );
}

/** Étiquettes séparées par des virgules ou des espaces — par des virgules
 * seulement (`commas`) pour des noms qui en contiennent (dossiers). */
export function TagsInput({ value, onChange, placeholder = "prod, web, paris", commas }: { value: string[]; onChange: (tags: string[]) => void; placeholder?: string; commas?: boolean }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <input
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(Array.from(new Set(e.target.value.split(commas ? /,+/ : /[,\s]+/).map((t) => t.trim()).filter(Boolean))));
      }}
      placeholder={placeholder}
      className="input"
    />
  );
}

export function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-[var(--c-text)]">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
        <span>{label}</span>
      </label>
      {hint && <p className="help-text pl-[22px]">{hint}</p>}
    </div>
  );
}

export function parsePort(s: string, fallback: number): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : fallback;
}
