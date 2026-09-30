import 'canonical.dart';
import 'schema.dart';

/// How a device syncs (spec §14). Device-local; never migrates data.
enum SyncMode {
  /// Nothing is published or applied without an explicit push or pull.
  vcs,

  /// Pushes shortly after local edits and pulls when the remote moves.
  realtime;

  static SyncMode? fromName(String? name) {
    for (final mode in values) {
      if (mode.name == name) return mode;
    }
    return null;
  }
}

/// What to do with a unit both sides changed incompatibly (spec §13.3).
enum ConflictPolicy {
  /// Hold the unit until the user resolves it. Everything else keeps syncing.
  ask,

  /// "First committed wins": keep what other devices already have.
  preferRemote,

  /// "Last to sync wins": keep this device's version.
  preferLocal;

  static ConflictPolicy? fromName(String? name) {
    for (final policy in values) {
      if (policy.name == name) return policy;
    }
    return null;
  }
}

class VcsOptions {
  const VcsOptions({
    this.conflictPolicy = ConflictPolicy.ask,
    this.autoPushEvery,
    this.remoteCheckEvery = const Duration(minutes: 5),
  });

  final ConflictPolicy conflictPolicy;

  /// Autosave: push on this interval whenever there are local changes.
  final Duration? autoPushEvery;

  /// How often to check (metadata only) whether the remote moved.
  final Duration? remoteCheckEvery;
}

class RealtimeOptions {
  const RealtimeOptions({
    this.conflictPolicy = ConflictPolicy.preferRemote,
    this.debounce = const Duration(seconds: 2),
    this.maxDelay = const Duration(seconds: 10),
    this.hintDelay = const Duration(milliseconds: 500),
    this.poll = const Duration(seconds: 60),
  });

  final ConflictPolicy conflictPolicy;

  /// Quiet period after the last local edit before pushing.
  final Duration debounce;

  /// Upper bound on push latency during continuous editing.
  final Duration maxDelay;
  final Duration hintDelay;

  /// Fallback poll in case a hint is missed.
  final Duration? poll;
}

class HistoryOptions {
  const HistoryOptions({
    this.keepRestorePoints = 10,
    this.dailyRestorePoints = true,
    this.localBackups = 3,
    this.checkpointEvery = 200,
    this.checkpointMaxAge = const Duration(days: 30),
    this.syncLogRetention = 200,
    this.syncLogMaxAge = const Duration(days: 90),
  });

  /// Newest unpinned restore points kept (the "last N states").
  final int keepRestorePoints;
  final bool dailyRestorePoints;

  /// Local full-state backups of unpublished data.
  final int localBackups;

  /// Commits between checkpoints.
  final int checkpointEvery;
  final Duration checkpointMaxAge;

  /// Sync-log entries kept: the newest [syncLogRetention], plus any younger
  /// than [syncLogMaxAge], whichever keeps more (spec §13.4). Older entries
  /// are pruned as ordinary deletes, so every device converges on the same
  /// log.
  final int syncLogRetention;
  final Duration syncLogMaxAge;
}

class SyncOptions {
  const SyncOptions({
    this.defaultMode = SyncMode.vcs,
    this.vcs = const VcsOptions(),
    this.realtime = const RealtimeOptions(),
    this.history = const HistoryOptions(),
    this.deviceLabel,
  });

  /// Used until the user picks a mode; the pick is remembered per device.
  final SyncMode defaultMode;
  final VcsOptions vcs;
  final RealtimeOptions realtime;
  final HistoryOptions history;

  /// Shown next to commits and restore points ("Pixel 8").
  final String? deviceLabel;
}

/// Where local and remote stand relative to each other (spec §10).
enum SyncRelation {
  signedOut,
  accountMismatch,
  remoteSchemaTooNew,
  conflicted,
  remoteEmpty,
  diverged,
  localAhead,
  remoteAhead,
  upToDate,
}

enum SyncActivity { idle, checking, pulling, pushing, restoring }

enum SyncProblemKind { offline, authRequired, integrity, error }

class SyncProblem {
  const SyncProblem(this.kind, this.message, {this.retryAt});

  final SyncProblemKind kind;
  final String message;
  final DateTime? retryAt;

  @override
  String toString() => 'SyncProblem($kind: $message)';
}

class SyncStatus {
  const SyncStatus({
    required this.relation,
    required this.activity,
    required this.problem,
    required this.mode,
    required this.account,
    required this.pendingCount,
    required this.heldCount,
    required this.conflictCount,
    required this.baseRevision,
    required this.knownHeadRevision,
    required this.lastCheckedAt,
    required this.lastSyncedAt,
  });

  final SyncRelation relation;
  final SyncActivity activity;
  final SyncProblem? problem;
  final SyncMode mode;
  final String? account;

  /// Documents with publishable local changes.
  final int pendingCount;

  /// Documents with local changes held back by conflicts.
  final int heldCount;

  /// Conflict units awaiting a decision.
  final int conflictCount;
  final int baseRevision;
  final int? knownHeadRevision;
  final DateTime? lastCheckedAt;
  final DateTime? lastSyncedAt;

  bool get hasLocalChanges => pendingCount + heldCount > 0;

  bool get hasRemoteChanges =>
      knownHeadRevision != null && knownHeadRevision! > baseRevision;

  @override
  String toString() =>
      'SyncStatus($relation, $activity, pending=$pendingCount, '
      'held=$heldCount, conflicts=$conflictCount, base=$baseRevision, '
      'head=$knownHeadRevision${problem == null ? '' : ', $problem'})';
}

/// One side of a conflict, per document (spec §13.1).
class ConflictEntry {
  const ConflictEntry({
    required this.key,
    required this.ancestor,
    required this.local,
    required this.remote,
    required this.reasons,
  });

  final DocKey key;
  final Json? ancestor;

  /// The current local value (the user may have edited since detection).
  final Json? local;
  final Json? remote;
  final List<String> reasons;
}

class ConflictUnit {
  const ConflictUnit({
    required this.id,
    required this.detectedAt,
    required this.entries,
  });

  final String id;
  final DateTime detectedAt;
  final List<ConflictEntry> entries;

  Set<String> get reasons => {for (final entry in entries) ...entry.reasons};
}

sealed class Resolution {
  const Resolution();

  static const Resolution keepLocal = KeepLocal();
  static const Resolution keepRemote = KeepRemote();

  /// Explicit values for every entry of the unit; null deletes.
  const factory Resolution.custom(Map<DocKey, Json?> values) = CustomResolution;
}

class KeepLocal extends Resolution {
  const KeepLocal();
}

class KeepRemote extends Resolution {
  const KeepRemote();
}

class CustomResolution extends Resolution {
  const CustomResolution(this.values);

  final Map<DocKey, Json?> values;
}

/// A recorded conflict decision (spec §13.4), synced to every device.
class SyncLogEntry {
  const SyncLogEntry({
    required this.id,
    required this.at,
    required this.deviceLabel,
    required this.automatic,
    required this.choice,
    required this.discarded,
  });

  factory SyncLogEntry.fromJson(Json json) => SyncLogEntry(
    id: json['id']! as String,
    at: DateTime.fromMillisecondsSinceEpoch((json['at']! as num).toInt()),
    deviceLabel: json['deviceLabel'] as String?,
    automatic: json['automatic'] == true,
    choice: json['choice']! as String,
    discarded: [
      for (final item in json['discarded']! as List<Object?>)
        _discardedFrom((item! as Map).cast<String, Object?>()),
    ],
  );

  final String id;
  final DateTime at;
  final String? deviceLabel;
  final bool automatic;

  /// `keepLocal`, `keepRemote` or `custom`.
  final String choice;

  /// Values this decision replaced; reinstating writes them back.
  final List<(DocKey, Json?)> discarded;

  static (DocKey, Json?) _discardedFrom(Json json) => (
    docKey(json['collection']! as String, json['id']! as String),
    json['value'] == null ? null : (json['value']! as Map).cast<String, Object?>(),
  );

  static Json encode({
    required String id,
    required String? deviceLabel,
    required bool automatic,
    required String choice,
    required Map<DocKey, String?> discarded,
  }) => {
    'id': id,
    'at': DateTime.now().millisecondsSinceEpoch,
    'deviceLabel': deviceLabel,
    'automatic': automatic,
    'choice': choice,
    'discarded': [
      for (final entry in discarded.entries)
        {
          'collection': entry.key.collection,
          'id': entry.key.id,
          'value': entry.value == null ? null : decodeJson(entry.value!),
        },
    ],
  };
}
