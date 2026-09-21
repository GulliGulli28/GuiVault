import logo from "../assets/logo.png";
import logoGray from "../assets/logo-gray.png";

/** Le logo de GuiVault. `locked` : la version grise — la même que l'icône
 * de l'extension quand il faut se reconnecter — pour l'écran de connexion
 * et le popup verrouillé : en couleur, c'est qu'on est dedans. */
export function Logo({ size = 24, locked = false, className = "" }: { size?: number; locked?: boolean; className?: string }) {
  return <img src={locked ? logoGray : logo} width={size} height={size} alt="" aria-hidden="true" draggable={false} className={`shrink-0 select-none ${className}`} />;
}
