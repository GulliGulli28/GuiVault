/** Générateur de mots de passe et de phrases de passe, et estimation de
 * robustesse. Tout l'aléa vient de `crypto.getRandomValues`, sans biais de
 * modulo (rejet). */
import { EFF_LARGE_WORDLIST } from "./wordlist";

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  /** Écarte `l1IO0|` et consorts. */
  avoidAmbiguous: boolean;
  minDigits: number;
  minSymbols: number;
}

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  /** Un chiffre ajouté à un mot au hasard. */
  includeNumber: boolean;
}

export type GeneratorOptions = { mode: "password"; password: PasswordOptions; passphrase: PassphraseOptions } | { mode: "passphrase"; password: PasswordOptions; passphrase: PassphraseOptions };

export const DEFAULT_PASSWORD: PasswordOptions = { length: 20, lowercase: true, uppercase: true, digits: true, symbols: true, avoidAmbiguous: false, minDigits: 1, minSymbols: 1 };
export const DEFAULT_PASSPHRASE: PassphraseOptions = { words: 5, separator: "-", capitalize: false, includeNumber: false };
export const DEFAULT_GENERATOR: GeneratorOptions = { mode: "password", password: DEFAULT_PASSWORD, passphrase: DEFAULT_PASSPHRASE };

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.<>?/~";
const AMBIGUOUS = new Set("l1IO0|`'\"");

/** Un entier uniforme dans `[0, n)`. */
export function randomInt(n: number): number {
  if (n <= 0 || n > 0x100000000) throw new Error("randomInt: borne invalide");
  const limit = 0x100000000 - (0x100000000 % n);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function strip(alphabet: string, avoid: boolean): string {
  return avoid ? Array.from(alphabet).filter((c) => !AMBIGUOUS.has(c)).join("") : alphabet;
}

export function generatePassword(o: PasswordOptions): string {
  const classes: string[] = [];
  if (o.lowercase) classes.push(strip(LOWER, o.avoidAmbiguous));
  if (o.uppercase) classes.push(strip(UPPER, o.avoidAmbiguous));
  if (o.digits) classes.push(strip(DIGITS, o.avoidAmbiguous));
  if (o.symbols) classes.push(strip(SYMBOLS, o.avoidAmbiguous));
  if (classes.length === 0) classes.push(strip(LOWER, o.avoidAmbiguous));
  const length = Math.max(4, Math.min(128, o.length));
  const all = classes.join("");
  const out: string[] = [];
  // Les minimums d'abord (au moins un de chaque classe cochée), le reste
  // au hasard dans l'union, puis on mélange pour ne pas trahir l'ordre.
  for (const c of classes) out.push(pick(c));
  if (o.digits) for (let i = 1; i < o.minDigits && out.length < length; i++) out.push(pick(strip(DIGITS, o.avoidAmbiguous)));
  if (o.symbols) for (let i = 1; i < o.minSymbols && out.length < length; i++) out.push(pick(strip(SYMBOLS, o.avoidAmbiguous)));
  while (out.length < length) out.push(pick(all));
  return shuffle(out.slice(0, length)).join("");
}

export function generatePassphrase(o: PassphraseOptions): string {
  const count = Math.max(3, Math.min(20, o.words));
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    let w = EFF_LARGE_WORDLIST[randomInt(EFF_LARGE_WORDLIST.length)];
    if (o.capitalize) w = w[0].toUpperCase() + w.slice(1);
    words.push(w);
  }
  if (o.includeNumber) {
    const i = randomInt(count);
    words[i] += String(randomInt(10));
  }
  return words.join(o.separator || "-");
}

export function generate(o: GeneratorOptions): string {
  return o.mode === "password" ? generatePassword(o.password) : generatePassphrase(o.passphrase);
}

// ─── Robustesse ─────────────────────────────────────────────────────────────

export interface Strength {
  /** Entropie estimée, en bits. */
  bits: number;
  /** 0 = très faible … 4 = très fort. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

const WORDSET = new Set(EFF_LARGE_WORDLIST);
/** Ce qu'un attaquant essaie en premier : présent, le mot de passe est
 * faible quoi qu'on y ajoute. */
const COMMON = ["password", "passwort", "motdepasse", "azerty", "qwerty", "123456", "12345", "abc123", "admin", "letmein", "welcome", "bienvenue", "iloveyou", "monkey", "dragon", "master", "login", "football", "baseball", "sunshine", "princess", "secret", "bonjour", "soleil", "trustno1", "shadow", "superman", "batman", "hello", "salut"];

/** Estimation grossière mais honnête : taille de l'alphabet observé × longueur,
 * moins ce qui se devine (répétitions, suites, mots de la liste, années). Pas
 * zxcvbn — ça donne une échelle, pas une garantie. */
export function estimateStrength(password: string): Strength {
  if (!password) return { bits: 0, score: 0, label: "vide" };
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;
  let bits = password.length * Math.log2(pool || 1);

  // Une phrase de passe faite de mots de la liste vaut 12,9 bits par mot,
  // pas 4,7 par lettre.
  const words = password.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length >= 2 && words.every((w) => WORDSET.has(w))) {
    bits = Math.min(bits, words.length * Math.log2(EFF_LARGE_WORDLIST.length) + 4);
  }
  // Répétitions et suites : chaque caractère qui suit trivialement le
  // précédent ne compte qu'un bit.
  let trivial = 0;
  for (let i = 1; i < password.length; i++) {
    const d = password.charCodeAt(i) - password.charCodeAt(i - 1);
    if (d === 0 || d === 1 || d === -1) trivial++;
  }
  bits -= trivial * (Math.log2(pool || 2) - 1);
  if (/(19|20)\d\d/.test(password)) bits -= 8;
  const lower = password.toLowerCase();
  for (const w of COMMON) if (lower.includes(w)) bits -= Math.max(w.length * Math.log2(pool || 2) - 4, 0);
  bits = Math.max(0, Math.round(bits));

  const score: Strength["score"] = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { bits, score, label: ["très faible", "faible", "moyen", "fort", "très fort"][score] };
}
