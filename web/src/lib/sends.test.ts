/** Liens de partage : le serveur (ici un faux, qui applique les mêmes
 * règles) ne voit que le chiffré et l'empreinte de la clé d'accès ; le lien
 * seul ouvre le contenu, et le mot de passe s'y ajoute. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64, toBase64 } from "./bytes";
import * as c from "./crypto";
import { createSend, listSends, openSend, parseSendFragment, shareablePayload } from "./sends";
import type { SessionState } from "./session";
import type { Payload } from "./types";

interface Stored { ciphertext: string; access_hash: string; owner_blob: string; password?: unknown; max_views?: number; views: number }

/** Un faux serveur de liens, qui garde ce qu'on lui envoie. */
function fakeSendServer() {
  const sends = new Map<string, Stored>();
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (body) bodies.push(body);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const m = url.match(/\/sends(?:\/([^/]+)(\/access)?)?$/);
    if (!m) return json(404, { code: "not_found", message: url });
    const [, id, access] = m;
    if (!id && init?.method === "POST") {
      sends.set(body.id, { ...body, views: 0 });
      return json(201, { id: body.id, owner_blob: body.owner_blob, has_password: !!body.password, max_views: body.max_views ?? null, views: 0, created_at: "", expires_at: "2099-01-01T00:00:00Z", last_viewed_at: null, available: true });
    }
    if (!id) return json(200, [...sends.entries()].map(([sid, s]) => ({ id: sid, owner_blob: s.owner_blob, has_password: !!s.password, max_views: s.max_views ?? null, views: s.views, created_at: "", expires_at: "2099-01-01T00:00:00Z", last_viewed_at: null, available: true })));
    const s = sends.get(id);
    if (!s || !access || (s.max_views && s.views >= s.max_views)) return json(404, { code: "send_unavailable", message: "introuvable" });
    if (init?.method !== "POST") return json(200, { password: s.password, expires_at: "2099-01-01T00:00:00Z", views_left: s.max_views ? s.max_views - s.views : null });
    if (toBase64(sha256(fromBase64(body.access_key))) !== s.access_hash) return json(403, { code: "invalid_send_key", message: "mot de passe incorrect" });
    s.views++;
    return json(200, { ciphertext: s.ciphertext, expires_at: "2099-01-01T00:00:00Z", views_left: s.max_views ? s.max_views - s.views : null });
  });
  return { sends, bodies };
}

beforeEach(() => vi.stubGlobal("window", { location: { origin: "https://coffre.example" } }));
afterEach(() => vi.unstubAllGlobals());

const session = { account: { userKey: new Uint8Array(32).fill(4) } } as unknown as SessionState;

function fragment(link: string) {
  const m = link.match(/#\/send\/([^/]+)\/([^/]+)$/);
  expect(m).not.toBeNull();
  return parseSendFragment(m![1], m![2])!;
}

describe("liens de partage", () => {
  it("le lien ouvre le contenu ; le serveur n'a ni le secret ni le clair", async () => {
    const server = fakeSendServer();
    const { link } = await createSend(session, { v: 1, kind: "text", name: "Wi-Fi", text: "hunter2" }, { expiresIn: 3600, maxViews: 1 });
    expect(link.startsWith("https://coffre.example/#/send/")).toBe(true);
    const { id, secret } = fragment(link);
    const sent = JSON.stringify(server.bodies[0]);
    expect(sent).not.toContain("hunter2");
    expect(sent).not.toContain(link.split("/").pop());
    const info = await (await fetch(`/api/v1/sends/${id}/access`)).json();
    const out = await openSend(id, secret, info);
    expect(out.content).toEqual({ v: 1, kind: "text", name: "Wi-Fi", text: "hunter2" });
    expect(out.viewsLeft).toBe(0);
    // Épuisé.
    await expect(openSend(id, secret, info)).rejects.toThrowError(/introuvable/);
    // L'auteur retrouve le lien dans sa liste (fiche sous sa user key).
    const [mine] = await listSends(session);
    expect(mine.name).toBe("Wi-Fi");
    expect(mine.link).toBe(link);
  });

  it("avec mot de passe : le lien seul ne suffit pas", async () => {
    fakeSendServer();
    const { link } = await createSend(session, { v: 1, kind: "text", name: "PIN", text: "0000" }, { expiresIn: 3600, password: "fromage" });
    const { id, secret } = fragment(link);
    const info = await (await fetch(`/api/v1/sends/${id}/access`)).json();
    expect(info.password.kdf).toEqual(c.DEFAULT_KDF);
    await expect(openSend(id, secret, info)).rejects.toThrowError(/mot de passe/);
    await expect(openSend(id, secret, info, "brie")).rejects.toThrowError(/mot de passe incorrect/);
    expect((await openSend(id, secret, info, "fromage")).content).toMatchObject({ text: "0000" });
  }, 30_000);

  it("un élément partagé perd son rangement, pas son contenu", () => {
    const p: Payload = { kind: "login", login: { id: "l-1", name: "Banque", groupId: "g-1", tags: ["perso"], favorite: true, icon: "custom:x", username: "moi", password: "pw", uris: [], totp: null } as never };
    const shared = shareablePayload(p as Extract<Payload, { kind: "login" }>);
    expect(shared.login).toMatchObject({ id: "l-1", name: "Banque", groupId: null, tags: [], username: "moi", password: "pw" });
    expect("favorite" in shared.login).toBe(false);
    expect("icon" in shared.login).toBe(false);
    // L'original n'a pas bougé.
    expect((p as Extract<Payload, { kind: "login" }>).login.groupId).toBe("g-1");
  });

  it("refuse un fragment incomplet ou mal formé", () => {
    expect(parseSendFragment("pas-un-uuid", "AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(parseSendFragment("11111111-2222-3333-4444-555555555555", "")).toBeNull();
    expect(parseSendFragment("11111111-2222-3333-4444-555555555555", "AAAA")).toBeNull();
    expect(parseSendFragment("11111111-2222-3333-4444-555555555555", "AAAAAAAAAAAAAAAAAAAAAA")).not.toBeNull();
  });
});
