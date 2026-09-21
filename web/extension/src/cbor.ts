/** Le strict nécessaire de CBOR (RFC 8949) pour WebAuthn : un objet
 * d'attestation et une clé COSE — entiers (signés), chaînes, octets, tableaux
 * et maps, en encodage canonique (clés triées par longueur puis octets). */

export type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue> | { [k: string]: CborValue };

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function cborEncode(v: CborValue): Uint8Array {
  const out: number[] = [];
  const push = (bytes: ArrayLike<number>) => {
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
  };
  const enc = (x: CborValue) => {
    if (typeof x === "number") {
      if (!Number.isInteger(x)) throw new Error("cbor: entier attendu");
      push(x >= 0 ? head(0, x) : head(1, -1 - x));
    } else if (typeof x === "string") {
      const b = new TextEncoder().encode(x);
      push(head(3, b.length));
      push(b);
    } else if (x instanceof Uint8Array) {
      push(head(2, x.length));
      push(x);
    } else if (Array.isArray(x)) {
      push(head(4, x.length));
      for (const e of x) enc(e);
    } else {
      const entries: [number | string, CborValue][] = x instanceof Map ? Array.from(x.entries()) : Object.entries(x);
      const keyed = entries.map(([k, val]) => ({ k, val, bytes: cborEncode(k) }));
      keyed.sort((a, b) => a.bytes.length - b.bytes.length || compare(a.bytes, b.bytes));
      push(head(5, keyed.length));
      for (const { bytes, val } of keyed) {
        push(bytes);
        enc(val);
      }
    }
  };
  enc(v);
  return new Uint8Array(out);
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
