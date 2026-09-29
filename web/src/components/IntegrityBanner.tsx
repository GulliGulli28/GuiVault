/** L'alerte « vault qui ne correspond pas à son manifeste » (`lib/manifest.ts`,
 * `docs/MANIFESTE.md`), en tête de la page du vault et dans le popup de
 * l'extension. Tant qu'on n'en a pas pris acte, rien n'est écrit d'ici sur ce
 * vault (`IntegrityError`) ; il reste lisible. */
import { useCallback, useState } from "react";
import { problemItem, problemText, type ManifestProblem } from "../lib/manifest";
import { ConfirmDialog } from "./ConfirmDialog";

export function IntegrityBanner({ name, problems, canFix, nameOf, onAccept, compact = false }: {
  name: string;
  problems: ManifestProblem[];
  /** Peut réécrire le manifeste (écrivain et plus, hors accès d'urgence) ;
   * sinon, prendre acte ne vaut que pour ce navigateur. */
  canFix: boolean;
  nameOf?: (itemId: string) => string | undefined;
  onAccept: () => Promise<void>;
  compact?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancel = useCallback(() => setConfirm(false), []);
  if (problems.length === 0) return null;
  const shown = compact ? 3 : 6;
  const accept = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      await onAccept();
    } finally {
      setBusy(false);
    }
  };
  const itemsOnly = problems.every((p) => problemItem(p) !== null);
  return (
    <div role="alert" className={`shrink-0 ${compact ? "p-2 pb-0" : "px-4 pt-3"}`}>
      <div className={`callout callout-danger flex items-start gap-3 ${compact ? "text-[11.5px]" : "text-[12.5px]"}`}>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">Le vault « {name} » ne correspond pas à son manifeste.</p>
          {!compact && (
            <p className="max-md:hidden">
              Le manifeste est la liste des éléments que ses membres y ont laissés, scellée sous la clé du vault : le serveur
              ne peut pas la contrefaire. Ce qu'il sert en diffère :
            </p>
          )}
          <ul className="list-disc space-y-0.5 pl-4">
            {problems.slice(0, shown).map((p, i) => <li key={i}>{capitalize(problemText(p, nameOf))}.</li>)}
            {problems.length > shown && <li>et {problems.length - shown} autre{problems.length - shown > 1 ? "s" : ""}.</li>}
          </ul>
          <p>
            {compact
              ? "Rien n'y est écrit d'ici tant que vous n'en avez pas pris acte."
              : "Soit sa base a été restaurée ou modifiée à la main, soit il est compromis. Rien n'y est écrit d'ici tant que vous n'en avez pas pris acte : vérifiez les éléments en cause avant de vous y fier, et prévenez l'administrateur du serveur."}
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm shrink-0" disabled={busy} onClick={() => setConfirm(true)}>
          Prendre acte…
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Prendre acte de l'état de « ${name} » ?`}
          message={
            canFix
              ? "Le manifeste est réécrit d'après ce que le serveur sert maintenant, et cet état devient la référence pour tous les membres : une version rejouée est gardée, un élément revenu aussi, un élément retenu est oublié. À faire seulement si vous savez d'où vient l'écart — une sauvegarde restaurée, par exemple — ou après avoir vérifié les éléments en cause."
              : itemsOnly
                ? "Vous ne pouvez pas écrire dans ce vault : seul un membre qui le peut réécrit son manifeste. L'alerte reviendra à la prochaine lecture tant que ce n'est pas fait."
                : "Ce navigateur accepte la version actuelle du manifeste. Vous ne pouvez pas écrire dans ce vault : si des éléments sont en cause, ils resteront signalés tant qu'un membre qui le peut n'a pas réécrit le manifeste."
          }
          confirmLabel="Prendre acte"
          danger={canFix}
          onConfirm={() => void accept()}
          onCancel={cancel}
        />
      )}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
