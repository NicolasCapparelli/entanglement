import 'dart:async';

import 'protocol.dart';

/// An [AccountSource] driven by hand, for tests and local-only apps.
class ManualAccountSource implements AccountSource {
  ManualAccountSource([this._current]);

  String? _current;
  final _changes = StreamController<String?>.broadcast();

  @override
  String? get currentAccount => _current;

  @override
  Stream<String?> get accountChanges => _changes.stream;

  void signIn(String accountId) {
    _current = accountId;
    _changes.add(accountId);
  }

  void signOut() {
    _current = null;
    _changes.add(null);
  }
}

/// Decides whether a backend call fails, for fault injection. `op` is the
/// method name; `after` is true once the server has already done the work
/// (a lost response).
typedef FaultRule = bool Function(String op, {required bool after});

/// The reference server (spec §18.4), holding any number of accounts in memory.
///
/// This is both the test double and the executable definition of what every
/// real adapter must do; the adapter conformance suite runs against it too.
class InMemoryServer {
  final Map<String, _AccountState> _accounts = {};

  /// Consulted before and after every call; returning true throws a
  /// [TransientBackendException] at that point.
  FaultRule? faults;

  int submitCount = 0;

  _AccountState _state(String account) =>
      _accounts.putIfAbsent(account, _AccountState.new);

  /// Direct view for tests.
  List<Commit> commitsOf(String account) =>
      List.unmodifiable(_state(account).commits.values);

  Head? headOf(String account) => _state(account).head;
}

class _AccountState {
  Head? head;
  final Map<int, Commit> commits = {};
  final Map<String, int> commitIds = {};
  final Map<int, Checkpoint> checkpoints = {};
  final Map<RestorePointKey, RestorePoint> restorePoints = {};
  final hints = StreamController<void>.broadcast();
  int compactedThrough = 0;
}

class InMemoryBackend implements SyncBackend {
  InMemoryBackend(this.server, this.accounts);

  final InMemoryServer server;
  final AccountSource accounts;

  _AccountState get _account {
    final id = accounts.currentAccount;
    if (id == null) throw const AuthRequiredException('Not signed in.');
    return server._state(id);
  }

  Future<T> _call<T>(String op, T Function(_AccountState account) body) async {
    await Future<void>.delayed(Duration.zero);
    final faults = server.faults;
    if (faults != null && faults(op, after: false)) {
      throw TransientBackendException('Injected failure before $op.');
    }
    final result = body(_account);
    if (faults != null && faults(op, after: true)) {
      throw TransientBackendException('Injected lost response after $op.');
    }
    return result;
  }

  @override
  Future<Head?> head() => _call('head', (account) => account.head);

  @override
  Future<List<Commit>> commits({
    required int after,
    required int upTo,
    int limit = 200,
  }) => _call('commits', (account) {
    if (after < account.compactedThrough) {
      throw HistoryUnavailableException(
        'Commits up to ${account.compactedThrough} were compacted.',
      );
    }
    final result = <Commit>[];
    for (var revision = after + 1; revision <= upTo; revision++) {
      final commit = account.commits[revision];
      if (commit == null) break;
      result.add(commit);
      if (result.length >= limit) break;
    }
    return result;
  });

  @override
  Future<SubmitResult> submit(CommitRequest request) => _call('submit', (
    account,
  ) {
    server.submitCount++;
    // Idempotency comes before everything else: a retry of a commit that was
    // accepted but whose answer was lost must be told "accepted", not
    // "conflict".
    final existing = account.commitIds[request.commitId];
    if (existing != null) return SubmitAccepted(existing);

    final head = account.head;
    if (head != null && request.schemaVersion < head.minVersion) {
      return const SubmitRejected(RejectReason.schemaTooOld);
    }
    final current = head?.revision ?? 0;
    if (request.parent != current) return SubmitConflict(current);

    final revision = current + 1;
    final now = DateTime.now().toUtc();
    account.commits[revision] = Commit(
      revision: revision,
      request: request,
      committedAt: now,
    );
    account.commitIds[request.commitId] = revision;
    account.head = Head(
      revision: revision,
      schemaVersion: request.schemaVersion,
      minVersion: head == null
          ? request.compatibleSince
          : (request.compatibleSince > head.minVersion
                ? request.compatibleSince
                : head.minVersion),
      stateDigest: request.stateDigest,
      updatedAt: now,
    );
    if (request.message != null) {
      final point = RestorePoint(
        revision: revision,
        kind: RestorePointKind.commit,
        label: request.message,
        pinned: false,
        deviceLabel: request.deviceLabel,
        createdAt: now,
      );
      account.restorePoints[point.key] = point;
    }
    account.hints.add(null);
    return SubmitAccepted(revision);
  });

  @override
  Future<Checkpoint?> checkpoint({required int atOrBefore}) =>
      _call('checkpoint', (account) {
        Checkpoint? best;
        for (final checkpoint in account.checkpoints.values) {
          if (checkpoint.revision <= atOrBefore &&
              (best == null || checkpoint.revision > best.revision)) {
            best = checkpoint;
          }
        }
        return best;
      });

  @override
  Future<void> putCheckpoint(Checkpoint checkpoint) =>
      _call('putCheckpoint', (account) {
        final commit = account.commits[checkpoint.revision];
        if (commit == null) {
          throw FatalBackendException(
            'No commit at revision ${checkpoint.revision}.',
          );
        }
        if (commit.request.stateDigest != checkpoint.stateDigest) {
          throw const FatalBackendException(
            'Checkpoint digest does not match its commit.',
            code: 'digest_mismatch',
          );
        }
        account.checkpoints.putIfAbsent(checkpoint.revision, () => checkpoint);
      });

  @override
  Future<List<RestorePoint>> restorePoints() => _call(
    'restorePoints',
    (account) =>
        account.restorePoints.values.toList()
          ..sort((a, b) => b.revision.compareTo(a.revision)),
  );

  @override
  Future<void> putRestorePoint(RestorePoint point) =>
      _call('putRestorePoint', (account) {
        final head = account.head?.revision ?? 0;
        if (point.revision < 0 || point.revision > head) {
          throw FatalBackendException('Revision ${point.revision} not found.');
        }
        account.restorePoints[point.key] = point;
      });

  @override
  Future<void> deleteRestorePoints(List<RestorePointKey> keys) =>
      _call('deleteRestorePoints', (account) {
        keys.forEach(account.restorePoints.remove);
      });

  @override
  Future<void> compact({required int anchor}) => _call('compact', (account) {
    if (!account.checkpoints.containsKey(anchor)) {
      throw FatalBackendException('No checkpoint at $anchor.');
    }
    final pinnedBefore = account.restorePoints.values.any(
      (point) => point.pinned && point.revision < anchor,
    );
    if (pinnedBefore) {
      throw const FatalBackendException(
        'A pinned restore point precedes the anchor.',
      );
    }
    account.commits.removeWhere((revision, _) => revision <= anchor);
    account.commitIds.removeWhere((_, revision) => revision <= anchor);
    account.checkpoints.removeWhere((revision, _) => revision < anchor);
    if (anchor > account.compactedThrough) account.compactedThrough = anchor;
  });

  @override
  Stream<void>? get hints {
    final id = accounts.currentAccount;
    return id == null ? null : server._state(id).hints.stream;
  }
}
