/** La tuile d'un élément sans icône choisie : son initiale, sur une teinte
 * tirée de son nom — la même d'un appareil à l'autre, sans rien stocker. */

/** L'initiale affichée : la première lettre ou le premier chiffre du nom,
 * sans « www. » ni ponctuation de tête. */
export function tileInitial(name: string): string {
  const s = name.trim().replace(/^www\./i, "");
  const m = /[\p{L}\p{N}]/u.exec(s);
  return m ? m[0].toLocaleUpperCase("fr-FR") : "·";
}

/** Une teinte (0–359) stable pour un nom : un hachage FNV-1a, ramené sur
 * des pas de 15° pour que deux noms voisins se distinguent. */
export function tileHue(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 24) * 15;
}

/** Les initiales d'une personne d'après son e-mail (ou un nom) :
 * « guillaume.lorin@… » → « GL », « glorin@… » → « G ». */
export function personInitials(text: string): string {
  const local = text.split("@")[0];
  const parts = local.split(/[.\-_\s]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => tileInitial(p)).join("");
  return letters || tileInitial(text);
}
