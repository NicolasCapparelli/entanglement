import 'dart:async';

import 'package:entanglement/entanglement.dart';
import 'package:test/test.dart';

/// A fresh, empty account on some backend — plus, optionally, a second
/// account on the same backend for isolation checks.
class ContractHarness {
  ContractHarness({required this.backend, this.otherAccount, this.dispose});

  final SyncBackend backend;
  final SyncBackend? otherAccount;
  final Future<void> Function()? dispose;
}

/// The backend conformance suite (design spec §23.4). Every adapter must pass
/// it; the in-memory reference backend runs it too, so the two cannot drift.
void runBackendContract(Future<ContractHarness> Function() create) {
  late ContractHarness harness;
  SyncBackend backend() => harness.backend;

  setUp(() async => harness = await create());
  tearDown(() async => harness.dispose?.call());

  var digestSeed = 0;
  CommitRequest request({
    required int parent,
    String? commitId,
    int schemaVersion = 1,
    int compatibleSince = 1,
    String? message,
    List<Change>? changes,
    StateDigest? digest,
  }) => CommitRequest(
    commitId: commitId ?? newId(),
    parent: parent,
    schemaVersion: schemaVersion,
    compatibleSince: compatibleSince,
    deviceId: 'contract-device',
    deviceLabel: 'Contract',
    clientTime: DateTime.now().millisecondsSinceEpoch,
    message: message,
    stateDigest:
        digest ?? StateDigest.of([('seed', '${digestSeed++}', '{}')]),
    changes:
        changes ??
        [
          Change(collection: 'notes', id: 'n$parent', value: '{"text":"hi"}'),
        ],
  );

  Future<int> commit(int parent, {String? message, StateDigest? digest}) async {
    final result = await backend().submit(
      request(parent: parent, message: message, digest: digest),
    );
    expect(result, isA<SubmitAccepted>());
    return (result as SubmitAccepted).revision;
  }

  test('an empty account has no head', () async {
    expect(await backend().head(), isNull);
    expect(await backend().commits(after: 0, upTo: 10), isEmpty);
    expect(await backend().checkpoint(atOrBefore: 10), isNull);
    expect(await backend().restorePoints(), isEmpty);
  });

  test('the first commit creates revision 1 and the head describes it', () async {
    final digest = StateDigest.of([('notes', 'n0', '{"text":"hi"}')]);
    final result = await backend().submit(
      request(parent: 0, schemaVersion: 3, compatibleSince: 2, digest: digest),
    );
    expect(result, isA<SubmitAccepted>());
    expect((result as SubmitAccepted).revision, 1);
    final head = (await backend().head())!;
    expect(head.revision, 1);
    expect(head.schemaVersion, 3);
    expect(head.minVersion, 2);
    expect(head.stateDigest, digest);
  });

  test('a stale parent is a conflict naming the current head', () async {
    await commit(0);
    await commit(1);
    final result = await backend().submit(request(parent: 1));
    expect(result, isA<SubmitConflict>());
    expect((result as SubmitConflict).headRevision, 2);
    expect((await backend().head())!.revision, 2);
  });

  test('resubmitting a commit id is recognised, whatever its parent', () async {
    final original = request(parent: 0);
    expect(await backend().submit(original), isA<SubmitAccepted>());
    await commit(1);
    final again = await backend().submit(original);
    expect(again, isA<SubmitAccepted>());
    expect((again as SubmitAccepted).revision, 1);
    expect((await backend().head())!.revision, 2);
  });

  test('a first commit against a non-zero parent conflicts', () async {
    final result = await backend().submit(request(parent: 5));
    expect(result, isA<SubmitConflict>());
    expect((result as SubmitConflict).headRevision, 0);
    expect(await backend().head(), isNull);
  });

  test('the schema gate fences off writers older than minVersion', () async {
    await backend().submit(request(parent: 0, schemaVersion: 2, compatibleSince: 2));
    final old = await backend().submit(request(parent: 1, schemaVersion: 1, compatibleSince: 1));
    expect(old, isA<SubmitRejected>());
    expect((old as SubmitRejected).reason, RejectReason.schemaTooOld);

    // An additive newer writer does not lower the gate.
    await backend().submit(request(parent: 1, schemaVersion: 3, compatibleSince: 1));
    expect((await backend().head())!.minVersion, 2);
  });

  test('commits come back in order, contiguous, with changes intact', () async {
    final changes = [
      const Change(collection: 'tasks', id: 't1', value: '{"done":false,"title":"x"}', group: 0),
      const Change(collection: 'boards', id: 'b1', value: '{"name":"é 😀"}', group: 0),
      const Change(collection: 'tasks', id: 't0', value: null, group: 1),
    ];
    await backend().submit(request(parent: 0, changes: changes, message: 'first'));
    await commit(1);
    await commit(2);

    final all = await backend().commits(after: 0, upTo: 3);
    expect(all.map((c) => c.revision), [1, 2, 3]);
    final first = all.first.request;
    expect(first.message, 'first');
    expect(first.deviceLabel, 'Contract');
    expect([for (final c in first.changes) (c.collection, c.id, c.value, c.group)], [
      for (final c in changes) (c.collection, c.id, c.value, c.group),
    ]);

    expect((await backend().commits(after: 1, upTo: 2)).map((c) => c.revision), [2]);
    expect((await backend().commits(after: 0, upTo: 3, limit: 2)).map((c) => c.revision), [1, 2]);
  });

  test('a message makes a commit restore point; points can be added and removed', () async {
    await commit(0, message: 'labelled');
    await commit(1);
    await backend().putRestorePoint(
      RestorePoint(
        revision: 2,
        kind: RestorePointKind.manual,
        label: 'mine',
        pinned: true,
        deviceLabel: 'Contract',
        createdAt: DateTime.now().toUtc(),
      ),
    );
    var points = await backend().restorePoints();
    expect({for (final p in points) (p.revision, p.kind, p.label, p.pinned)}, {
      (1, RestorePointKind.commit, 'labelled', false),
      (2, RestorePointKind.manual, 'mine', true),
    });
    await backend().deleteRestorePoints([(revision: 1, kind: RestorePointKind.commit)]);
    points = await backend().restorePoints();
    expect(points.map((p) => p.revision), [2]);

    await expectLater(
      backend().putRestorePoint(
        RestorePoint(
          revision: 99,
          kind: RestorePointKind.manual,
          label: null,
          pinned: false,
          deviceLabel: null,
          createdAt: DateTime.now().toUtc(),
        ),
      ),
      throwsA(isA<BackendException>()),
    );
  });

  test('checkpoints must match their commit digest', () async {
    final digest = StateDigest.of([('notes', 'n0', '{"text":"hi"}')]);
    await commit(0, digest: digest);
    await commit(1);

    Checkpoint checkpoint(StateDigest digest) => Checkpoint(
      revision: 1,
      schemaVersion: 1,
      stateDigest: digest,
      entities: const [Change(collection: 'notes', id: 'n0', value: '{"text":"hi"}')],
      createdAt: DateTime.now().toUtc(),
    );

    await expectLater(
      backend().putCheckpoint(checkpoint(StateDigest.empty)),
      throwsA(isA<BackendException>()),
    );
    await backend().putCheckpoint(checkpoint(digest));
    await backend().putCheckpoint(checkpoint(digest)); // idempotent

    final stored = (await backend().checkpoint(atOrBefore: 2))!;
    expect(stored.revision, 1);
    expect(stored.stateDigest, digest);
    expect(stored.entities.single.value, '{"text":"hi"}');
    expect(await backend().checkpoint(atOrBefore: 0), isNull);
  });

  test('compaction keeps everything after its anchor and guards pinned points', () async {
    final digests = <StateDigest>[];
    for (var parent = 0; parent < 4; parent++) {
      final digest = StateDigest.of([('notes', 'rev$parent', '{}')]);
      digests.add(digest);
      await commit(parent, digest: digest);
    }
    Checkpoint at(int revision) => Checkpoint(
      revision: revision,
      schemaVersion: 1,
      stateDigest: digests[revision - 1],
      entities: const [],
      createdAt: DateTime.now().toUtc(),
    );

    await expectLater(backend().compact(anchor: 2), throwsA(isA<BackendException>()));

    await backend().putCheckpoint(at(1));
    await backend().putCheckpoint(at(3));
    await backend().putRestorePoint(
      RestorePoint(
        revision: 2,
        kind: RestorePointKind.manual,
        label: 'pinned',
        pinned: true,
        deviceLabel: null,
        createdAt: DateTime.now().toUtc(),
      ),
    );
    await expectLater(backend().compact(anchor: 3), throwsA(isA<BackendException>()));

    await backend().deleteRestorePoints([(revision: 2, kind: RestorePointKind.manual)]);
    await backend().compact(anchor: 3);
    await expectLater(
      backend().commits(after: 0, upTo: 4),
      throwsA(isA<HistoryUnavailableException>()),
    );
    expect((await backend().commits(after: 3, upTo: 4)).map((c) => c.revision), [4]);
    expect((await backend().checkpoint(atOrBefore: 4))!.revision, 3);
    expect(await backend().checkpoint(atOrBefore: 2), isNull);

    // Commits keep flowing after compaction.
    await commit(4);
    expect((await backend().head())!.revision, 5);
  });

  test('accounts are isolated', () async {
    final other = harness.otherAccount;
    if (other == null) {
      markTestSkipped('harness has no second account');
      return;
    }
    await commit(0);
    expect(await other.head(), isNull);
    expect(await other.commits(after: 0, upTo: 10), isEmpty);
    final result = await other.submit(request(parent: 0));
    expect(result, isA<SubmitAccepted>());
    expect((await backend().head())!.revision, 1);
  });

  test('hints fire when the head moves', () async {
    final hints = backend().hints;
    if (hints == null) {
      markTestSkipped('backend has no hints');
      return;
    }
    final fired = Completer<void>();
    final subscription = hints.listen((_) {
      if (!fired.isCompleted) fired.complete();
    });
    // A realtime channel takes a moment to join, and a change made before it
    // joins is simply not seen (production falls back to polling). So keep
    // moving the head until a hint arrives, rather than guessing a delay.
    for (var parent = 0; parent < 6 && !fired.isCompleted; parent++) {
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      await commit(parent);
    }
    await fired.future.timeout(const Duration(seconds: 5));
    await subscription.cancel();
  });
}
