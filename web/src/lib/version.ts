/** Les versions de l'application, telles que GitHub les publie (releases
 * `app-v<x.y.z>`) — pour dire à l'application Android qu'il y a plus récent
 * (`web/app/src/updaterBridge.ts`, `installUpdateNotice`). */

export interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
}

/** `a` plus récente que `b` (versions `x.y.z`). */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** La release d'application publiée la plus récente : ni brouillon, ni
 * pré-release (`app-updater` en est une), un tag `app-v<x.y.z>`. */
export function latestAppRelease(releases: GithubRelease[]): GithubRelease | null {
  return releases
    .filter((r) => !r.draft && !r.prerelease && /^app-v\d+\.\d+\.\d+$/.test(r.tag_name))
    .sort((x, y) => (newer(x.tag_name.slice(5), y.tag_name.slice(5)) ? -1 : newer(y.tag_name.slice(5), x.tag_name.slice(5)) ? 1 : 0))[0] ?? null;
}
