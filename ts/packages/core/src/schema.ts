import type { Json } from "./canonical.js";

export type { Json };

/** Identifies one document. */
export interface DocKey {
  readonly collection: string;
  readonly id: string;
}

/**
 * Internal string form of a [DocKey]: `collection/id`. Collection names are
 * identifiers and never contain "/", so the first slash always separates them.
 */
export type KeyString = string & { readonly __key: unique symbol };

export function keyString(collection: string, id: string): KeyString {
  return `${collection}/${id}` as KeyString;
}

export function keyOf(key: DocKey): KeyString {
  return keyString(key.collection, key.id);
}

export function parseKey(key: KeyString): DocKey {
  const slash = key.indexOf("/");
  return { collection: key.slice(0, slash), id: key.slice(slash + 1) };
}

export function compareKeys(a: KeyString, b: KeyString): number {
  const left = parseKey(a);
  const right = parseKey(b);
  if (left.collection !== right.collection) {
    return left.collection < right.collection ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * A dependency from one document on another (spec §5.4). The target must exist
 * — and pass `check`, when given — in every committed and merged state.
 */
export class Ref {
  constructor(
    readonly collection: string,
    readonly id: string,
    readonly check?: (target: Json) => boolean,
  ) {}

  get key(): KeyString {
    return keyString(this.collection, this.id);
  }
}

export type CustomMergeOutcome =
  | { readonly kind: "merged"; readonly value: Json | null }
  | { readonly kind: "unmergeable" };

export type CustomMergeFunction = (
  base: Json | null,
  local: Json | null,
  remote: Json | null,
) => CustomMergeOutcome;

/** How a collection merges a document both sides changed (spec §5.6). */
export type MergePolicy =
  | { readonly kind: "wholeDocument" }
  | { readonly kind: "fieldwise"; readonly groups: readonly (readonly string[])[] }
  | { readonly kind: "custom"; readonly merge: CustomMergeFunction };

export const MergePolicy = {
  /** Any both-sides change is a conflict. The default. */
  wholeDocument: { kind: "wholeDocument" } as MergePolicy,
  /** Three-way per top-level key; keys in one group merge together. */
  fieldwise(groups: readonly (readonly string[])[] = []): MergePolicy {
    return { kind: "fieldwise", groups };
  },
  /** Application-defined; must be deterministic. */
  custom(merge: CustomMergeFunction): MergePolicy {
    return { kind: "custom", merge };
  },
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

export interface CollectionOptions {
  /** Top-level keys this build understands; others are carried over (§5.5). */
  fields?: Iterable<string> | null;
  /** Top-level fields to index for queries. */
  indexes?: Iterable<string>;
  /** Outgoing references (§5.4). */
  refs?: (doc: Json) => Ref[];
  merge?: MergePolicy;
  /** False for local-only collections. */
  sync?: boolean;
}

/** An untyped collection of JSON documents; the engine's view. */
export class CollectionDef {
  readonly fields: ReadonlySet<string> | null;
  readonly indexes: ReadonlySet<string>;
  readonly refs: ((doc: Json) => Ref[]) | undefined;
  readonly merge: MergePolicy;
  readonly sync: boolean;

  constructor(
    readonly name: string,
    options: CollectionOptions = {},
  ) {
    if (!isIdentifier(name)) {
      throw new Error(
        `Collection names are letters, digits and underscores, starting with a letter: ${name}`,
      );
    }
    this.fields = options.fields ? new Set(options.fields) : null;
    this.indexes = new Set(options.indexes ?? []);
    for (const field of this.indexes) {
      if (!isIdentifier(field)) throw new Error(`Not an identifier: ${field}`);
    }
    this.refs = options.refs;
    this.merge = options.merge ?? MergePolicy.wholeDocument;
    this.sync = options.sync ?? true;
  }

  /** A collection written by a newer build: stored and synced untouched. */
  static opaque(name: string): CollectionDef {
    return new CollectionDef(name);
  }

  get table(): string {
    return `c_${this.name}`;
  }

  refsOf(doc: Json): Ref[] {
    return this.refs?.(doc) ?? [];
  }
}

export interface TypedCollectionOptions<T> extends CollectionOptions {
  decode: (json: Json) => T;
  encode: (value: T) => Json;
  idOf: (value: T) => string;
}

/** A collection with a typed codec for application model types. */
export class Collection<T> extends CollectionDef {
  readonly decode: (json: Json) => T;
  readonly encode: (value: T) => Json;
  readonly idOf: (value: T) => string;

  constructor(name: string, options: TypedCollectionOptions<T>) {
    super(name, options);
    this.decode = options.decode;
    this.encode = options.encode;
    this.idOf = options.idOf;
  }

  /** Plain JSON values carrying their id under `idField`. */
  static json(
    name: string,
    options: CollectionOptions & { idField?: string } = {},
  ): Collection<Json> {
    const idField = options.idField ?? "id";
    return new Collection<Json>(name, {
      ...options,
      decode: (json) => json,
      encode: (value) => value,
      idOf: (value) => {
        const id = value[idField];
        if (typeof id !== "string") throw new Error(`Document has no "${idField}".`);
        return id;
      },
    });
  }
}

/** A pure, deterministic document transform. Return null to delete. */
export type DocumentMigration = (collection: string, doc: Json) => Json | null;

/** The application's data model (spec §17). */
export class Schema {
  readonly version: number;
  /** Oldest format that can safely read and write data this build writes. */
  readonly compatibleSince: number;
  readonly collections: readonly CollectionDef[];
  /** `toVersion -> transform`. */
  readonly migrations: ReadonlyMap<number, DocumentMigration>;

  constructor(options: {
    version: number;
    compatibleSince?: number;
    collections: CollectionDef[];
    migrations?: Record<number, DocumentMigration> | Map<number, DocumentMigration>;
  }) {
    this.version = options.version;
    this.compatibleSince = options.compatibleSince ?? options.version;
    this.collections = [...options.collections];
    const migrations = options.migrations ?? {};
    this.migrations =
      migrations instanceof Map
        ? migrations
        : new Map(Object.entries(migrations).map(([k, v]) => [Number(k), v]));
    if (this.version < 1) throw new Error("Schema version must be at least 1.");
    if (this.compatibleSince > this.version) {
      throw new Error("compatibleSince cannot exceed version.");
    }
    const names = new Set<string>();
    for (const collection of this.collections) {
      if (collection.name.startsWith("ent_")) {
        throw new Error(`The "ent_" prefix is reserved: ${collection.name}`);
      }
      if (names.has(collection.name)) {
        throw new Error(`Duplicate collection ${collection.name}.`);
      }
      names.add(collection.name);
    }
  }
}
