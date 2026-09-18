/** Un routeur minuscule sur le fragment : `#/vault/<id>`,
 * `#/vault/<id>/settings`, `#/account`, `#/invitations`. */
import { useEffect, useState } from "react";

export type Route =
  | { page: "home" }
  | { page: "vault"; id: string }
  | { page: "vault-settings"; id: string }
  | { page: "account" }
  | { page: "invitations" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "vault" && parts[1]) {
    return parts[2] === "settings" ? { page: "vault-settings", id: parts[1] } : { page: "vault", id: parts[1] };
  }
  if (parts[0] === "account") return { page: "account" };
  if (parts[0] === "invitations") return { page: "invitations" };
  return { page: "home" };
}

export function routeHash(r: Route): string {
  switch (r.page) {
    case "home": return "#/";
    case "vault": return `#/vault/${r.id}`;
    case "vault-settings": return `#/vault/${r.id}/settings`;
    case "account": return "#/account";
    case "invitations": return "#/invitations";
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
