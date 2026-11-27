import { describe, expect, it } from "vitest";
import type { Login } from "./types";
import { loginScore, registrableDomain, uriMatches, uriScore } from "./urimatch";

describe("correspondance d'URI", () => {
  it("domaine enregistrable", () => {
    expect(registrableDomain("mail.google.com")).toBe("google.com");
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("impots.gouv.fr")).toBe("impots.gouv.fr");
    expect(registrableDomain("10.0.0.1")).toBe("10.0.0.1");
    expect(registrableDomain("localhost")).toBe("localhost");
  });

  it("modes", () => {
    const page = "https://accounts.example.com/login?x=1";
    expect(uriMatches({ uri: "https://example.com" }, page)).toBe(true);
    expect(uriMatches({ uri: "example.com", match: "domain" }, page)).toBe(true);
    expect(uriMatches({ uri: "https://example.com", match: "host" }, page)).toBe(false);
    expect(uriMatches({ uri: "https://accounts.example.com", match: "host" }, page)).toBe(true);
    expect(uriMatches({ uri: "https://accounts.example.com/log", match: "startsWith" }, page)).toBe(true);
    expect(uriMatches({ uri: "https://accounts.example.com/login?x=1", match: "exact" }, page)).toBe(true);
    expect(uriMatches({ uri: "https://accounts.example.com/login", match: "exact" }, page)).toBe(false);
    expect(uriMatches({ uri: "^https://accounts\\.example\\.com/", match: "regex" }, page)).toBe(true);
    expect(uriMatches({ uri: "(", match: "regex" }, page)).toBe(false);
    expect(uriMatches({ uri: "https://example.com", match: "never" }, page)).toBe(false);
    expect(uriMatches({ uri: "https://notexample.com" }, page)).toBe(false);
  });

  it("rang : le sous-domaine de la page avant les autres", () => {
    const page = "https://b.example.com/login";
    expect(uriScore({ uri: "https://b.example.com/login", match: "exact" }, page)).toBe(4);
    expect(uriScore({ uri: "https://b.example.com" }, page)).toBe(3);
    expect(uriScore({ uri: "https://www.b.example.com" }, page)).toBe(3);
    expect(uriScore({ uri: "example.com" }, page)).toBe(2);
    expect(uriScore({ uri: "https://a.example.com" }, page)).toBe(1);
    expect(uriScore({ uri: "https://other.com" }, page)).toBe(0);
    expect(uriScore({ uri: "http://b.example.com" }, "http://b.example.com:8443/")).toBe(3);
    expect(uriScore({ uri: "http://b.example.com:9000" }, "http://b.example.com:8443/")).toBe(1);
    const login = (...uris: string[]) => ({ uris: uris.map((uri) => ({ uri })) }) as unknown as Login;
    expect(loginScore(login("https://a.example.com", "https://b.example.com"), page)).toBe(3);
    expect(loginScore(login(), page)).toBe(0);
  });
});
