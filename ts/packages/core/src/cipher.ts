import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/ciphers/webcrypto";

import { canonicalJson } from "./canonical.js";
import type {
  Change,
  Checkpoint,
  Commit,
  CommitRequest,
  Head,
  RestorePoint,
  RestorePointKey,
  SubmitResult,
  SyncBackend,
  Unsubscribe,
} from "./protocol.js";

/** Thrown when data cannot be decrypted: unknown key, tampering, or plaintext where ciphertext is required. */
export class CipherError extends Error {
  override name = "CipherError";
}

const PREFIX = "e1";
const NONCE_LENGTH = 24;
const KEY_LENGTH = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Client-side encryption of everything a backend stores (spec/cipher.md).
 * Encrypted token: `e1.<keyId>.<base64url(nonce24 ‖ ciphertext ‖ tag16)>`,
 * XChaCha20-Poly1305 with the context string as associated data.
 */
export interface Cipher {
  seal(plaintext: string, context: string): Promise<string>;
  open(token: string, context: string): Promise<string>;
}

export interface KeyCipherOptions {
  /** Every key this device can decrypt with, by ID (32 bytes each). */
  keys: Record<string, Uint8Array>;
  /** The key used to encrypt; must be in `keys`. */
  activeKeyId: string;
  /** Test hook: supplies the 24-byte nonce. */
  nonce?: () => Uint8Array;
}

export class KeyCipher implements Cipher {
  private readonly keys = new Map<string, Uint8Array>();
  private readonly activeKeyId: string;
  private readonly nonce: () => Uint8Array;

  constructor(options: KeyCipherOptions) {
    for (const [id, key] of Object.entries(options.keys)) {
      if (!KEY_ID.test(id)) throw new CipherError(`Invalid key ID "${id}".`);
      if (key.length !== KEY_LENGTH) throw new CipherError(`Key "${id}" must be ${KEY_LENGTH} bytes.`);
      this.keys.set(id, key);
    }
    if (!this.keys.has(options.activeKeyId)) throw new CipherError("The active key is not among the keys.");
    this.activeKeyId = options.activeKeyId;
    this.nonce = options.nonce ?? (() => randomBytes(NONCE_LENGTH));
  }

  async seal(plaintext: string, context: string): Promise<string> {
    const nonce = this.nonce();
    const box = xchacha20poly1305(this.keys.get(this.activeKeyId)!, nonce, aad(context)).encrypt(
      encoder.encode(plaintext),
    );
    const bytes = new Uint8Array(nonce.length + box.length);
    bytes.set(nonce);
    bytes.set(box, nonce.length);
    return `${PREFIX}.${this.activeKeyId}.${toBase64Url(bytes)}`;
  }

  async open(token: string, context: string): Promise<string> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) throw new CipherError("Not an encrypted value.");
    const key = this.keys.get(parts[1]!);
    if (!key) throw new CipherError(`No key "${parts[1]}" to decrypt with.`);
    let bytes: Uint8Array;
    try {
      bytes = fromBase64Url(parts[2]!);
    } catch {
      throw new CipherError("Malformed encrypted value.");
    }
    if (bytes.length < NONCE_LENGTH + 16) throw new CipherError("Malformed encrypted value.");
    try {
      const plain = xchacha20poly1305(key, bytes.subarray(0, NONCE_LENGTH), aad(context)).decrypt(
        bytes.subarray(NONCE_LENGTH),
      );
      return decoder.decode(plain);
    } catch {
      throw new CipherError("Decryption failed: wrong key or altered data.");
    }
  }
}

function aad(context: string): Uint8Array {
  return encoder.encode(`entanglement/e1|${context}`);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("bad base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Contexts bound into each ciphertext, so a server cannot swap them between slots. */
export const CipherContext = {
  value: (collection: string, id: string) => `value|${collection}|${id}`,
  message: (commitId: string) => `message|${commitId}`,
  deviceLabel: (commitId: string) => `deviceLabel|${commitId}`,
  restoreLabel: (revision: number, kind: string) => `restoreLabel|${revision}|${kind}`,
  restoreDevice: (revision: number, kind: string) => `restoreDevice|${revision}|${kind}`,
} as const;

/** A document value on the wire: the canonical JSON `{"$enc":"<token>"}`. */
export async function sealValue(cipher: Cipher, collection: string, id: string, value: string): Promise<string> {
  return canonicalJson({ $enc: await cipher.seal(value, CipherContext.value(collection, id)) });
}

export async function openValue(cipher: Cipher, collection: string, id: string, wire: string): Promise<string> {
  const parsed: unknown = JSON.parse(wire);
  const token =
    typeof parsed === "object" && parsed !== null && Object.keys(parsed).length === 1
      ? (parsed as { $enc?: unknown }).$enc
      : undefined;
  if (typeof token !== "string") throw new CipherError(`Document ${collection}/${id} is not encrypted.`);
  return canonicalJson(JSON.parse(await cipher.open(token, CipherContext.value(collection, id))));
}

/**
 * Wraps a backend so it only ever sees ciphertext. State digests pass through
 * untouched: they are computed over plaintext by the engine.
 */
export class EncryptedBackend implements SyncBackend {
  constructor(
    private readonly inner: SyncBackend,
    private readonly cipher: Cipher,
  ) {}

  head(): Promise<Head | null> {
    return this.inner.head();
  }

  async commits(options: { after: number; upTo: number; limit?: number }): Promise<Commit[]> {
    const commits = await this.inner.commits(options);
    return Promise.all(commits.map(async (commit) => ({ ...commit, request: await this.openRequest(commit.request) })));
  }

  async submit(request: CommitRequest): Promise<SubmitResult> {
    const { cipher } = this;
    const id = request.commitId;
    return this.inner.submit({
      ...request,
      deviceLabel:
        request.deviceLabel === null ? null : await cipher.seal(request.deviceLabel, CipherContext.deviceLabel(id)),
      message: request.message === null ? null : await cipher.seal(request.message, CipherContext.message(id)),
      changes: await this.sealChanges(request.changes),
    });
  }

  async checkpoint(options: { atOrBefore: number }): Promise<Checkpoint | null> {
    const checkpoint = await this.inner.checkpoint(options);
    return checkpoint && { ...checkpoint, entities: await this.openChanges(checkpoint.entities) };
  }

  async putCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.inner.putCheckpoint({ ...checkpoint, entities: await this.sealChanges(checkpoint.entities) });
  }

  async restorePoints(): Promise<RestorePoint[]> {
    const points = await this.inner.restorePoints();
    return Promise.all(
      points.map(async (point) => ({
        ...point,
        label:
          point.label === null
            ? null
            : await this.cipher.open(point.label, CipherContext.restoreLabel(point.revision, point.kind)),
        deviceLabel:
          point.deviceLabel === null
            ? null
            : await this.cipher.open(point.deviceLabel, CipherContext.restoreDevice(point.revision, point.kind)),
      })),
    );
  }

  async putRestorePoint(point: RestorePoint): Promise<void> {
    return this.inner.putRestorePoint({
      ...point,
      label:
        point.label === null
          ? null
          : await this.cipher.seal(point.label, CipherContext.restoreLabel(point.revision, point.kind)),
      deviceLabel:
        point.deviceLabel === null
          ? null
          : await this.cipher.seal(point.deviceLabel, CipherContext.restoreDevice(point.revision, point.kind)),
    });
  }

  deleteRestorePoints(keys: readonly RestorePointKey[]): Promise<void> {
    return this.inner.deleteRestorePoints(keys);
  }

  compact(options: { anchor: number }): Promise<void> {
    return this.inner.compact(options);
  }

  onHint(listener: () => void): Unsubscribe | null {
    return this.inner.onHint(listener);
  }

  private async openRequest(request: CommitRequest): Promise<CommitRequest> {
    const id = request.commitId;
    return {
      ...request,
      deviceLabel:
        request.deviceLabel === null ? null : await this.cipher.open(request.deviceLabel, CipherContext.deviceLabel(id)),
      message: request.message === null ? null : await this.cipher.open(request.message, CipherContext.message(id)),
      changes: await this.openChanges(request.changes),
    };
  }

  private sealChanges(changes: readonly Change[]): Promise<Change[]> {
    return Promise.all(
      changes.map(async (change) => ({
        ...change,
        value: change.value === null ? null : await sealValue(this.cipher, change.collection, change.id, change.value),
      })),
    );
  }

  private openChanges(changes: readonly Change[]): Promise<Change[]> {
    return Promise.all(
      changes.map(async (change) => ({
        ...change,
        value: change.value === null ? null : await openValue(this.cipher, change.collection, change.id, change.value),
      })),
    );
  }
}

