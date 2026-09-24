/** Interopérabilité avec `guivault-crypto`. Les vecteurs viennent du crate
 * Rust (`cargo run -p guivault-crypto --example vectors`) ; dans l'autre
 * sens, `GUIVAULT_WRITE_VECTORS=1 npx vitest run` écrit
 * `crates/guivault-crypto/tests/web-vectors.json`, que le test Rust
 * `web_interop` ouvre. */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { fromHex, toHex, utf8, uuid } from "./bytes";
import * as c from "./crypto";
import vectors from "./crypto.vectors.json";

describe("guivault-crypto interop", () => {
  it("dérive les mêmes clés qu'Argon2id + HKDF côté Rust", async () => {
    const v = vectors.kdf;
    const m = await c.deriveMasterKey(v.password, fromHex(v.salt), v.params);
    expect(toHex(m.stretchedKey)).toBe(v.stretched_key);
    expect(toHex(m.authKey)).toBe(v.auth_key);
  });

  it("ouvre une enveloppe symétrique Rust et refuse un mauvais AAD", () => {
    const v = vectors.seal;
    const key = fromHex(v.key);
    expect(utf8.decode(c.open(key, fromHex(v.blob), utf8.encode(v.aad)))).toBe(v.plaintext);
    expect(() => c.open(key, fromHex(v.blob), utf8.encode("ctx-b"))).toThrow(c.CryptoError);
    const bad = fromHex(v.blob);
    bad[0] = 0x7f;
    expect(() => c.open(key, bad, utf8.encode(v.aad))).toThrowError(/format/);
  });

  it("ouvre une boîte scellée Rust et calcule la même empreinte", () => {
    const v = vectors.sealed_box;
    const kp = { privateKey: fromHex(v.private), publicKey: fromHex(v.public) };
    expect(toHex(c.generateKeyPair().publicKey)).toHaveLength(64);
    expect(utf8.decode(c.unseal(kp, fromHex(v.blob)))).toBe(v.plaintext);
    expect(c.fingerprint(kp.publicKey)).toBe(v.fingerprint);
  });

  it("déverrouille un compte créé par Rust", async () => {
    const v = vectors.account;
    const m = await c.deriveMasterKey(v.password, fromHex(v.kdf_salt), v.kdf);
    expect(toHex(m.authKey)).toBe(v.auth_key);
    const acc = c.unlockAccount(m.stretchedKey, fromHex(v.protected_user_key), fromHex(v.protected_private_key));
    expect(toHex(acc.userKey)).toBe(v.user_key);
    expect(toHex(acc.keypair.privateKey)).toBe(v.private_key);
    expect(toHex(acc.keypair.publicKey)).toBe(v.public_key);
    expect(toHex(c.unwrapVaultKey(acc, fromHex(v.wrapped_vault_key)))).toBe(vectors.item.vault_key);
  }, 30_000);

  it("ouvre un item et un nom de vault chiffrés par Rust", () => {
    const v = vectors.item;
    const key = fromHex(v.vault_key);
    expect(utf8.decode(c.openItem(key, v.vault_id, v.item_id, v.item_type, fromHex(v.blob)))).toBe(v.plaintext);
    expect(() => c.openItem(key, v.vault_id, v.item_id, "group", fromHex(v.blob))).toThrow();
    expect(c.openVaultName(key, v.vault_id, fromHex(v.name_blob))).toBe(v.name);
  });

  it("fait l'aller-retour sur ses propres primitives", async () => {
    const { material, account } = await c.createAccount("pw");
    const m = await c.deriveMasterKey("pw", material.kdfSalt, material.kdf);
    const again = c.unlockAccount(m.stretchedKey, material.protectedUserKey, material.protectedPrivateKey);
    expect(toHex(again.userKey)).toBe(toHex(account.userKey));
    const vk = new Uint8Array(32).fill(3);
    expect(toHex(c.unwrapVaultKey(again, c.wrapVaultKey(material.publicKey, vk)))).toBe(toHex(vk));
    const rekey = await c.rekeyAccount(account, "pw2");
    const m2 = await c.deriveMasterKey("pw2", rekey.kdfSalt, rekey.kdf);
    expect(toHex(c.open(m2.stretchedKey, rekey.protectedUserKey, utf8.encode("guivault/v1/user-key")))).toBe(toHex(account.userKey));
  }, 60_000);

  it("refuse de dériver hors des bornes de `KdfParams::is_sane`", async () => {
    // Les cas du test Rust `kdf_params_bounds`, plus des valeurs non entières.
    expect(c.kdfParamsSane(c.DEFAULT_KDF)).toBe(true);
    expect(c.kdfParamsSane({ m_cost: 19_456, t_cost: 2, p_cost: 1 })).toBe(true);
    expect(c.kdfParamsSane({ m_cost: 1024, t_cost: 1, p_cost: 1 })).toBe(false);
    expect(c.kdfParamsSane({ m_cost: 65536, t_cost: 1, p_cost: 1 })).toBe(false);
    expect(c.kdfParamsSane({ m_cost: 65536.5, t_cost: 3, p_cost: 1 })).toBe(false);
    // Ce qu'un serveur compromis renverrait au prelogin, et de quoi figer l'onglet.
    const salt = new Uint8Array(16);
    for (const bad of [{ m_cost: 8, t_cost: 1, p_cost: 1 }, { m_cost: 4 * 1_048_576, t_cost: 3, p_cost: 1 }]) {
      await expect(c.deriveMasterKey("pw", salt, bad)).rejects.toThrowError(/refusés/);
      await expect(c.deriveExportKey("pw", salt, bad)).rejects.toThrowError(/refusés/);
    }
  });

  it("écrit des vecteurs pour le test Rust (GUIVAULT_WRITE_VECTORS)", async () => {
    if (!process.env.GUIVAULT_WRITE_VECTORS) return;
    const kdf = { m_cost: 19_456, t_cost: 2, p_cost: 1 };
    const password = "web → rust";
    const salt = utf8.encode("fedcba9876543210");
    const master = await c.deriveMasterKey(password, salt, kdf);
    const key = new Uint8Array(32).fill(5);
    const recipient = c.generateKeyPair();
    const vaultKey = new Uint8Array(32).fill(6);
    const vaultId = uuid();
    const itemId = uuid();
    const out = {
      kdf: { password, salt: toHex(salt), params: kdf, stretched_key: toHex(master.stretchedKey), auth_key: toHex(master.authKey) },
      seal: { key: toHex(key), aad: "ctx-web", plaintext: "from the browser", blob: toHex(c.seal(key, utf8.encode("from the browser"), utf8.encode("ctx-web"))) },
      sealed_box: { private: toHex(recipient.privateKey), public: toHex(recipient.publicKey), fingerprint: c.fingerprint(recipient.publicKey), plaintext: "sealed by the browser", blob: toHex(c.sealFor(recipient.publicKey, utf8.encode("sealed by the browser"))) },
      item: { vault_key: toHex(vaultKey), vault_id: vaultId, item_id: itemId, item_type: "snippet", plaintext: "{\"kind\":\"snippet\"}", blob: toHex(c.sealItem(vaultKey, vaultId, itemId, "snippet", utf8.encode("{\"kind\":\"snippet\"}"))), name: "Équipe réseau", name_blob: toHex(c.sealVaultName(vaultKey, vaultId, "Équipe réseau")) },
    };
    writeFileSync(new URL("../../../crates/guivault-crypto/tests/web-vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  });
});
