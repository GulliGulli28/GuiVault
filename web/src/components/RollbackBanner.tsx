/** L'alerte « vault revenu en arrière » (`lib/vaultRevisions.ts`), en tête de
 * l'interface web et du popup de l'extension. Elle reste tant qu'on n'en a
 * pas pris acte : c'est soit une sauvegarde restaurée (des modifications
 * perdues), soit un serveur qui sert une ancienne version du vault. */
import type { VaultRollback } from "../lib/vaultRevisions";

export function RollbackBanner({ rollbacks, onAccept, compact = false }: { rollbacks: VaultRollback[]; onAccept: (vaultId: string) => void; compact?: boolean }) {
  if (rollbacks.length === 0) return null;
  return (
    <div role="alert" className={`shrink-0 space-y-2 ${compact ? "p-2" : "px-4 pt-3"}`}>
      {rollbacks.map((r) => (
        <div key={r.vaultId} className={`callout callout-danger flex items-start gap-3 ${compact ? "text-[11.5px]" : "text-[12.5px]"}`}>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">Le vault « {r.name} » est revenu en arrière.</p>
            <p>
              Le serveur annonce la révision {r.seen}, alors que {compact ? "cette extension" : "ce navigateur"} a déjà vu la {r.known}.
              Soit sa base a été restaurée depuis une sauvegarde — les modifications faites depuis sont perdues —, soit il est
              compromis et sert une ancienne version : un ancien mot de passe, un élément supprimé qui revient.
              {!compact && " Vérifiez les derniers éléments de ce vault avant de vous y fier, et prévenez l'administrateur du serveur."}
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={() => onAccept(r.vaultId)}>
            J'ai compris
          </button>
        </div>
      ))}
    </div>
  );
}
