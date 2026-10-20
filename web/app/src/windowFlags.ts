/** La saisie automatique réduit la fenêtre pour taper ailleurs : ce n'est
 * pas l'utilisateur qui la réduit, « verrouiller à la réduction » ne doit
 * pas s'en mêler (`systemBridge.ts`). */
let typing = 0;

export async function duringAutoType<T>(run: () => Promise<T>): Promise<T> {
  typing++;
  try {
    return await run();
  } finally {
    // L'avis de réduction peut arriver un peu après.
    setTimeout(() => typing--, 1500);
  }
}

export function autoTypeRunning(): boolean {
  return typing > 0;
}
