/** TOTP (RFC 6238) dans le navigateur, pour afficher le code d'un
 * identifiant. Accepte une URI `otpauth://totp/…` ou un secret base32 nu. */

export interface TotpParams {
  secret: Uint8Array;
  algorithm: "SHA-1" | "SHA-256" | "SHA-512";
  digits: number;
  period: number;
  label: string;
  issuer: string;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function parseTotp(input: string): TotpParams | null {
  const s = input.trim();
  if (!s) return null;
  if (/^otpauth:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== "totp") return null;
    const secret = url.searchParams.get("secret");
    if (!secret) return null;
    const algo = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase().replace("SHA", "SHA-");
    const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const [issuerFromLabel, account] = label.includes(":") ? label.split(":", 2) : ["", label];
    return {
      secret: base32Decode(secret),
      algorithm: algo === "SHA-256" || algo === "SHA-512" ? algo : "SHA-1",
      digits: Number(url.searchParams.get("digits")) || 6,
      period: Number(url.searchParams.get("period")) || 30,
      label: account.trim(),
      issuer: url.searchParams.get("issuer") ?? issuerFromLabel.trim(),
    };
  }
  const secret = base32Decode(s);
  if (secret.length === 0) return null;
  return { secret, algorithm: "SHA-1", digits: 6, period: 30, label: "", issuer: "" };
}

export async function totpCode(p: TotpParams, now = Date.now()): Promise<string> {
  const counter = Math.floor(now / 1000 / p.period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", p.secret as BufferSource, { name: "HMAC", hash: p.algorithm }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** p.digits).padStart(p.digits, "0");
}

/** Secondes restantes avant le prochain code. */
export function totpRemaining(p: TotpParams, now = Date.now()): number {
  return p.period - (Math.floor(now / 1000) % p.period);
}
