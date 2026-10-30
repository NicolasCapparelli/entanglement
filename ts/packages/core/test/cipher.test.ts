import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { CipherError, InMemoryServer, KeyCipher, sealValue, openValue } from "../src/index.js";
import { Device } from "./support.js";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../spec/vectors/cipher.json", import.meta.url)), "utf8"),
) as {
  keys: Record<string, string>;
  tokens: { name: string; keyId: string; nonce: string; context: string; plaintext: string; token: string }[];
  values: { keyId: string; nonce: string; collection: string; id: string; canonical: string; wire: string }[];
  failures: { name: string; token: string; context: string; error: string }[];
};

const unhex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const keys = Object.fromEntries(Object.entries(vectors.keys).map(([id, hex]) => [id, unhex(hex)]));
const cipherFor = (activeKeyId: string, nonce?: string) =>
  new KeyCipher({ keys, activeKeyId, nonce: nonce ? () => unhex(nonce) : undefined });

describe("cipher.json", () => {
  for (const v of vectors.tokens) {
    test(v.name, async () => {
      const cipher = cipherFor(v.keyId, v.nonce);
      expect(await cipher.seal(v.plaintext, v.context)).toBe(v.token);
      expect(await cipher.open(v.token, v.context)).toBe(v.plaintext);
    });
  }
  for (const v of vectors.values) {
    test(`value ${v.collection}/${v.id}`, async () => {
      const cipher = cipherFor(v.keyId, v.nonce);
      expect(await sealValue(cipher, v.collection, v.id, v.canonical)).toBe(v.wire);
      expect(await openValue(cipher, v.collection, v.id, v.wire)).toBe(v.canonical);
    });
  }
  for (const v of vectors.failures) {
    test(`rejects: ${v.name}`, async () => {
      await expect(cipherFor("k1").open(v.token, v.context)).rejects.toThrow(CipherError);
    });
  }
});

const dump = (server: InMemoryServer) =>
  JSON.stringify(server.commitsOf("alice"), (_key, value) => (typeof value === "bigint" ? value.toString() : value));

describe("encrypted sync", () => {
  const devices: Device[] = [];
  afterEach(async () => {
    for (const d of devices) await d.close();
    devices.length = 0;
  });
  const key = (n: number) => new Uint8Array(32).fill(n);
  const make = async (server: InMemoryServer, name: string, cipher: KeyCipher) => {
    const d = await Device.create(server, { name, cipher });
    devices.push(d);
    return d;
  };

  test("the server holds only ciphertext and devices converge", async () => {
    const server = new InMemoryServer();
    const cipher = new KeyCipher({ keys: { a: key(1) }, activeKeyId: "a" });
    const one = await make(server, "one", cipher);
    const two = await make(server, "two", cipher);
    await one.addBoard("b1", "Secret board");
    await one.sync.push({ message: "Private message" });
    await two.sync.pull();
    expect(await two.board("b1")).toMatchObject({ name: "Secret board" });

    const stored = dump(server);
    expect(stored).not.toContain("Secret board");
    expect(stored).not.toContain("Private message");
    expect(stored).not.toContain('"one"');
    expect(stored).toContain("$enc");
  });

  test("key rotation: old data stays readable, new writes use the new key", async () => {
    const server = new InMemoryServer();
    const old = new KeyCipher({ keys: { a: key(1) }, activeKeyId: "a" });
    const one = await make(server, "one", old);
    await one.addBoard("b1", "Home");
    await one.sync.push();

    const rotated = new KeyCipher({ keys: { a: key(1), b: key(2) }, activeKeyId: "b" });
    const two = await make(server, "two", rotated);
    await two.sync.pull();
    await two.addBoard("b2", "Work");
    await two.sync.push();
    const text = dump(server);
    expect(text).toContain("e1.a.");
    expect(text).toContain("e1.b.");

    const three = await make(server, "three", rotated);
    await three.sync.pull();
    expect(await three.board("b1")).toMatchObject({ name: "Home" });
    expect(await three.board("b2")).toMatchObject({ name: "Work" });
  });

  test("a device without the key cannot read the account", async () => {
    const server = new InMemoryServer();
    const one = await make(server, "one", new KeyCipher({ keys: { a: key(1) }, activeKeyId: "a" }));
    await one.addBoard("b1", "Home");
    await one.sync.push();
    const stranger = await make(server, "stranger", new KeyCipher({ keys: { z: key(9) }, activeKeyId: "z" }));
    await stranger.sync.pull().catch(() => undefined);
    expect(await stranger.board("b1")).toBeNull();
  });
});
