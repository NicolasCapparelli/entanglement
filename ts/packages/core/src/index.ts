/**
 * Entanglement: a local-first sync framework with a git-style VCS mode and a
 * realtime mode over one commit protocol. The TypeScript implementation of
 * `Entanglement/docs/design.md` ("spec §N" in comments); it speaks the same
 * wire format and passes the same conformance vectors as the Dart one.
 */
export { CipherContext, CipherError, EncryptedBackend, KeyCipher, openValue, sealValue, type Cipher, type KeyCipherOptions } from "./cipher.js";
export { canonicalJson, decodeDocument, CanonicalJsonError, type Json } from "./canonical.js";
export { StateDigest, entityHash } from "./digest.js";
export { Emitter, type Unsubscribe } from "./emitter.js";
export { SyncEngine, SyncIntegrityError, SyncUnavailableError } from "./engine.js";
export {
  EntanglementDb,
  SyncRemoteHasHistoryError,
  type AttachSyncOptions,
  type OpenOptions,
  type RemoteHistoryChoice,
  type SyncRole,
} from "./db.js";
export {
  InMemoryBackend,
  InMemoryServer,
  ManualAccountSource,
  type FaultRule,
} from "./inMemoryBackend.js";
export { decide, UnionFind, type ConflictReason, type Decision } from "./merge.js";
export * from "./protocol.js";
export { Query, type WhereOptions } from "./query.js";
export {
  Collection,
  CollectionDef,
  MergePolicy,
  Ref,
  Schema,
  compareKeys,
  keyOf,
  keyString,
  parseKey,
  type CollectionOptions,
  type CustomMergeFunction,
  type CustomMergeOutcome,
  type DocKey,
  type DocumentMigration,
  type KeyString,
  type TypedCollectionOptions,
} from "./schema.js";
export type { Row, SqlExecutor, SqlValue } from "./sqlExecutor.js";
export {
  EntanglementStore,
  IntegrityViolation,
  LocalSchemaTooNew,
  SYNC_LOG_COLLECTION,
  newId,
  type ChangeEvent,
  type ChangeOrigin,
  type Violation,
} from "./store.js";
export * from "./syncTypes.js";
export { Tx } from "./tx.js";
// Type-only reference to sql.js; importing this pulls in nothing at runtime.
export { SqlJsExecutor, type SqlJsExecutorOptions } from "./sqljs.js";
