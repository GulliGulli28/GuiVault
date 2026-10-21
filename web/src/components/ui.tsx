/** Petites briques partagées par toutes les pages : ce que Guiterm a réparti
 * entre `GuiVaultPanel` (empreinte, badge de confiance) et `App` (les
 * notifications). */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { fingerprintTrust, pinFingerprint, type FingerprintTrust } from "../lib/pins";
import { useModalSurface } from "../hooks/useModalSurface";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconCheck, IconClose, IconCopy, IconEye, IconEyeOff, IconUpload } from "./ui-icons";

// ─── Presse-papier ───────────────────────────────────────────────────────────

// Ce qui est copié s'efface au bout du délai réglé (`lib/clipboard.ts`).
export { copyText };

export function CopyButton({ value, label = "Copier", size = 15, className = "" }: { value: string; label?: string; size?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => {
        copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`btn btn-ghost btn-icon text-[var(--c-text-muted)] ${className}`}
    >
      {copied ? <IconCheck size={size} className="text-[var(--c-ok)]" /> : <IconCopy size={size} />}
    </button>
  );
}

/** L'empreinte, en police à chasse fixe, avec un bouton pour la copier —
 * c'est ce qu'on lit à voix haute ou colle dans une messagerie. */
export function Fingerprint({ value }: { value: string }) {
  return (
    <span className="flex min-w-0 max-w-full items-start gap-1">
      <code className="min-w-0 break-all font-mono text-[12px] leading-snug text-[var(--c-text)]">{value}</code>
      <CopyButton value={value} label="Copier l'empreinte" size={13} className="h-7 w-7" />
    </span>
  );
}

/** L'état de confiance d'une empreinte, avec le bouton d'épinglage quand il
 * manque. Une empreinte **changée** est affichée comme une alerte : c'est
 * exactement ce qu'un serveur qui substitue une clé produirait. */
export function TrustBadge({ email, fingerprint, onPinned }: { email: string; fingerprint: string; onPinned: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const trust: FingerprintTrust = fingerprintTrust(email, fingerprint);
  if (trust.kind === "pinned") {
    return <span className="tag tag-accent" title="Empreinte vérifiée et épinglée">vérifiée</span>;
  }
  return (
    <>
      {trust.kind === "changed" ? (
        <span className="tag" style={{ background: "color-mix(in srgb, var(--c-danger) 15%, transparent)", color: "var(--c-danger)" }} title={`Empreinte précédemment vérifiée : ${trust.previous}`}>
          clé changée !
        </span>
      ) : (
        <span className="tag" title="Empreinte jamais vérifiée">non vérifiée</span>
      )}
      <button type="button" onClick={() => setConfirm(true)} className="btn btn-secondary btn-sm">Vérifier…</button>
      {confirm && (
        <ConfirmDialog
          title={`Vérifier l'empreinte de ${email}`}
          message={
            (trust.kind === "changed"
              ? `ATTENTION : la clé de ${email} a changé depuis la dernière vérification (${trust.previous}). Si cette personne n'a pas recréé son compte, quelqu'un se fait passer pour elle — ou le serveur ment. `
              : "") +
            `Demandez à ${email} son empreinte par un autre canal (de vive voix, messagerie interne — elle est affichée dans son panneau GuiVault et sur sa page Compte) et comparez-la à : ${fingerprint}. ` +
            "Ne confirmez que si les deux sont identiques : c'est la seule protection contre un serveur qui substituerait sa propre clé pour lire vos vaults partagés."
          }
          confirmLabel="Elles sont identiques, épingler"
          danger={trust.kind === "changed"}
          onConfirm={() => {
            setConfirm(false);
            pinFingerprint(email, fingerprint);
            onPinned();
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}

// ─── Secrets ────────────────────────────────────────────────────────────────

/** Une valeur masquée par défaut : révéler, copier. Pour les mots de passe et
 * passphrases dans la vue d'un item. */
export function SecretValue({ value, mono = true }: { value: string; mono?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <span className={`min-w-0 flex-1 break-all ${mono ? "font-mono text-[13.5px]" : "text-[13.5px]"} text-[var(--c-text)] ${shown ? "" : "tracking-[0.12em]"}`}>{shown ? <ColoredSecret value={value} /> : "•".repeat(Math.min(14, Math.max(8, value.length)))}</span>
      <button type="button" onClick={() => setShown((s) => !s)} className="btn btn-ghost btn-icon text-[var(--c-text-muted)]" title={shown ? "Masquer" : "Révéler"} aria-label={shown ? "Masquer" : "Révéler"}>
        {shown ? <IconEyeOff size={15} /> : <IconEye size={15} />}
      </button>
      <CopyButton value={value} />
    </span>
  );
}

/** Un secret affiché : les chiffres et les symboles en couleur, pour qu'on
 * distingue un 0 d'un O et un l d'un 1 en le recopiant. */
export function ColoredSecret({ value }: { value: string }) {
  const parts: ReactNode[] = [];
  let run = "";
  let runKind: "letter" | "digit" | "symbol" | null = null;
  const flush = () => {
    if (!run) return;
    parts.push(runKind === "letter" ? run : <span key={parts.length} className={runKind === "digit" ? "text-[var(--c-warn-text)]" : "text-[var(--c-danger-text)]"}>{run}</span>);
    run = "";
  };
  for (const ch of value) {
    const kind = /\p{L}/u.test(ch) ? "letter" : /\p{N}/u.test(ch) ? "digit" : "symbol";
    if (kind !== runKind) flush();
    runKind = kind;
    run += ch;
  }
  flush();
  return <>{parts}</>;
}

/** Champ de mot de passe avec l'œil pour le montrer. */
export function PasswordInput({ value, onChange, placeholder, autoFocus, autoComplete, className = "", name, id }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; autoComplete?: string; className?: string; name?: string; id?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <input
        type={shown ? "text" : "password"}
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        className="input pr-10"
      />
      <button type="button" onClick={() => setShown((s) => !s)} tabIndex={-1} className="absolute right-1 top-1/2 -translate-y-1/2 btn btn-ghost btn-sm btn-icon text-[var(--c-text-muted)]" title={shown ? "Masquer" : "Afficher"}>
        {shown ? <IconEyeOff size={14} /> : <IconEye size={14} />}
      </button>
    </div>
  );
}

/** Un bouton « Choisir un fichier » à la place du contrôle natif, dont le
 * libellé suit la langue du navigateur (« Choose File ») et pas celle de
 * l'interface. Le nom du fichier choisi s'affiche à côté. */
export function FileButton({ label, accept, onFile, className = "", small = true }: {
  label: string; accept?: string; onFile: (file: File | undefined) => void; className?: string; small?: boolean;
}) {
  const [name, setName] = useState<string | null>(null);
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <label className={`btn btn-secondary ${small ? "btn-sm" : ""} cursor-pointer`}>
        <IconUpload size={14} /> {label}
        <input
          type="file"
          accept={accept}
          aria-label={label}
          onChange={(e) => { const f = e.target.files?.[0]; setName(f?.name ?? null); onFile(f); e.target.value = ""; }}
          className="sr-only"
        />
      </label>
      {name && <span className="min-w-0 truncate text-[12.5px] text-[var(--c-text-muted)]">{name}</span>}
    </span>
  );
}

// ─── Mise en page de formulaire ──────────────────────────────────────────────

/** L'aide est hors du `<label>` : dedans, elle ferait partie du nom
 * accessible du champ (« Commande Peut contenir des variables… »).
 * `group` pour un éditeur composite (liste de relais, variables) : un
 * `<label>` autour de plusieurs contrôles donnerait son texte à chacun de
 * leurs boutons, d'où un groupe étiqueté plutôt qu'un libellé. */
export function Field({ label, hint, children, className = "", group }: { label: string; hint?: string; children: ReactNode; className?: string; group?: boolean }) {
  return (
    <div className={className}>
      {group ? (
        <div role="group" aria-label={label}>
          <span className="field-label">{label}</span>
          {children}
        </div>
      ) : (
        <label className="block">
          <span className="field-label">{label}</span>
          {children}
        </label>
      )}
      {hint && <p className="help-text mt-1">{hint}</p>}
    </div>
  );
}

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`eyebrow ${className}`}>{children}</p>;
}

/** Une ligne « libellé : valeur » de la vue d'un item, dans la carte de sa
 * section. Étroit : le libellé passe au-dessus. */
export function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div data-row className="flex min-h-[48px] flex-wrap items-center gap-x-4 gap-y-0.5 px-[18px] py-2.5 max-sm:px-3.5">
      <span className="w-[120px] shrink-0 text-[13px] text-[var(--c-text-muted)] max-sm:w-full">{label}</span>
      <span className={`min-w-0 flex-[1_1_11rem] break-words text-[13.5px] text-[var(--c-text)] ${mono ? "font-mono" : ""}`}>{children}</span>
    </div>
  );
}

// ─── Info au clic ────────────────────────────────────────────────────────────

/** Le détail d'un réglage ou d'une limite, à la demande (`docs/DESIGN.md` :
 * pas de paragraphe d'explication) : un ⓘ qui ouvre trois puces au plus. */
export function InfoTip({ label, items, align = "left" }: { label: string; items: { text: ReactNode; tone?: "ok" | "warn" }[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  return (
    <span className="relative inline-flex align-middle">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={label} title={label} className={`inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors ${open ? "bg-[var(--c-active)] text-[var(--c-text)]" : "text-[var(--c-text-muted)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text)]"}`}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" /><path d="M8 7.25v3.75M8 5.1v.05" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <span role="tooltip" className={`popover absolute top-7 z-30 flex w-[300px] max-w-[calc(100vw-2rem)] flex-col gap-2 p-3.5 text-left text-[13px] font-normal leading-snug text-[var(--c-text-secondary)] ${align === "right" ? "right-0" : "left-0"}`}>
            {items.map((it, i) => (
              <span key={i} className={`flex gap-2 ${it.tone === "warn" ? "text-[var(--c-warn-text)]" : ""}`}>
                {it.tone === "warn"
                  ? <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="mt-0.5 shrink-0" aria-hidden="true"><path d="M8 2.5 14 13H2z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /><path d="M8 6.75v2.5M8 11.1v.05" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                  : it.tone === "ok" ? <IconCheck size={15} className="mt-0.5 shrink-0 text-[var(--c-ok)]" /> : <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--c-text-muted)]" />}
                <span className="min-w-0">{it.text}</span>
              </span>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

/** Une ligne de réglage : titre (et ce qui l'accompagne), une ligne d'aide,
 * le contrôle à droite. Dans une `card`, les lignes se séparent seules. */
export function SettingRow({ title, desc, children, htmlFor }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="setting-row">
      <div className="min-w-0 flex-[1_1_200px]">
        {htmlFor ? <label htmlFor={htmlFor} className="setting-title flex flex-wrap items-center gap-1.5">{title}</label> : <div className="setting-title flex flex-wrap items-center gap-1.5">{title}</div>}
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// ─── Menu déroulant ──────────────────────────────────────────────────────────

/** Un bouton qui ouvre un menu sous lui ; Échap ou un clic ailleurs le
 * referme. `trigger` reçoit l'état et de quoi basculer ; `children` reçoit
 * de quoi refermer après un choix. */
export function Dropdown({ trigger, children, align = "right", className = "w-56", label }: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  return (
    <div className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={close} />
          <div role="menu" aria-label={label} className={`popover absolute z-30 mt-1.5 max-h-[70vh] overflow-y-auto py-1 ${align === "right" ? "right-0" : "left-0"} ${className}`}>
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Modale générique ────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: title });
  return (
    <>
      <div className="fixed inset-0 z-40 bg-[rgba(5,6,8,0.55)]" onClick={onClose} />
      <div ref={ref} {...dialogProps} className={`modal fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col ${wide ? "max-w-2xl" : "max-w-lg"}`}>
        <div className="flex items-center justify-between gap-2 px-6 pb-1 pt-5">
          <h2 className="min-w-0 truncate text-[18px] font-semibold text-[var(--c-text)]">{title}</h2>
          <button onClick={onClose} className="btn btn-ghost btn-icon" title="Fermer" aria-label="Fermer"><IconClose size={14} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-3">{children}</div>
      </div>
    </>
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  kind: "info" | "error";
  message: string;
}

let nextToast = 1;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((kind: Toast["kind"], message: string) => {
    const id = nextToast++;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    // Une erreur reste jusqu'à ce qu'on la ferme ; une info s'efface seule.
    if (kind === "info") setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);
  const notify = useCallback((m: string) => push("info", m), [push]);
  const error = useCallback((m: string) => push("error", m), [push]);
  return { toasts, notify, error, dismiss };
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack pointer-events-none fixed bottom-3 right-3 z-[60] flex w-[min(24rem,calc(100%-1.5rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className={`pointer-events-auto popover flex items-start gap-2.5 px-3.5 py-2.5 text-[13px] text-[var(--c-text)] ${t.kind === "error" ? "border border-[color-mix(in_srgb,var(--c-danger)_40%,transparent)]" : ""}`}>
          {t.kind === "error" ? <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-[var(--c-danger)]" /> : <IconCheck size={15} className="mt-0.5 shrink-0 text-[var(--c-ok)]" />}
          <span className="min-w-0 flex-1 break-words leading-relaxed">{t.message}</span>
          <button onClick={() => onDismiss(t.id)} className="btn btn-ghost btn-sm btn-icon -my-1 -mr-1.5" title="Fermer" aria-label="Fermer"><IconClose size={12} /></button>
        </div>
      ))}
    </div>
  );
}

/** Un délai avant de montrer « Chargement… » : une liste qui arrive en 80 ms
 * n'a pas besoin de clignoter. */
export function useDelayed(active: boolean, ms = 250): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return shown;
}

export function Loading({ label = "Chargement…" }: { label?: string }) {
  return <p className="px-2 py-6 text-center text-[13px] text-[var(--c-text-muted)]">{label}</p>;
}

/** Une date proche, dite comme on la dit : « à l'instant », « il y a
 * 5 min », « hier », « il y a 3 j », puis la date courte. */
export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "jamais";
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  const days = Math.floor(s / 86400);
  if (days === 1) return "hier";
  if (days < 7) return `il y a ${days} j`;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: new Date(iso).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

/** Une date en français, quel que soit le réglage du navigateur : le reste
 * de l'interface l'est. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "jamais";
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}
