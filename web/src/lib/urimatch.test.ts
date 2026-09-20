import { describe, expect, it } from "vitest";
import { registrableDomain, uriMatches } from "./urimatch";

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
});
