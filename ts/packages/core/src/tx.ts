import { canonicalJson, type Json } from "./canonical.js";
import { Query } from "./query.js";
import { keyString, type Collection, type CollectionDef, type KeyString } from "./schema.js";
import type { StoreTxn } from "./store.js";

/**
 * The application's handle inside `db.write` (spec §7.1). Everything written
 * through one Tx is one SQLite transaction and one coupling group. Await only
 * Tx calls inside the callback.
 */
export class Tx {
  constructor(private readonly txn: StoreTxn) {}

  async get<T>(collection: Collection<T>, id: string): Promise<T | null> {
    const json = await this.txn.getJson(keyString(collection.name, id));
    return json === null ? null : collection.decode(json);
  }

  /** A query that sees this transaction's own writes. */
  query<T>(collection: Collection<T>): Query<T> {
    return Query.inTransaction(this.txn, collection);
  }

  /**
   * Inserts or replaces `value`. Stored top-level keys this build does not
   * declare in `fields` are carried over (spec §5.5).
   */
  put<T>(collection: Collection<T>, value: T): Promise<void> {
    return this.putAt(
      collection,
      keyString(collection.name, collection.idOf(value)),
      collection.encode(value),
    );
  }

  /** Untyped variant of put. */
  putJson(collection: CollectionDef, id: string, document: Json): Promise<void> {
    return this.putAt(collection, keyString(collection.name, id), document);
  }

  /** Merges `changes` into the stored document's top-level keys. */
  async patch<T>(collection: Collection<T>, id: string, changes: Json): Promise<void> {
    const key = keyString(collection.name, id);
    const current = await this.txn.getJson(key);
    if (current === null) throw new Error(`Cannot patch missing ${collection.name}/${id}.`);
    await this.putAt(collection, key, { ...current, ...changes });
  }

  delete<T>(collection: Collection<T>, id: string): Promise<void> {
    return this.txn.put(keyString(collection.name, id), null);
  }

  private async putAt(collection: CollectionDef, key: KeyString, document: Json): Promise<void> {
    let next = document;
    const known = collection.fields;
    if (known) {
      const stored = await this.txn.getJson(key);
      if (stored) {
        const carried: Json = {};
        for (const [field, value] of Object.entries(stored)) {
          if (!known.has(field)) carried[field] = value;
        }
        next = { ...carried, ...document };
      }
    }
    await this.txn.put(key, canonicalJson(next));
  }
}
