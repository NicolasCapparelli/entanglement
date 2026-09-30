import 'canonical.dart';
import 'digest.dart';
import 'schema.dart';

/// One document change inside a commit, or one document inside a checkpoint.
///
/// [value] is held as canonical JSON (null = deleted) because every consumer —
/// digests, merge, equality — wants that form; it is decoded only on the wire.
class Change {
  const Change({
    required this.collection,
    required this.id,
    required this.value,
    this.group = 0,
  });

  factory Change.fromJson(Map<String, Object?> json) => Change(
    collection: json['collection']! as String,
    id: json['id']! as String,
    value: json['op'] == 'delete' ? null : canonicalJson(json['value']),
    group: (json['group'] as num?)?.toInt() ?? 0,
  );

  final String collection;
  final String id;
  final String? value;
  final int group;

  DocKey get key => docKey(collection, id);

  Map<String, Object?> toJson() => {
    'collection': collection,
    'id': id,
    'op': value == null ? 'delete' : 'put',
    'group': group,
    if (value != null) 'value': decodeJson(value!),
  };
}

/// What a device submits (spec §18.3).
class CommitRequest {
  const CommitRequest({
    required this.commitId,
    required this.parent,
    required this.schemaVersion,
    required this.compatibleSince,
    required this.deviceId,
    required this.deviceLabel,
    required this.clientTime,
    required this.message,
    required this.stateDigest,
    required this.changes,
  });

  factory CommitRequest.fromJson(Map<String, Object?> json) => CommitRequest(
    commitId: json['commitId']! as String,
    parent: (json['parent']! as num).toInt(),
    schemaVersion: (json['schemaVersion']! as num).toInt(),
    compatibleSince: (json['compatibleSince']! as num).toInt(),
    deviceId: json['deviceId']! as String,
    deviceLabel: json['deviceLabel'] as String?,
    clientTime: (json['clientTime'] as num?)?.toInt(),
    message: json['message'] as String?,
    stateDigest: StateDigest.parse(json['stateDigest']! as String),
    changes: [
      for (final change in json['changes']! as List<Object?>)
        Change.fromJson((change! as Map).cast<String, Object?>()),
    ],
  );

  final String commitId;
  final int parent;
  final int schemaVersion;
  final int compatibleSince;
  final String deviceId;
  final String? deviceLabel;

  /// The committing device's clock. Display only — never used for ordering.
  final int? clientTime;
  final String? message;

  /// Digest of the state this commit produces.
  final StateDigest stateDigest;
  final List<Change> changes;

  Map<String, Object?> toJson() => {
    'commitId': commitId,
    'parent': parent,
    'schemaVersion': schemaVersion,
    'compatibleSince': compatibleSince,
    'deviceId': deviceId,
    'deviceLabel': deviceLabel,
    'clientTime': clientTime,
    'message': message,
    'stateDigest': stateDigest.hex,
    'changes': [for (final change in changes) change.toJson()],
  };
}

/// A commit as stored by the backend.
class Commit {
  const Commit({
    required this.revision,
    required this.request,
    required this.committedAt,
  });

  final int revision;
  final CommitRequest request;

  /// Server time. Display only.
  final DateTime committedAt;
}

/// The account's current position (spec §9.2).
class Head {
  const Head({
    required this.revision,
    required this.schemaVersion,
    required this.minVersion,
    required this.stateDigest,
    required this.updatedAt,
  });

  final int revision;

  /// Schema version of the latest writer.
  final int schemaVersion;

  /// Oldest schema version still allowed to read and write.
  final int minVersion;
  final StateDigest stateDigest;
  final DateTime updatedAt;
}

enum RejectReason { schemaTooOld, invalid, quotaExceeded }

sealed class SubmitResult {
  const SubmitResult();
}

class SubmitAccepted extends SubmitResult {
  const SubmitAccepted(this.revision);

  final int revision;
}

class SubmitConflict extends SubmitResult {
  const SubmitConflict(this.headRevision);

  final int headRevision;
}

class SubmitRejected extends SubmitResult {
  const SubmitRejected(this.reason);

  final RejectReason reason;
}

/// A complete state at a revision (spec §15.2).
class Checkpoint {
  const Checkpoint({
    required this.revision,
    required this.schemaVersion,
    required this.stateDigest,
    required this.entities,
    required this.createdAt,
  });

  final int revision;
  final int schemaVersion;
  final StateDigest stateDigest;

  /// Every live document, encoded as put changes.
  final List<Change> entities;
  final DateTime createdAt;
}

enum RestorePointKind { commit, daily, manual, beforeRestore, beforeOverwrite }

/// A user-visible label on a revision (spec §15.1).
class RestorePoint {
  const RestorePoint({
    required this.revision,
    required this.kind,
    required this.label,
    required this.pinned,
    required this.deviceLabel,
    required this.createdAt,
  });

  final int revision;
  final RestorePointKind kind;
  final String? label;
  final bool pinned;
  final String? deviceLabel;
  final DateTime createdAt;

  RestorePointKey get key => (revision: revision, kind: kind);
}

typedef RestorePointKey = ({int revision, RestorePointKind kind});

/// Every backend failure is translated into one of these (spec §18.2).
sealed class BackendException implements Exception {
  const BackendException(this.message);

  final String message;

  @override
  String toString() => '$runtimeType: $message';
}

/// Retry with backoff: network down, timeout, 5xx.
class TransientBackendException extends BackendException {
  const TransientBackendException(super.message);
}

class AuthRequiredException extends BackendException {
  const AuthRequiredException(super.message);
}

/// Commits in the requested range were compacted away.
class HistoryUnavailableException extends BackendException {
  const HistoryUnavailableException(super.message);
}

class FatalBackendException extends BackendException {
  const FatalBackendException(super.message, {this.code});

  final String? code;
}

/// The remote side of sync (spec §18.1). Authenticated as one account; the
/// account comes from the adapter's session, never from requests.
abstract interface class SyncBackend {
  /// Current head, or null when the account has never committed.
  Future<Head?> head();

  /// Commits with revision in (after, upTo], ascending, at most [limit].
  /// Throws [HistoryUnavailableException] if any of them was compacted.
  Future<List<Commit>> commits({
    required int after,
    required int upTo,
    int limit = 200,
  });

  /// Compare-and-swap publish. Idempotent on [CommitRequest.commitId].
  Future<SubmitResult> submit(CommitRequest request);

  /// Newest checkpoint with revision ≤ [atOrBefore], or null.
  Future<Checkpoint?> checkpoint({required int atOrBefore});

  /// Idempotent per revision. Refused unless its digest matches the commit at
  /// that revision.
  Future<void> putCheckpoint(Checkpoint checkpoint);

  Future<List<RestorePoint>> restorePoints();

  Future<void> putRestorePoint(RestorePoint point);

  Future<void> deleteRestorePoints(List<RestorePointKey> keys);

  /// Deletes commits ≤ [anchor] and checkpoints < [anchor]. Refused unless a
  /// checkpoint exists at exactly [anchor] and no pinned restore point
  /// precedes it.
  Future<void> compact({required int anchor});

  /// Fires when head may have moved. Carries no data. Null when unsupported.
  Stream<void>? get hints;
}

/// The signed-in account, as the adapter sees it. Credentials never reach
/// the core.
abstract interface class AccountSource {
  String? get currentAccount;

  Stream<String?> get accountChanges;
}
