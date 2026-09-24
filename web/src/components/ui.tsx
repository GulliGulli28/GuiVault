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

export function CopyButton({ value, label = "Copier", size = 11, className = "" }: { value: string; label?: string; size?: number; className?: string }) {
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
      className={`btn btn-ghost btn-sm btn-icon ${className}`}
    >
      {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
    </button>
  );
}

/** L'empreinte, en police à chasse fixe, avec un bouton pour la copier —
 * c'est ce qu'on lit à voix haute ou colle dans une messagerie. */
export function Fingerprint({ value }: { value: string }) {
  return (
    <span className="flex min-w-0 max-w-full items-start gap-1">
      <code className="min-w-0 break-all font-mono text-[11px] leading-snug text-[var(--c-text)]">{value}</code>
      <CopyButton value={value} label="Copier l'empreinte" />
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
    <span className="flex min-w-0 items-center gap-1">
      <span className={`min-w-0 break-all ${mono ? "font-mono text-[12px]" : "text-[12.5px]"} text-[var(--c-text)]`}>{shown ? value : "•".repeat(Math.min(12, Math.max(6, value.length)))}</span>
      <button type="button" onClick={() => setShown((s) => !s)} className="btn btn-ghost btn-sm btn-icon" title={shown ? "Masquer" : "Révéler"} aria-label={shown ? "Masquer" : "Révéler"}>
        {shown ? <IconEyeOff size={12} /> : <IconEye size={12} />}
      </button>
      <CopyButton value={value} />
    </span>
  );
}

/** Champ de mot de passe avec l'œil pour le montrer. */
export function PasswordInput({ value, onChange, placeholder, autoFocus, autoComplete, className = "", name }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; autoComplete?: string; className?: string; name?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <input
        type={shown ? "text" : "password"}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        className="input pr-8"
      />
      <button type="button" onClick={() => setShown((s) => !s)} tabIndex={-1} className="absolute right-1 top-1/2 -translate-y-1/2 btn btn-ghost btn-sm btn-icon" title={shown ? "Masquer" : "Afficher"}>
        {shown ? <IconEyeOff size={12} /> : <IconEye size={12} />}
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
        <IconUpload size={12} /> {label}
        <input
          type="file"
          accept={accept}
          aria-label={label}
          onChange={(e) => { const f = e.target.files?.[0]; setName(f?.name ?? null); onFile(f); e.target.value = ""; }}
          className="sr-only"
        />
      </label>
      {name && <span className="min-w-0 truncate text-[11.5px] text-[var(--c-text-muted)]">{name}</span>}
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

/** Une ligne « libellé : valeur » de la vue d'un item. */
export function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(6rem,9rem)_1fr] items-start gap-x-3 gap-y-1 py-1">
      <span className="text-[11.5px] font-medium text-[var(--c-text-secondary)]">{label}</span>
      <span className={`min-w-0 break-words text-[12.5px] text-[var(--c-text)] ${mono ? "font-mono text-[12px]" : ""}`}>{children}</span>
    </div>
  );
}

// ─── Modale générique ────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: title });
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div ref={ref} {...dialogProps} className={`modal fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col ${wide ? "max-w-2xl" : "max-w-md"}`}>
        <div className="flex items-center justify-between gap-2 border-b border-[var(--c-border)] px-4 py-3">
          <h2 className="text-[14px] font-semibold text-[var(--c-text)]">{title}</h2>
          <button onClick={onClose} className="btn btn-ghost btn-sm btn-icon" title="Fermer" aria-label="Fermer"><IconClose size={12} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
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
    <div className="pointer-events-none fixed bottom-3 right-3 z-[60] flex w-[min(24rem,calc(100%-1.5rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className={`pointer-events-auto popover flex items-start gap-2 px-3 py-2 text-[12.5px] ${t.kind === "error" ? "border border-[color-mix(in_srgb,var(--c-danger)_40%,transparent)] text-[var(--c-text)]" : "text-[var(--c-text)]"}`}>
          <span className="min-w-0 flex-1 break-words leading-relaxed">{t.message}</span>
          <button onClick={() => onDismiss(t.id)} className="btn btn-ghost btn-sm btn-icon -mr-1" title="Fermer" aria-label="Fermer"><IconClose size={11} /></button>
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
  return <p className="px-2 py-6 text-center text-[12px] text-[var(--c-text-muted)]">{label}</p>;
}

/** Une date en français, quel que soit le réglage du navigateur : le reste
 * de l'interface l'est. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "jamais";
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}
