/// Entanglement: a local-first sync framework with a git-style VCS mode and a
/// realtime mode over one commit protocol.
///
/// The normative design lives in `Entanglement/docs/design.md`; section
/// numbers in comments ("spec §12.4") refer to it.
library;

export 'src/canonical.dart'
    show canonicalJson, decodeDocument, CanonicalJsonException;
export 'src/cipher.dart'
    show
        Cipher,
        CipherContext,
        CipherException,
        EncryptedBackend,
        KeyCipher,
        openValue,
        sealValue;
export 'src/digest.dart' show StateDigest, entityHash;
export 'src/engine.dart'
    show SyncEngine, SyncIntegrityException, SyncUnavailableException;
export 'src/entanglement_db.dart';
export 'src/in_memory_backend.dart';
export 'src/merge.dart'
    show
        ConflictReason,
        Decision,
        TakeLocal,
        TakeRemote,
        TakeMerged,
        ConflictDecision,
        decide;
export 'src/protocol.dart';
export 'src/query.dart' show Query, watchQuery;
export 'src/schema.dart';
export 'src/sql_executor.dart';
export 'src/store.dart'
    show
        ChangeEvent,
        ChangeOrigin,
        EntanglementStore,
        IntegrityViolation,
        LocalSchemaTooNew,
        Violation,
        newId;
export 'src/sync_types.dart';
export 'src/tx.dart';
