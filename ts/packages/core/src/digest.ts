import { sha256 } from "@noble/hashes/sha2";

import { canonicalJson } from "./canonical.js";

const MODULUS = 1n << 256n;
const encoder = new TextEncoder();

/**
 * SHA-256 of `JCS([collection, id, value])` as an unsigned 256-bit big-endian
 * integer. `canonicalValue` must already be canonical JSON; null means absent
 * and contributes nothing.
 */
export function entityHash(
  collection: string,
  id: string,
  canonicalValue: string | null,
): bigint {
  if (canonicalValue === null) return 0n;
  const text = `[${canonicalJson(collection)},${canonicalJson(id)},${canonicalValue}]`;
  let result = 0n;
  for (const byte of sha256(encoder.encode(text))) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

/**
 * Additive multiset digest of a whole synced state (spec §9.6): the sum of
 * every live document's entity hash, mod 2^256. Updates in O(changes).
 */
export class StateDigest {
  private constructor(readonly value: bigint) {}

  static readonly empty = new StateDigest(0n);

  static parse(hex: string): StateDigest {
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error(`A state digest is 64 lowercase hex characters: ${hex}`);
    }
    return new StateDigest(BigInt(`0x${hex}`));
  }

  /** Digest of a complete state given as `[collection, id, canonicalValue]`. */
  static of(documents: Iterable<readonly [string, string, string]>): StateDigest {
    let digest = StateDigest.empty;
    for (const [collection, id, value] of documents) {
      digest = digest.replace(collection, id, null, value);
    }
    return digest;
  }

  /** Applies one document change: removes `before`, adds `after`. */
  replace(
    collection: string,
    id: string,
    before: string | null,
    after: string | null,
  ): StateDigest {
    if (before === after) return this;
    const next =
      (((this.value -
        entityHash(collection, id, before) +
        entityHash(collection, id, after)) %
        MODULUS) +
        MODULUS) %
      MODULUS;
    return new StateDigest(next);
  }

  get hex(): string {
    return this.value.toString(16).padStart(64, "0");
  }

  equals(other: StateDigest): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.hex;
  }
}
