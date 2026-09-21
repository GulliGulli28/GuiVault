/** Les clés générées sont relues par `ssh-keygen` quand il est là : c'est
 * lui l'arbitre du format OpenSSH. Sans lui, on vérifie au moins la
 * structure. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSshKey, type SshKeyOptions } from "./sshkey";

const hasKeygen = (() => {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (e) {
    // `-?` sort en erreur mais existe ; ENOENT est le seul « absent ».
    return !(e instanceof Error && "code" in e && (e as { code?: string }).code === "ENOENT");
  }
})();

const CASES: SshKeyOptions[] = [
  { type: "ed25519", bits: 256, comment: "alice@guivault" },
  { type: "rsa", bits: 2048, comment: "" },
  { type: "ecdsa", bits: 256, comment: "ec" },
  { type: "ecdsa", bits: 384, comment: "ec384" },
];

describe("clés SSH", () => {
  for (const c of CASES) {
    it(`${c.type}${c.type === "ed25519" ? "" : ` ${c.bits}`} : format OpenSSH${hasKeygen ? " relu par ssh-keygen" : ""}`, async () => {
      const k = await generateSshKey(c);
      expect(k.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
      expect(k.publicKey.split(" ")[0]).toBe(k.type);
      expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
      if (!hasKeygen) return;
      const dir = mkdtempSync(join(tmpdir(), "gv-ssh-"));
      const file = join(dir, "key");
      writeFileSync(file, k.privateKey, { mode: 0o600 });
      // La clé publique dérivée par ssh-keygen (commentaire compris) doit
      // être la nôtre, et l'empreinte aussi.
      const pub = execFileSync("ssh-keygen", ["-y", "-f", file]).toString().trim();
      expect(pub).toBe(k.publicKey.trim());
      const fp = execFileSync("ssh-keygen", ["-l", "-f", file]).toString();
      expect(fp).toContain(k.fingerprint);
    }, 30_000);
  }
});
