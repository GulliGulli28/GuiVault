/** Un routeur minuscule sur le fragment : `#/vault/<id>`,
 * `#/vault/<id>/settings`, `#/vault/<id>/tools`, `#/vault/<id>/trash`, `#/settings/<section>`,
 * `#/invitations`, `#/generator`, `#/totp`. `#/account` d'avant mène au
 * compte dans les paramètres. */
import { useEffect, useState } from "react";

export type Route =
  | { page: "home" }
  | { page: "vault"; id: string }
  | { page: "vault-settings"; id: string }
  | { page: "vault-tools"; id: string }
  | { page: "vault-trash"; id: string }
  | { page: "settings"; section: SettingsSection }
  | { page: "invitations" }
  | { page: "generator" }
  | { page: "totp" };

export type SettingsSection = "apparence" | "compte" | "securite" | "sessions";
const SECTIONS: SettingsSection[] = ["apparence", "compte", "securite", "sessions"];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "vault" && parts[1]) {
    if (parts[2] === "settings") return { page: "vault-settings", id: parts[1] };
    if (parts[2] === "tools") return { page: "vault-tools", id: parts[1] };
    if (parts[2] === "trash") return { page: "vault-trash", id: parts[1] };
    return { page: "vault", id: parts[1] };
  }
  if (parts[0] === "account") return { page: "settings", section: "compte" };
  if (parts[0] === "settings") return { page: "settings", section: SECTIONS.find((s) => s === parts[1]) ?? "apparence" };
  if (parts[0] === "invitations") return { page: "invitations" };
  if (parts[0] === "generator") return { page: "generator" };
  if (parts[0] === "totp") return { page: "totp" };
  return { page: "home" };
}

export function routeHash(r: Route): string {
  switch (r.page) {
    case "home": return "#/";
    case "vault": return `#/vault/${r.id}`;
    case "vault-settings": return `#/vault/${r.id}/settings`;
    case "vault-tools": return `#/vault/${r.id}/tools`;
    case "vault-trash": return `#/vault/${r.id}/trash`;
    case "settings": return `#/settings/${r.section}`;
    case "invitations": return "#/invitations";
    case "generator": return "#/generator";
    case "totp": return "#/totp";
  }
}

export function navigate(r: Route) {
  window.location.hash = routeHash(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
