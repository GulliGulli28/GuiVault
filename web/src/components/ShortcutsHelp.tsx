/** Les raccourcis clavier (« ? ») : ceux d'un vault, et la recherche
 * globale, qui vaut partout. */
import { useModalSurface } from "../hooks/useModalSurface";

export const VAULT_SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Ctrl", "K"], label: "Rechercher dans tous les vaults (partout)" },
  { keys: ["/"], label: "Filtrer ce vault" },
  { keys: ["↑", "↓"], label: "Élément précédent / suivant (ou j / k)" },
  { keys: ["c"], label: "Copier le mot de passe (ou le secret de l'élément)" },
  { keys: ["u"], label: "Copier l'utilisateur" },
  { keys: ["e"], label: "Modifier" },
  { keys: ["h"], label: "Historique" },
  { keys: ["f"], label: "Favori" },
  { keys: ["Suppr"], label: "Supprimer (vers la corbeille)" },
  { keys: ["?"], label: "Cette aide" },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: "Raccourcis clavier" });
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div ref={ref} {...dialogProps} className="modal fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-[var(--c-text)]">Raccourcis clavier</h2>
          <button onClick={onClose} className="btn btn-ghost btn-sm" autoFocus>Fermer</button>
        </div>
        <table className="w-full text-[12.5px]">
          <tbody>
            {VAULT_SHORTCUTS.map((s) => (
              <tr key={s.label} className="border-t border-[var(--c-border)]">
                <td className="whitespace-nowrap py-1.5 pr-3">{s.keys.map((k) => <span key={k} className="kbd mr-1">{k}</span>)}</td>
                <td className="py-1.5 text-[var(--c-text-secondary)]">{s.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="help-text mt-3">Les touches seules ne font rien pendant qu'on écrit dans un champ.</p>
      </div>
    </>
  );
}
