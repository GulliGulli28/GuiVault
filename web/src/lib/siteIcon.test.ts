import { describe, expect, it } from "vitest";
import { fetchSiteIcon, iconCandidates, missingBySite, RETRY_AFTER_MS, siteOf, withFavicon, type IconTarget } from "./siteIcon";
import type { Payload } from "./types";

const login = (id: string, uris: string[], extra: Record<string, unknown> = {}): Payload =>
  ({ kind: "login", login: { id, name: id, groupId: null, tags: [], username: "", password: "", uris: uris.map((uri) => ({ uri })), totp: null, passkeys: [], passwordHistory: [], ...extra } }) as unknown as Payload;

describe("icônes des sites", () => {
  it("le site d'un identifiant : la première adresse http(s), sans schéma = https", () => {
    expect(siteOf({ uris: [{ uri: "github.com/login" }] })).toBe("https://github.com/");
    expect(siteOf({ uris: [{ uri: "androidapp://x" }, { uri: "http://intranet:8080/a" }] })).toBe("http://intranet:8080/");
    expect(siteOf({ uris: [{ uri: "^https://x", match: "regex" }] })).toBeNull();
    expect(siteOf({ uris: [] })).toBeNull();
  });

  it("les icônes annoncées : la plus proche de 64 px par au-dessus, puis les petites, puis /favicon.ico", () => {
    const html = `<html><head>
      <link rel="icon" href="/f16.png" sizes="16x16">
      <link rel="shortcut icon" href='/f32.png' sizes="32x32">
      <LINK REL="apple-touch-icon" HREF="https://cdn.example.com/touch.png">
      <link rel="icon" type="image/png" sizes="96x96" href="f96.png?v=1&amp;x=2">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="stylesheet" href="/s.css">
    </head>`;
    expect(iconCandidates(html, "https://example.com/app/")).toEqual([
      "https://example.com/app/f96.png?v=1&x=2",
      "https://cdn.example.com/touch.png",
      "https://example.com/f32.png",
      "https://example.com/f16.png",
      "https://example.com/favicon.ico",
    ]);
    expect(iconCandidates("", "https://example.com/")).toEqual(["https://example.com/favicon.ico"]);
    expect(iconCandidates(`<base href="https://static.example.com/"><link rel=icon href=i.png>`, "https://example.com/")[0]).toBe("https://static.example.com/i.png");
    expect(iconCandidates(`<link rel="icon" href="javascript:alert(1)">`, "https://example.com/")).toEqual(["https://example.com/favicon.ico"]);
  });

  it("récupère la page, puis la première icône qui se dessine", async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      asked.push(url);
      if (url === "https://site.test/") return { url: "https://www.site.test/", type: "text/html; charset=utf-8", bytes: new TextEncoder().encode(`<link rel="icon" href="/broken.png" sizes="64x64"><link rel="icon" href="/ok.png" sizes="32x32">`) };
      return { url, type: "image/png", bytes: new TextEncoder().encode(url) };
    };
    const render = async (bytes: Uint8Array) => (new TextDecoder().decode(bytes).endsWith("ok.png") ? "data:image/png;base64,OK" : null);
    expect(await fetchSiteIcon("https://site.test/", fetcher, render)).toBe("data:image/png;base64,OK");
    expect(asked).toEqual(["https://site.test/", "https://www.site.test/broken.png", "https://www.site.test/ok.png"]);
    // Le site ne répond pas : /favicon.ico quand même, et rien s'il manque.
    const down = async (url: string) => { if (url.endsWith("/")) throw new Error("down"); return { url, type: "image/x-icon", bytes: new Uint8Array([1]) }; };
    expect(await fetchSiteIcon("https://down.test/", down, async () => "data:image/png;base64,ICO")).toBe("data:image/png;base64,ICO");
    expect(await fetchSiteIcon("https://down.test/", down, async () => null)).toBeNull();
  });

  it("ce qui manque, par site ; un site tenté récemment attend", () => {
    const vault = { id: "v" } as IconTarget["vault"];
    const target = (payload: Payload) => ({ vault, item: { id: "x", revision: 1, ok: true, payload } }) as IconTarget;
    const now = 10 * RETRY_AFTER_MS;
    const targets = [
      target(login("a", ["https://a.test/x"])),
      target(login("a2", ["a.test"])),
      target(login("b", ["https://b.test"], { favicon: "data:image/png;base64,B" })),
      target(login("c", ["https://c.test"])),
      target(login("d", ["https://d.test"])),
      target({ kind: "note", note: { id: "n" } } as unknown as Payload),
    ];
    const m = missingBySite(targets, { "https://c.test/": now - 1000, "https://d.test/": now - RETRY_AFTER_MS - 1 }, now);
    expect([...m.keys()]).toEqual(["https://a.test/", "https://d.test/"]);
    expect(m.get("https://a.test/")).toHaveLength(2);
  });

  it("poser ou retirer l'icône", () => {
    const p = withFavicon(login("a", []), "data:image/png;base64,A");
    expect(p?.kind === "login" && p.login.favicon).toBe("data:image/png;base64,A");
    expect(withFavicon(p!, "data:image/png;base64,A")).toBeNull();
    const q = withFavicon(p!, null);
    expect(q?.kind === "login" && "favicon" in q.login).toBe(false);
  });
});
