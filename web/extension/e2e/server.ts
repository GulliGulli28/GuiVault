/** Le serveur des pages du corpus : un dossier par domaine
 * (`fixtures/<hôte>/…`), choisi par l'en-tête `Host` — Chromium envoie tous
 * les `*.test` ici (`--host-resolver-rules`), ce qui donne de vrais sites
 * distincts (cadres d'un autre site compris) sans DNS ni certificat.
 * `{{PORT}}` dans une page devient le port d'écoute. */
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export async function startFixtures(): Promise<{ port: number; close: () => Promise<void> }> {
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    const { pathname } = new URL(req.url ?? "/", "http://fixtures");
    const file = pathname === "/kit.js" ? path.join(ROOT, "kit.js") : path.join(ROOT, host, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      const html = file.endsWith(".html");
      res.writeHead(200, { "content-type": html ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(html ? data.toString("utf-8").replaceAll("{{PORT}}", String(port)) : data);
    } catch {
      res.writeHead(404).end("introuvable");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
