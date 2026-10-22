/** Réduire l'application Android en bulle (`platform.ts`, `BubbleBridge`) :
 * le geste commun à l'accueil et aux réglages mobiles. */
import type { PageContext } from "../App";
import { errorMessage } from "./api";
import { bubbleBridge } from "./platform";

export { bubbleBridge };

export async function reduceToBubble(ctx: Pick<PageContext, "notify" | "error">): Promise<void> {
  const b = bubbleBridge();
  if (!b) return;
  try {
    if (!(await b.show())) ctx.notify("Autorisez « Afficher par-dessus d'autres applis », puis réessayez.");
  } catch (e) {
    ctx.error(`Bulle : ${errorMessage(e)}`);
  }
}
