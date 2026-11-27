/** Après une connexion : faut-il proposer d'enregistrer ce qui a été tapé,
 * et pour quel identifiant ? Pur, testé (`capture.test.ts`). */

export interface Candidate {
  id: string;
  name: string;
  username: string;
  password: string;
  /** `loginScore` sur la page (le meilleur des cadres) : 1 = un autre
   * sous-domaine du même domaine seulement. */
  score: number;
}

export type Capture = { mode: "new"; loginId: null; loginName: null } | { mode: "update"; loginId: string; loginName: string };

/** `null` : rien à proposer (un identifiant a déjà ce couple). Sinon une
 * modification — celui qu'on vient de remplir dans l'onglet s'il a ce nom,
 * à défaut le plus proche de la page avec ce nom, mais jamais celui d'un
 * autre sous-domaine (c'est un autre compte : on en propose un nouveau). */
export function classifyCapture(matches: Candidate[], username: string, password: string, recentId: string | null): Capture | null {
  const same = matches.filter((l) => l.username.toLowerCase() === username.toLowerCase());
  if (same.some((l) => l.password === password)) return null;
  if (matches.some((l) => l.password === password && !l.username)) return null;
  const target = same.find((l) => l.id === recentId) ?? [...same].sort((a, b) => b.score - a.score).find((l) => l.score >= 2);
  return target ? { mode: "update", loginId: target.id, loginName: target.name } : { mode: "new", loginId: null, loginName: null };
}
