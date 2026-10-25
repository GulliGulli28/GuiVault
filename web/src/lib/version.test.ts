import { describe, expect, it } from "vitest";
import { latestAppRelease, newer, type GithubRelease } from "./version";

const rel = (tag: string, extra: Partial<GithubRelease> = {}): GithubRelease => ({ tag_name: tag, html_url: `https://x/${tag}`, draft: false, prerelease: false, published_at: null, body: null, ...extra });

describe("versions de l'application", () => {
  it("compare x.y.z par nombres, pas par texte", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("0.4.1", "0.4.0")).toBe(true);
    expect(newer("0.4.0", "0.4.0")).toBe(false);
    expect(newer("0.3.9", "0.4.0")).toBe(false);
  });

  it("la plus récente des releases d'application publiées", () => {
    const list = [rel("app-updater", { prerelease: true }), rel("app-v0.5.0", { draft: true }), rel("v4.0.1"), rel("app-v0.4.0"), rel("app-v0.10.0"), rel("app-v0.9.0")];
    expect(latestAppRelease(list)?.tag_name).toBe("app-v0.10.0");
    expect(latestAppRelease([rel("app-updater", { prerelease: true })])).toBeNull();
  });
});
