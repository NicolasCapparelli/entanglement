import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  changeKey,
  commitRequestFromJson,
  commitRequestToJson,
  decide,
  entityHash,
  MergePolicy,
  parseKey,
  StateDigest,
  type Decision,
  type KeyString,
} from "../src/index.js";

// The language-neutral vectors generated from the Dart implementation. This
// port is correct only if it reproduces every one of them exactly.
const vectorsDir = fileURLToPath(new URL("../../../../spec/vectors/", import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(`${vectorsDir}${name}.json`, "utf8")) as T;

const canon = (text: string | null): string | null => (text === null ? null : canonicalJson(JSON.parse(text)));

describe("canonical_json.json", () => {
  for (const { input, canonical } of load<{ input: string; canonical: string }[]>("canonical_json")) {
    test(input, () => expect(canonicalJson(JSON.parse(input))).toBe(canonical));
  }
});

describe("digest.json", () => {
  const cases = load<{ documents: [string, string, string][]; entityHashes: string[]; stateDigest: string }[]>(
    "digest",
  );
  cases.forEach(({ documents, entityHashes, stateDigest }, index) => {
    test(`state ${index}`, () => {
      documents.forEach(([collection, id, value], doc) => {
        expect(entityHash(collection, id, canon(value)).toString(16).padStart(64, "0")).toBe(entityHashes[doc]);
      });
      const digest = StateDigest.of(documents.map(([c, i, v]) => [c, i, canon(v)!] as const));
      expect(digest.hex).toBe(stateDigest);
    });
  });
});

describe("decide.json", () => {
  type Case = {
    base: string | null;
    local: string | null;
    remote: string | null;
    policy: { kind: "wholeDocument" } | { kind: "fieldwise"; groups: string[][] };
    expected: Record<string, unknown>;
  };
  const expectedOf = (decision: Decision, local: string | null, remote: string | null) => {
    const parse = (value: string | null) => (value === null ? null : JSON.parse(value));
    switch (decision.take) {
      case "local":
        return { take: "local", value: parse(local) };
      case "remote":
        return { take: "remote", value: parse(remote) };
      case "merged":
        return { take: "merged", value: parse(decision.value) };
      case "conflict":
        return { take: "conflict", reason: decision.reason, fields: [...decision.fields] };
    }
  };
  load<Case[]>("decide").forEach((c, index) => {
    test(`case ${index}: ${c.base} / ${c.local} / ${c.remote} (${c.policy.kind})`, () => {
      const policy = c.policy.kind === "fieldwise" ? MergePolicy.fieldwise(c.policy.groups) : MergePolicy.wholeDocument;
      const decision = decide({ base: canon(c.base), local: canon(c.local), remote: canon(c.remote), policy });
      expect(expectedOf(decision, canon(c.local), canon(c.remote))).toEqual(c.expected);
    });
  });
});

describe("wire.json", () => {
  const vector = load<{
    commits: Record<string, unknown>[];
    finalState: [string, string, string][];
    finalDigest: string;
  }>("wire");

  test("every commit round-trips byte-for-byte through this implementation", () => {
    for (const json of vector.commits) {
      expect(canonicalJson(commitRequestToJson(commitRequestFromJson(json)))).toBe(canonicalJson(json));
    }
  });

  test("folding the commits reaches the same state, digest and per-commit digests", () => {
    const state = new Map<KeyString, string>();
    let digest = StateDigest.empty;
    for (const json of vector.commits) {
      const request = commitRequestFromJson(json);
      for (const change of request.changes) {
        const key = changeKey(change);
        digest = digest.replace(change.collection, change.id, state.get(key) ?? null, change.value);
        if (change.value === null) state.delete(key);
        else state.set(key, change.value);
      }
      expect(digest.hex).toBe(request.stateDigest.hex);
    }
    expect(digest.hex).toBe(vector.finalDigest);
    const final = [...state]
      .map(([key, value]) => [parseKey(key).collection, parseKey(key).id, value])
      .sort((a, b) => (a[0] === b[0] ? (a[1]! < b[1]! ? -1 : 1) : a[0]! < b[0]! ? -1 : 1));
    expect(final).toEqual(vector.finalState);
  });
});
