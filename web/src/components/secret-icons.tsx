/** Icônes des secrets et des outils, dans le trait de `ui-icons.tsx`
 * (boîte 16, trait 1.25) — à part pour garder ce fichier-là identique à
 * celui de Guiterm. */
type P = { size?: number; className?: string };

export function IconLogin({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="4.75" cy="8" r="0.9" fill="currentColor" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
      <circle cx="11.25" cy="8" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function IconNote({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M3.5 1.5h6l3 3v10h-9z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconCard({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M1.5 6.5h13" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4 10h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconIdentity({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="5.5" r="2.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M2.5 14c.6-3 2.7-4.5 5.5-4.5s4.9 1.5 5.5 4.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** Une clé d'API : des chevrons de code et une clé. */
export function IconApiKey({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="5" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M7.75 8h6.5M12 8v2.25M14.25 8v1.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconStar({ size = 16, className, filled }: P & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"} className={className}>
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

export function IconDice({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="5.5" cy="5.5" r="1" fill="currentColor" />
      <circle cx="10.5" cy="5.5" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="5.5" cy="10.5" r="1" fill="currentColor" />
      <circle cx="10.5" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconGlobe({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
      <path d="M1.75 8h12.5M8 1.75c2 2 2 10.5 0 12.5M8 1.75c-2 2-2 10.5 0 12.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconPasskey({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M1.5 13.5c.5-2.6 2.2-4 4.5-4 1 0 1.9.3 2.6.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="11.5" cy="9.5" r="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M11.5 11.5v3l1.2-1" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconTools({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 2v7M5.5 6.5L8 9l2.5-2.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 10.5v2a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function IconShieldClock({ size = 16, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 1.5l5 2v4c0 3.2-2.1 5.6-5 7-2.9-1.4-5-3.8-5-7v-4z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M8 5.5v3l1.8 1.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
