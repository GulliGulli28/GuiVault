import { useEffect, useRef, useState } from "react";
import { uuid } from "../lib/bytes";
import type { CustomIcon } from "../lib/types";
import { BUILTIN_ICONS, CATEGORY_LABELS, type BuiltinIconDef } from "./icons";

/** Le sélecteur d'icône de Guiterm (`IconPicker.tsx`), même banque, mêmes
 * onglets — la « Banque » et « Mes icônes », qui sont ici les icônes du
 * vault. Importer une image en crée une dans le vault (`onAddIcon`), comme
 * Guiterm l'ajoute à son workspace ; sans `onAddIcon`, l'onglet renvoie à
 * « Nouveau → Icône ». */
interface IconPickerProps {
  value: string | null;
  customIcons: CustomIcon[];
  onSelect: (iconId: string | null) => void;
  /** Fermeture par un clic à côté seulement : `onSelect` ferme lui-même. */
  onClose: () => void;
  onAddIcon?: (icon: CustomIcon) => Promise<void>;
}

type Tab = "builtin" | "custom";
type Category = BuiltinIconDef["category"];

const MAX_BYTES = 64 * 1024;

export function IconPicker({ value, customIcons, onSelect, onClose, onAddIcon }: IconPickerProps) {
  const isCustom = value !== null && customIcons.some((i) => i.id === value);
  const [tab, setTab] = useState<Tab>(isCustom ? "custom" : "builtin");
  const [category, setCategory] = useState<Category>(() => BUILTIN_ICONS.find((i) => i.id === value)?.category ?? "linux");
  const [importName, setImportName] = useState("");
  const [importDataUrl, setImportDataUrl] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const loadFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setImportError("64 Ko au plus.");
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      setImportDataUrl(String(r.result));
      setImportName(file.name.replace(/\.[^.]+$/, ""));
      setImportError(null);
    };
    r.readAsDataURL(file);
  };

  const confirmImport = async () => {
    if (!onAddIcon || !importDataUrl || !importName.trim()) return;
    const icon: CustomIcon = { id: uuid(), name: importName.trim(), dataUrl: importDataUrl };
    setBusy(true);
    try {
      await onAddIcon(icon);
      setImportDataUrl(null);
      onSelect(icon.id);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const filteredBuiltin = BUILTIN_ICONS.filter((i) => i.category === category);

  const btnClass = (active: boolean) =>
    `rounded px-2 py-1 text-xs font-medium transition-colors ${active ? "bg-[var(--c-accent)] text-white" : "text-[var(--c-text-secondary)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]"}`;

  // Dans le flux du formulaire plutôt que flottant comme dans Guiterm (où il
  // vit dans une modale) : le formulaire défile, un popover absolu se ferait
  // couper par le bord bas.
  return (
    <div ref={ref} className="popover mt-2 w-72 max-w-full p-3">
      <div className="mb-2.5 flex items-center gap-1">
        <button type="button" onClick={() => setTab("builtin")} className={btnClass(tab === "builtin")}>Banque</button>
        <button type="button" onClick={() => setTab("custom")} className={btnClass(tab === "custom")}>Mes icônes</button>
        {value && (
          <button type="button" onClick={() => onSelect(null)} className="btn btn-ghost btn-sm ml-auto text-[var(--c-danger)]">Retirer l'icône</button>
        )}
      </div>

      {tab === "builtin" && (
        <>
          <div className="mb-2 flex gap-1">
            {(["linux", "system", "generic"] as Category[]).map((c) => (
              <button key={c} type="button" onClick={() => setCategory(c)} className={btnClass(category === c)}>{CATEGORY_LABELS[c]}</button>
            ))}
          </div>
          <div className="grid grid-cols-5 gap-1">
            {filteredBuiltin.map((icon) => (
              <button
                key={icon.id}
                type="button"
                onClick={() => onSelect(icon.id)}
                title={icon.name}
                className={`flex flex-col items-center gap-0.5 rounded p-1.5 transition-colors ${value === icon.id ? "bg-[var(--c-accent-dim)] ring-2 ring-[var(--c-accent-text)]" : "hover:bg-[var(--c-hover)]"}`}
              >
                {icon.render(28)}
                <span className="w-full truncate text-center text-[9px] leading-tight text-[var(--c-text-secondary)]">{icon.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {tab === "custom" && (
        <>
          {importError && <p className="callout callout-danger mb-2 py-1">{importError}</p>}
          {importDataUrl ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <img src={importDataUrl} width={40} height={40} className="rounded bg-[var(--c-bg3)] object-contain" alt="" />
                <input value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="Nom de l'icône" aria-label="Nom de l'icône" className="input flex-1" autoFocus />
              </div>
              <div className="flex gap-1.5">
                <button type="button" onClick={() => void confirmImport()} disabled={busy || !importName.trim()} className="btn btn-primary flex-1">{busy ? "Enregistrement…" : "Enregistrer dans le vault"}</button>
                <button type="button" onClick={() => setImportDataUrl(null)} className="btn btn-secondary">Annuler</button>
              </div>
            </div>
          ) : (
            <>
              {customIcons.length === 0 && <p className="py-3 text-center text-xs text-[var(--c-text-muted)]">Aucune icône dans ce vault</p>}
              <div className="grid grid-cols-5 gap-1">
                {customIcons.map((icon) => (
                  <button
                    key={icon.id}
                    type="button"
                    onClick={() => onSelect(icon.id)}
                    title={icon.name}
                    className={`flex flex-col items-center gap-0.5 rounded p-1.5 transition-colors ${value === icon.id ? "bg-[var(--c-accent-dim)] ring-2 ring-[var(--c-accent-text)]" : "hover:bg-[var(--c-hover)]"}`}
                  >
                    <img src={icon.dataUrl} width={28} height={28} className="rounded object-contain" alt={icon.name} />
                    <span className="w-full truncate text-center text-[9px] leading-tight text-[var(--c-text-secondary)]">{icon.name}</span>
                  </button>
                ))}
              </div>
              {onAddIcon ? (
                <label className="mt-2 block w-full cursor-pointer rounded-md border border-dashed border-[var(--c-border)] py-1.5 text-center text-xs text-[var(--c-text-muted)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent-text)]">
                  + Importer une icône
                  <input type="file" accept="image/svg+xml,image/png,image/webp" onChange={(e) => loadFile(e.target.files?.[0])} className="sr-only" />
                </label>
              ) : (
                <p className="help-text mt-2 text-center">Ajoutez-en avec « Nouveau → Icône ».</p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Le champ « Icône » d'un formulaire d'hôte ou de dossier, comme dans
 * Guiterm : l'aperçu, « Choisir une icône », et le sélecteur en dessous. */
export function IconField({ value, onChange, customIcons, onAddIcon, fallback }: {
  value: string | null;
  onChange: (id: string | null) => void;
  customIcons: CustomIcon[];
  onAddIcon?: (icon: CustomIcon) => Promise<void>;
  /** L'icône montrée quand il n'y en a pas de choisie. */
  fallback: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--c-border)] bg-[var(--c-bg3)] text-[var(--c-text-muted)]">
          {value ? <IconPreview iconId={value} customIcons={customIcons} fallback={fallback} /> : fallback}
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className="btn btn-secondary">{value ? "Changer l'icône" : "Choisir une icône"}</button>
        {value && <button type="button" onClick={() => onChange(null)} className="btn btn-ghost btn-sm">Retirer</button>}
      </div>
      {open && (
        <IconPicker
          value={value}
          customIcons={customIcons}
          onSelect={(id) => { onChange(id); setOpen(false); }}
          onClose={() => setOpen(false)}
          onAddIcon={onAddIcon}
        />
      )}
    </div>
  );
}

function IconPreview({ iconId, customIcons, fallback }: { iconId: string; customIcons: CustomIcon[]; fallback: React.ReactNode }) {
  const builtin = BUILTIN_ICONS.find((i) => i.id === iconId);
  if (builtin) return <>{builtin.render(18)}</>;
  const custom = customIcons.find((i) => i.id === iconId);
  if (custom) return <img src={custom.dataUrl} width={18} height={18} className="rounded object-contain" alt={custom.name} />;
  // Une icône qu'on ne sait pas dessiner (venue d'un autre vault) : on
  // garde son identifiant, on le dit.
  return <span title={`Icône inconnue ici : ${iconId}`}>{fallback}</span>;
}
