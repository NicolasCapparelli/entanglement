import 'package:entanglement/entanglement.dart';
import 'package:test/test.dart';

import 'support.dart';

void main() {
  late InMemoryServer server;
  final devices = <Device>[];

  Future<Device> device(
    String name, {
    String? account = 'alice',
    SyncOptions options = quietOptions,
    Schema? schema,
  }) async {
    final created = await Device.create(
      server,
      name: name,
      account: account,
      options: options,
      schema: schema,
    );
    devices.add(created);
    return created;
  }

  /// Two devices sharing a board with one task, fully synced.
  Future<(Device, Device)> syncedPair() async {
    final a = await device('a');
    final b = await device('b');
    await a.addBoard('b1', 'Home');
    await a.addTask('t1', 'Milk', 'b1');
    await a.sync.push();
    await b.sync.pull();
    return (a, b);
  }

  setUp(() => server = InMemoryServer());
  tearDown(() async {
    for (final device in devices) {
      await device.close();
    }
    devices.clear();
  });

  test('a push publishes; another device sees it is behind and pulls', () async {
    final a = await device('a');
    final b = await device('b');
    await a.addBoard('b1', 'Home');
    await a.addTask('t1', 'Milk', 'b1');
    await a.sync.checkRemote();
    expect(a.sync.status.relation, SyncRelation.remoteEmpty);

    await a.sync.push();
    expect(a.sync.status.relation, SyncRelation.upToDate);
    expect(a.sync.status.baseRevision, 1);

    await b.sync.checkRemote();
    expect(b.sync.status.relation, SyncRelation.remoteAhead);
    expect(await b.task('t1'), isNull, reason: 'VCS never applies on its own');

    await b.sync.pull();
    expect(b.sync.status.relation, SyncRelation.upToDate);
    expect(await b.state(), await a.state());
  });

  test('changes to different documents merge without asking', () async {
    final (a, b) = await syncedPair();
    await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'Oat milk'}));
    await a.sync.push();

    await b.addTask('t2', 'Bread', 'b1');
    await b.sync.checkRemote();
    expect(b.sync.status.relation, SyncRelation.diverged);

    await b.sync.push(); // refused by CAS, pulls, merges cleanly, publishes
    await a.sync.pull();
    expect(a.sync.status.relation, SyncRelation.upToDate);
    expect(b.sync.status.conflictCount, 0);
    expect(await a.state(), await b.state());
    expect((await b.task('t1'))!['title'], 'Oat milk');
  });

  test('different fields of one document merge field-wise', () async {
    final (a, b) = await syncedPair();
    await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'Oat milk'}));
    await a.sync.push();
    await b.db.write((tx) => tx.patch(tasks, 't1', {'done': true}));
    await b.sync.push();
    await a.sync.pull();
    expect(await a.task('t1'), {
      'id': 't1',
      'title': 'Oat milk',
      'boardId': 'b1',
      'done': true,
      'order': 0,
    });
    expect(await a.state(), await b.state());
  });

  group('conflicts in VCS mode', () {
    late Device a;
    late Device b;

    setUp(() async {
      (a, b) = await syncedPair();
      await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'A says'}));
      await a.sync.push();
      await b.db.write((tx) => tx.patch(tasks, 't1', {'title': 'B says'}));
      await b.db.write((tx) => tx.put(notes, {'id': 'n1', 'text': 'unrelated'}));
      await b.sync.push();
    });

    test('are held while everything else still publishes', () async {
      expect(b.sync.status.relation, SyncRelation.conflicted);
      expect(b.sync.status.heldCount, 1);
      expect(b.sync.status.pendingCount, 0);

      final units = await b.sync.conflicts();
      final entry = units.single.entries.single;
      expect(entry.key, docKey('tasks', 't1'));
      expect(entry.ancestor!['title'], 'Milk');
      expect(entry.local!['title'], 'B says');
      expect(entry.remote!['title'], 'A says');
      expect(units.single.reasons, {'fieldConflict'});

      await a.sync.pull();
      expect(await a.db.get(notes, 'n1'), isNotNull);
      expect((await a.task('t1'))!['title'], 'A says');
    });

    test('keepRemote adopts theirs and logs mine', () async {
      final unit = (await b.sync.conflicts()).single;
      await b.sync.resolve(unit.id, Resolution.keepRemote);
      expect((await b.task('t1'))!['title'], 'A says');
      expect(b.sync.status.relation, isNot(SyncRelation.conflicted));

      final log = await b.sync.log();
      expect(log.single.choice, 'keepRemote');
      expect(log.single.automatic, isFalse);
      expect(log.single.discarded.single.$2!['title'], 'B says');

      await b.sync.push();
      await a.sync.pull();
      expect(await a.state(), await b.state());
    });

    test('keepLocal publishes mine', () async {
      final unit = (await b.sync.conflicts()).single;
      await b.sync.resolve(unit.id, Resolution.keepLocal);
      await b.sync.push();
      await a.sync.pull();
      expect((await a.task('t1'))!['title'], 'B says');
      expect(await a.state(), await b.state());
    });

    test('a logged decision can be reinstated', () async {
      final unit = (await b.sync.conflicts()).single;
      await b.sync.resolve(unit.id, Resolution.keepRemote);
      await b.sync.reinstate((await b.sync.log()).single.id);
      expect((await b.task('t1'))!['title'], 'B says');
      await b.sync.push();
      await a.sync.pull();
      expect((await a.task('t1'))!['title'], 'B says');
    });
  });

  test('preferRemote resolves automatically, logs, and syncs the log', () async {
    final (a, b) = await syncedPair();
    await b.sync.setConflictPolicy(ConflictPolicy.preferRemote);
    await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'A says'}));
    await a.sync.push();
    await b.db.write((tx) => tx.patch(tasks, 't1', {'title': 'B says'}));
    await b.sync.push();

    expect(b.sync.status.conflictCount, 0);
    expect((await b.task('t1'))!['title'], 'A says');
    final log = await b.sync.log();
    expect(log.single.automatic, isTrue);
    expect(log.single.discarded.single.$2!['title'], 'B says');

    // The decision is visible on the device whose value won, too.
    await a.sync.pull();
    expect((await a.sync.log()).single.id, log.single.id);
    expect(await a.state(), await b.state());
  });

  test('the sync log keeps its retention, and the pruning syncs', () async {
    final a = await device('a');
    final b = await device(
      'b',
      options: const SyncOptions(
        deviceLabel: 'test',
        vcs: VcsOptions(remoteCheckEvery: null),
        history: HistoryOptions(
          dailyRestorePoints: false,
          syncLogRetention: 2,
          syncLogMaxAge: Duration.zero,
        ),
      ),
    );
    await a.addBoard('b1', 'Home');
    await a.addTask('t1', 'Milk', 'b1');
    await a.sync.push();
    await b.sync.pull();
    await b.sync.setConflictPolicy(ConflictPolicy.preferRemote);

    final kept = <String>[];
    for (var round = 0; round < 4; round++) {
      await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'A $round'}));
      await a.sync.push();
      await b.db.write((tx) => tx.patch(tasks, 't1', {'title': 'B $round'}));
      await b.sync.push();
      kept.insert(0, (await b.sync.log()).first.id);
      await a.sync.pull();
    }

    final log = await b.sync.log();
    expect(log.map((entry) => entry.id), kept.take(2));
    expect(log.first.discarded.single.$2!['title'], 'B 3');
    // Pruned entries are ordinary deletes: every device ends up with the same
    // log.
    expect((await a.sync.log()).map((entry) => entry.id), kept.take(2));
    expect(await a.state(), await b.state());
    expect(a.sync.status.pendingCount, 0);
    expect(b.sync.status.pendingCount, 0);
  });

  test('preferLocal keeps this device and publishes over the other', () async {
    final (a, b) = await syncedPair();
    await b.sync.setConflictPolicy(ConflictPolicy.preferLocal);
    await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'A says'}));
    await a.sync.push();
    await b.db.write((tx) => tx.patch(tasks, 't1', {'title': 'B says'}));
    await b.sync.push();
    await a.sync.pull();
    expect((await a.task('t1'))!['title'], 'B says');
    expect((await a.sync.log()).single.discarded.single.$2!['title'], 'A says');
  });

  group('integrity across a merge', () {
    late Device a;
    late Device b;

    setUp(() async {
      (a, b) = await syncedPair();
      await a.addBoard('b2', 'Work');
      await a.sync.push();
      await b.sync.pull();
      // A deletes b2 while B moves t1 onto it. Each change is clean on its
      // own; together they would leave t1 pointing at nothing.
      await a.db.write((tx) => tx.delete(boards, 'b2'));
      await a.sync.push();
      await b.db.write((tx) => tx.patch(tasks, 't1', {'boardId': 'b2'}));
      await b.sync.pull();
    });

    test('joins both changes into one conflict unit', () async {
      final unit = (await b.sync.conflicts()).single;
      expect(
        unit.entries.map((entry) => entry.key).toSet(),
        {docKey('tasks', 't1'), docKey('boards', 'b2')},
      );
      expect(unit.reasons, contains('integrity'));
      // Tentatively local: b2 still exists here so t1 is valid.
      expect(await b.board('b2'), isNotNull);
    });

    test('keepLocal restores the board everywhere', () async {
      await b.sync.resolve((await b.sync.conflicts()).single.id, Resolution.keepLocal);
      await b.sync.push();
      await a.sync.pull();
      expect(await a.board('b2'), isNotNull);
      expect((await a.task('t1'))!['boardId'], 'b2');
      expect(await a.state(), await b.state());
    });

    test('keepRemote keeps the deletion and puts the task back', () async {
      await b.sync.resolve((await b.sync.conflicts()).single.id, Resolution.keepRemote);
      expect(await b.board('b2'), isNull);
      expect((await b.task('t1'))!['boardId'], 'b1');
      await b.sync.push();
      await a.sync.pull();
      expect(await a.state(), await b.state());
    });
  });

  test('edits that depend on held data wait for the conflict', () async {
    final (a, b) = await syncedPair();
    await a.addBoard('b2', 'Work');
    await a.sync.push();
    await b.sync.pull();

    await a.db.write((tx) => tx.delete(boards, 'b2'));
    await a.sync.push();
    await b.db.write((tx) => tx.patch(boards, 'b2', {'name': 'Work!'}));
    await b.sync.pull();
    expect((await b.sync.conflicts()).single.reasons, {'deleteVsEdit'});

    // A new task on the held board, in its own transaction.
    await b.addTask('t9', 'on the held board', 'b2');
    await b.sync.push();
    await a.sync.pull();
    expect(await a.task('t9'), isNull, reason: 'would dangle without b2');

    await b.sync.resolve((await b.sync.conflicts()).single.id, Resolution.keepLocal);
    await b.sync.push();
    await a.sync.pull();
    expect(await a.board('b2'), isNotNull);
    expect(await a.task('t9'), isNotNull);
    expect(await a.state(), await b.state());
  });

  test('realtime mode pushes after edits settle and pulls on hints', () async {
    const options = SyncOptions(
      defaultMode: SyncMode.realtime,
      realtime: RealtimeOptions(
        debounce: Duration(milliseconds: 20),
        maxDelay: Duration(milliseconds: 200),
        hintDelay: Duration(milliseconds: 10),
        poll: null,
      ),
      history: HistoryOptions(dailyRestorePoints: false),
    );
    final a = await device('a', options: options);
    final b = await device('b', options: options);

    Future<void> eventually(Future<bool> Function() condition) async {
      final deadline = DateTime.now().add(const Duration(seconds: 3));
      while (!await condition()) {
        if (DateTime.now().isAfter(deadline)) fail('timed out');
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
    }

    await a.addBoard('b1', 'Home');
    await a.addTask('t1', 'Milk', 'b1');
    await eventually(() async => await b.task('t1') != null);

    await b.db.write((tx) => tx.patch(tasks, 't1', {'done': true}));
    await eventually(() async => (await a.task('t1'))!['done'] == true);
    expect(server.commitsOf('alice'), hasLength(2), reason: 'edits coalesce into one commit');

    // Switching to VCS stops automatic publication; the data is untouched.
    await a.sync.setMode(SyncMode.vcs);
    await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'Oat milk'}));
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(server.commitsOf('alice'), hasLength(2));
    expect(a.sync.status.relation, SyncRelation.localAhead);
  });

  group('importing existing data', () {
    String doc(Map<String, Object?> json) => canonicalJson(json);
    DocKey t(String id) => docKey('tasks', id);
    final board = doc({'id': 'b1', 'name': 'Home'});
    Map<String, Object?> task(String id, String title) =>
        {'id': id, 'title': title, 'boardId': 'b1', 'done': false, 'order': 0};

    test('the first importer publishes and pins its data', () async {
      final a = await device('a');
      await a.sync.importState(
        puts: {docKey('boards', 'b1'): board, t('t1'): doc(task('t1', 'Milk'))},
        label: 'legacy',
      );
      expect(a.sync.status.relation, SyncRelation.upToDate);
      final pinned = (await a.sync.restorePoints()).where((p) => p.pinned).single;
      expect(pinned.label, 'legacy');
      expect(pinned.revision, a.sync.status.baseRevision);
    });

    test('later importers merge three-way against the first import', () async {
      final a = await device('a');
      await a.sync.importState(
        puts: {
          docKey('boards', 'b1'): board,
          t('t1'): doc(task('t1', 'Milk')),
          t('t2'): doc(task('t2', 'Bread')),
          t('t4'): doc(task('t4', 'Only on A')),
        },
        label: 'legacy',
      );
      // After importing, A keeps working in the new system.
      await a.db.write((tx) => tx.patch(tasks, 't2', {'done': true}));
      await a.sync.push();

      // B's legacy data: t1 renamed later in the old log, t2 unchanged, t3
      // new, t4 never seen (no record), t5 deleted with a record.
      final b = await device('b');
      await b.sync.importState(
        puts: {
          docKey('boards', 'b1'): board,
          t('t1'): doc(task('t1', 'Oat milk')),
          t('t2'): doc(task('t2', 'Bread')),
          t('t3'): doc(task('t3', 'New on B')),
        },
        deletes: {t('t5')},
        label: 'legacy',
      );
      expect(b.sync.status.conflictCount, 0);
      await a.sync.pull();
      expect((await a.task('t1'))!['title'], 'Oat milk');
      expect((await a.task('t2'))!['done'], isTrue, reason: "A's newer edit survives");
      expect(await a.task('t3'), isNotNull);
      expect(await a.task('t4'), isNotNull, reason: 'B never saw it; nothing deletes it');
      expect(await a.state(), await b.state());
    });

    test('a record of deletion propagates', () async {
      final a = await device('a');
      await a.sync.importState(
        puts: {docKey('boards', 'b1'): board, t('t1'): doc(task('t1', 'Milk'))},
        label: 'legacy',
      );
      final b = await device('b');
      await b.sync.importState(
        puts: {docKey('boards', 'b1'): board},
        deletes: {t('t1')},
        label: 'legacy',
      );
      await a.sync.pull();
      expect(await a.task('t1'), isNull);
    });

    test('the same document changed on both sides after the import conflicts', () async {
      final a = await device('a');
      await a.sync.importState(
        puts: {docKey('boards', 'b1'): board, t('t1'): doc(task('t1', 'Milk'))},
        label: 'legacy',
      );
      await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'A after migrating'}));
      await a.sync.push();
      final b = await device('b');
      await b.sync.importState(
        puts: {docKey('boards', 'b1'): board, t('t1'): doc(task('t1', 'B in the old log'))},
        label: 'legacy',
      );
      final unit = (await b.sync.conflicts()).single;
      expect(unit.entries.single.ancestor!['title'], 'Milk');
    });

    test("an importer keeps fields it does not know from the first import", () async {
      final a = await device('a');
      await a.sync.importState(
        puts: {
          docKey('boards', 'b1'): board,
          t('t1'): doc({...task('t1', 'Milk'), 'reminderTime': '08:00'}),
        },
        label: 'legacy',
      );
      // B's build does not know reminderTime (not in the tasks' fields).
      final b = await device('b');
      await b.sync.importState(
        puts: {docKey('boards', 'b1'): board, t('t1'): doc(task('t1', 'Oat milk'))},
        label: 'legacy',
      );
      await a.sync.pull();
      expect(await a.task('t1'), {...task('t1', 'Oat milk'), 'reminderTime': '08:00'});
    });

    test('unpinning the anchor lets history be compacted again', () async {
      final a = await device('a');
      await a.sync.importState(puts: {docKey('boards', 'b1'): board}, label: 'legacy');
      final pinned = (await a.sync.restorePoints()).singleWhere((p) => p.pinned);
      await a.sync.setPinned(pinned, false);
      expect((await a.sync.restorePoints()).where((p) => p.pinned), isEmpty);
    });
  });

  group('uploads interrupted by lost responses', () {
    void loseNextSubmitResponse() {
      var fired = false;
      server.faults = (op, {required after}) {
        if (op == 'submit' && after && !fired) {
          fired = true;
          return true;
        }
        return false;
      };
    }

    test('the retry is recognised and nothing is committed twice', () async {
      final a = await device('a');
      await a.addBoard('b1', 'Home');
      loseNextSubmitResponse();
      await expectLater(a.sync.push(), throwsA(isA<TransientBackendException>()));
      expect(a.sync.status.problem?.kind, SyncProblemKind.offline);

      await a.db.write((tx) => tx.patch(boards, 'b1', {'name': 'Home 2'}));
      await a.sync.push();
      expect(server.commitsOf('alice'), hasLength(2));
      expect(a.sync.status.relation, SyncRelation.upToDate);
      expect(a.sync.status.problem, isNull);

      final b = await device('b');
      await b.sync.pull();
      expect((await b.board('b1'))!['name'], 'Home 2');
    });

    test('an undo made during the upload is not lost', () async {
      final (a, b) = await syncedPair();
      await a.db.write((tx) => tx.patch(boards, 'b1', {'name': 'Renamed'}));
      loseNextSubmitResponse();
      await expectLater(a.sync.push(), throwsA(isA<TransientBackendException>()));
      // The server has "Renamed"; the user now undoes it locally.
      await a.db.write((tx) => tx.patch(boards, 'b1', {'name': 'Home'}));
      await a.sync.push();
      await b.sync.pull();
      expect((await b.board('b1'))!['name'], 'Home');
      expect(await a.state(), await b.state());
    });
  });

  group('history', () {
    test('a new device bootstraps from a checkpoint after compaction', () async {
      const options = SyncOptions(
        vcs: VcsOptions(remoteCheckEvery: null),
        history: HistoryOptions(
          dailyRestorePoints: false,
          checkpointEvery: 2,
          keepRestorePoints: 1,
        ),
      );
      final a = await device('a', options: options);
      await a.addBoard('b1', 'one');
      await a.sync.push();
      await a.addTask('t1', 'x', 'b1');
      await a.sync.push();
      await a.db.write((tx) => tx.patch(boards, 'b1', {'name': 'three'}));
      await a.sync.push();
      expect(server.commitsOf('alice').first.revision, greaterThan(1));

      final c = await device('c');
      await c.sync.pull();
      expect(c.sync.status.relation, SyncRelation.upToDate);
      expect(await c.state(), await a.state());
    });

    test('a long-offline device merges exactly and resurrects nothing', () async {
      const options = SyncOptions(
        vcs: VcsOptions(remoteCheckEvery: null),
        history: HistoryOptions(
          dailyRestorePoints: false,
          checkpointEvery: 1,
          keepRestorePoints: 1,
        ),
      );
      final a = await device('a', options: options);
      final b = await device('b');
      await a.addBoard('b1', 'Home');
      await a.addTask('t1', 'keep', 'b1');
      await a.addTask('t2', 'delete me', 'b1');
      await a.sync.push();
      await b.sync.pull();

      // B goes offline and edits t1. Meanwhile A deletes t2 and history is
      // compacted past B's base.
      await b.db.write((tx) => tx.patch(tasks, 't1', {'title': 'edited offline'}));
      await a.db.write((tx) => tx.delete(tasks, 't2'));
      await a.sync.push();
      await a.addTask('t3', 'new', 'b1');
      await a.sync.push();
      // B's base (revision 1) is no longer in commit history.
      expect(server.commitsOf('alice').where((c) => c.revision <= 2), isEmpty);

      await b.sync.sync();
      expect(await b.task('t2'), isNull);
      expect((await b.task('t1'))!['title'], 'edited offline');
      await a.sync.pull();
      expect(await a.state(), await b.state());
    });

    test('restore brings back an earlier state as a new commit', () async {
      final a = await device('a');
      final b = await device('b');
      await a.addBoard('b1', 'first');
      await a.sync.push(message: 'first version');
      await a.db.write((tx) => tx.patch(boards, 'b1', {'name': 'second'}));
      await a.addBoard('b2', 'extra');
      await a.sync.push();

      final points = await a.sync.restorePoints();
      final first = points.firstWhere((point) => point.label == 'first version');
      await a.sync.restore(first);
      expect((await a.board('b1'))!['name'], 'first');
      expect(await a.board('b2'), isNull);
      expect(a.sync.status.baseRevision, 3);
      expect(
        (await a.sync.restorePoints()).map((point) => point.kind),
        contains(RestorePointKind.beforeRestore),
      );

      await b.sync.pull();
      expect(await b.state(), await a.state());
    });

    test('overwriteRemoteWithLocal makes the cloud exactly this device', () async {
      final (a, b) = await syncedPair();
      await a.addTask('t2', 'from a', 'b1');
      await a.sync.push();
      await b.db.write((tx) => tx.patch(tasks, 't1', {'title': 'b wins'}));
      await b.sync.overwriteRemoteWithLocal();
      await a.sync.pull();
      expect(await a.task('t2'), isNull);
      expect((await a.task('t1'))!['title'], 'b wins');
      expect(await a.state(), await b.state());
    });

    test('discardLocalAndPull backs up and takes the cloud', () async {
      final (a, b) = await syncedPair();
      await a.db.write((tx) => tx.patch(tasks, 't1', {'title': 'cloud'}));
      await a.sync.push();
      await b.db.write((tx) => tx.patch(tasks, 't1', {'title': 'local'}));
      await b.sync.discardLocalAndPull();
      expect((await b.task('t1'))!['title'], 'cloud');
      expect(await b.sync.localBackups(), hasLength(1));
      expect(b.sync.status.hasLocalChanges, isFalse);
    });
  });

  group('accounts', () {
    test('data created signed out is published on first sign-in', () async {
      final a = await device('a', account: null);
      await a.addBoard('b1', 'before signing up');
      expect(a.sync.status.relation, SyncRelation.signedOut);
      a.accounts.signIn('alice');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      await a.sync.push();
      final b = await device('b');
      await b.sync.pull();
      expect(await b.board('b1'), isNotNull);
    });

    test('a different account requires an explicit switch', () async {
      final a = await device('a');
      await a.addBoard('b1', 'alice data');
      await a.sync.push();
      a.accounts.signIn('bob');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(a.sync.status.relation, SyncRelation.accountMismatch);
      await expectLater(a.sync.push(), throwsA(isA<SyncUnavailableException>()));

      await a.sync.switchAccount();
      expect(await a.board('b1'), isNull);
      expect(await a.sync.localBackups(), hasLength(1));
      await a.sync.checkRemote();
      expect(a.sync.status.relation, SyncRelation.remoteEmpty);
    });
  });

  group('schema evolution', () {
    test('a breaking change fences off older builds', () async {
      final newer = await device('newer', schema: testSchema(version: 2, compatibleSince: 2));
      await newer.addBoard('b1', 'Home');
      await newer.sync.push();

      final older = await device('older');
      await older.sync.checkRemote();
      expect(older.sync.status.relation, SyncRelation.remoteSchemaTooNew);
      await older.sync.pull();
      expect(await older.board('b1'), isNull);
    });

    test('an additive change does not, and older builds keep new data', () async {
      final tags = Collection.json('tags');
      final newerSchema = Schema(
        version: 2,
        compatibleSince: 1,
        collections: [boards, tasks, notes, prefs, tags],
      );
      final newer = await device('newer', schema: newerSchema);
      await newer.addBoard('b1', 'Home');
      await newer.db.write((tx) async {
        await tx.put(tags, {'id': 'g1', 'label': 'urgent'});
        await tx.put(boards, {'id': 'b1', 'name': 'Home', 'emoji': '🏠'});
      });
      await newer.sync.push();

      final older = await device('older');
      await older.sync.pull();
      expect(older.sync.status.relation, SyncRelation.upToDate);
      await older.db.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'Renamed by old'}));
      await older.sync.push();

      await newer.sync.pull();
      expect(await newer.db.get(tags, 'g1'), isNotNull);
      expect(await newer.board('b1'), {'id': 'b1', 'name': 'Renamed by old', 'emoji': '🏠'});
      expect(await newer.state(), await older.state());
    });
  });
}
