import { canonicalJson, decodeDocument, type Json } from "./canonical.js";
import type { MergePolicy } from "./schema.js";

export type ConflictReason =
  | "bothChanged"
  | "deleteVsEdit"
  | "fieldConflict"
  | "custom"
  | "integrity";

/** The per-document three-way decision (spec §12.3). */
export type Decision =
  | { readonly take: "local" }
  | { readonly take: "remote" }
  /** A value neither side had; null deletes. */
  | { readonly take: "merged"; readonly value: string | null }
  | {
      readonly take: "conflict";
      readonly reason: ConflictReason;
      readonly fields: readonly string[];
    };

const TAKE_LOCAL: Decision = { take: "local" };
const TAKE_REMOTE: Decision = { take: "remote" };

function conflict(reason: ConflictReason, fields: string[] = []): Decision {
  return { take: "conflict", reason, fields };
}

/**
 * Decides one document given canonical base, local and remote values (null =
 * absent). Pure; identical in every implementation (vectors/decide.json).
 */
export function decide(input: {
  base: string | null;
  local: string | null;
  remote: string | null;
  policy: MergePolicy;
}): Decision {
  const { base, local, remote, policy } = input;
  if (local === remote) return TAKE_LOCAL;
  if (local === base) return TAKE_REMOTE;
  if (remote === base) return TAKE_LOCAL;
  if (local === null || remote === null) return conflict("deleteVsEdit");
  switch (policy.kind) {
    case "wholeDocument":
      return conflict("bothChanged");
    case "fieldwise":
      return fieldwise(
        base === null ? {} : decodeDocument(base),
        decodeDocument(local),
        decodeDocument(remote),
        policy.groups,
      );
    case "custom": {
      const outcome = policy.merge(
        base === null ? null : decodeDocument(base),
        decodeDocument(local),
        decodeDocument(remote),
      );
      return outcome.kind === "merged"
        ? { take: "merged", value: outcome.value === null ? null : canonicalJson(outcome.value) }
        : conflict("custom");
    }
  }
}

function fieldwise(
  base: Json,
  local: Json,
  remote: Json,
  groups: readonly (readonly string[])[],
): Decision {
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const units: string[][] = [];
  const grouped = new Set<string>();
  for (const group of groups) {
    const members = group.filter((key) => keys.has(key)).sort();
    if (members.length > 0) units.push(members);
    for (const key of group) grouped.add(key);
  }
  for (const key of [...keys].sort()) {
    if (!grouped.has(key)) units.push([key]);
  }

  const slice = (doc: Json, members: string[]): string => {
    const part: Json = {};
    for (const key of members) {
      if (Object.prototype.hasOwnProperty.call(doc, key)) part[key] = doc[key];
    }
    return canonicalJson(part);
  };

  const result: Json = {};
  const conflicts: string[] = [];
  for (const members of units) {
    const b = slice(base, members);
    const l = slice(local, members);
    const r = slice(remote, members);
    let source: Json;
    if (l === r || r === b) {
      source = local;
    } else if (l === b) {
      source = remote;
    } else {
      conflicts.push(...members);
      continue;
    }
    for (const key of members) {
      if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
    }
  }
  if (conflicts.length > 0) return conflict("fieldConflict", conflicts);
  return { take: "merged", value: canonicalJson(result) };
}

/** Union-find over keys, for merge units (spec §12.4). */
export class UnionFind<K> {
  private readonly parent = new Map<K, K>();

  add(key: K): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: K): K {
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as K;
    let node = key;
    while (this.parent.get(node) !== root) {
      const next = this.parent.get(node) as K;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  /** True when two separate sets were joined. */
  union(a: K, b: K): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;
    this.parent.set(rootB, rootA);
    return true;
  }

  unionAll(keys: Iterable<K>): void {
    let first: K | undefined;
    let hasFirst = false;
    for (const key of keys) {
      if (!hasFirst) {
        first = key;
        hasFirst = true;
      } else {
        this.union(first as K, key);
      }
    }
  }

  components(): Map<K, K[]> {
    const result = new Map<K, K[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const list = result.get(root);
      if (list) list.push(key);
      else result.set(root, [key]);
    }
    return result;
  }
}
