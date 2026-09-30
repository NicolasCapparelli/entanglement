import { decodeDocument } from "./canonical.js";
import type { Unsubscribe } from "./emitter.js";
import { isIdentifier, type Collection } from "./schema.js";
import type { SqlValue } from "./sqlExecutor.js";
import type { EntanglementStore, StoreReader } from "./store.js";

export interface WhereOptions {
  isEqualTo?: unknown;
  isNotEqualTo?: unknown;
  isLessThan?: unknown;
  isLessThanOrEqualTo?: unknown;
  isGreaterThan?: unknown;
  isGreaterThanOrEqualTo?: unknown;
  whereIn?: readonly unknown[];
  isNull?: boolean;
}

/**
 * A query over one collection (spec §8.1). Any top-level field can be filtered
 * or sorted on; declared indexes only make it faster. Reads are always local.
 */
export class Query<T> {
  private readonly clauses: string[] = [];
  private readonly args: SqlValue[] = [];
  private readonly order: string[] = [];
  private limitCount: number | null = null;

  private constructor(
    private readonly store: EntanglementStore | null,
    private readonly reader: StoreReader | null,
    private readonly collection: Collection<T>,
  ) {}

  /** Over committed data; can be watched. */
  static of<T>(store: EntanglementStore, collection: Collection<T>): Query<T> {
    return new Query(store, null, collection);
  }

  /** Inside a transaction, seeing its uncommitted writes. */
  static inTransaction<T>(reader: StoreReader, collection: Collection<T>): Query<T> {
    return new Query<T>(null, reader, collection);
  }

  where(field: string, options: WhereOptions): this {
    const column = this.column(field);
    const add = (op: string, value: unknown): void => {
      this.clauses.push(`${column} ${op} ?`);
      this.args.push(bindable(value));
    };
    if ("isEqualTo" in options) {
      if (options.isEqualTo === null) this.clauses.push(`${column} IS NULL`);
      else add("=", options.isEqualTo);
    }
    if ("isNotEqualTo" in options) {
      if (options.isNotEqualTo === null) this.clauses.push(`${column} IS NOT NULL`);
      else add("!=", options.isNotEqualTo);
    }
    if ("isLessThan" in options) add("<", options.isLessThan);
    if ("isLessThanOrEqualTo" in options) add("<=", options.isLessThanOrEqualTo);
    if ("isGreaterThan" in options) add(">", options.isGreaterThan);
    if ("isGreaterThanOrEqualTo" in options) add(">=", options.isGreaterThanOrEqualTo);
    if (options.whereIn) {
      if (options.whereIn.length === 0) {
        this.clauses.push("0");
      } else {
        this.clauses.push(`${column} IN (${options.whereIn.map(() => "?").join(", ")})`);
        this.args.push(...options.whereIn.map(bindable));
      }
    }
    if (options.isNull !== undefined) {
      this.clauses.push(options.isNull ? `${column} IS NULL` : `${column} IS NOT NULL`);
    }
    return this;
  }

  orderBy(field: string, options: { descending?: boolean } = {}): this {
    this.order.push(`${this.column(field)} ${options.descending ? "DESC" : "ASC"}`);
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  get(): Promise<T[]> {
    if (this.reader) return this.load(this.reader);
    return this.store!.read((reader) => this.load(reader));
  }

  /**
   * Calls `listener` with the current results, then again whenever the
   * collection changes. Returns the function that stops watching.
   */
  watch(listener: (results: T[]) => void, onError?: (error: unknown) => void): Unsubscribe {
    const store = this.store;
    if (!store) throw new Error("A query inside a transaction cannot be watched.");
    return watchQuery(store, new Set([this.collection.name]), () => this.get(), listener, onError);
  }

  private async load(reader: StoreReader): Promise<T[]> {
    const where = this.clauses.length === 0 ? "" : ` WHERE ${this.clauses.join(" AND ")}`;
    // Ordering by id last keeps results stable when sort keys tie.
    const order = ` ORDER BY ${[...this.order, "id"].join(", ")}`;
    const limit = this.limitCount === null ? "" : ` LIMIT ${this.limitCount}`;
    const rows = await reader.sql.select(
      `SELECT doc FROM "${this.collection.table}"${where}${order}${limit}`,
      this.args,
    );
    return rows.map((row) => this.collection.decode(decodeDocument(String(row.doc))));
  }

  private column(field: string): string {
    if (!isIdentifier(field)) throw new Error(`Not a top-level field name: ${field}`);
    return this.collection.indexes.has(field) ? `"ix_${field}"` : `json_extract(doc, '$.${field}')`;
  }
}

function bindable(value: unknown): SqlValue {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value === undefined) return null;
  return value as SqlValue;
}

/**
 * Re-runs `load` whenever any of `collections` changes, never two loads at
 * once and never delivering results out of order.
 */
export function watchQuery<R>(
  store: EntanglementStore,
  collections: ReadonlySet<string>,
  load: () => Promise<R>,
  listener: (result: R) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  let running = false;
  let dirty = false;
  let stopped = false;

  const refresh = async (): Promise<void> => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        const result = await load();
        if (!stopped) listener(result);
      } while (dirty && !stopped);
    } catch (error) {
      if (!stopped) (onError ?? ((e) => console.error("[entanglement] watch failed", e)))(error);
    } finally {
      running = false;
    }
  };

  const unsubscribe = store.onChange((event) => {
    for (const name of event.collections) {
      if (collections.has(name)) {
        void refresh();
        return;
      }
    }
  });
  void refresh();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
