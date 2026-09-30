import 'dart:async';
import 'dart:io';

import 'package:entanglement/entanglement.dart';
import 'package:entanglement/sqlite.dart';
import 'package:test/test.dart';

import 'support.dart';

Future<EntanglementDb> openLocal({Schema? schema, SqlExecutor? executor, SyncRole role = SyncRole.leader}) =>
    EntanglementDb.open(
      executor: executor ?? SqliteExecutor.memory(),
      schema: schema ?? testSchema(),
      role: role,
    );

Future<List<Map<String, Object?>>> pendingRows(EntanglementDb db) => db.store.read(
  (reader) async => [
    for (final row in await reader.allPending())
      {'key': '${row.key.collection}/${row.key.id}', 'before': row.before, 'grp': row.grp},
  ],
);

void main() {
  late EntanglementDb db;

  setUp(() async => db = await openLocal());
  tearDown(() => db.close());

  test('writes, reads and deletes documents', () async {
    await db.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'Home'}));
    expect(await db.get(boards, 'b1'), {'id': 'b1', 'name': 'Home'});
    await db.write((tx) => tx.delete(boards, 'b1'));
    expect(await db.get(boards, 'b1'), isNull);
  });

  group('pending overlay', () {
    test('repeated edits coalesce into one row keeping the original before', () async {
      await db.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'A'}));
      await db.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'B'}));
      await db.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'C'}));
      final rows = await pendingRows(db);
      expect(rows, hasLength(1));
      expect(rows.single['before'], isNull);
    });

    test('an exact undo leaves nothing pending', () async {
      await db.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'A'}));
      await db.write((tx) => tx.delete(boards, 'b1'));
      expect(await pendingRows(db), isEmpty);
    });

    test('documents written together share a group, transitively', () async {
      await db.write((tx) async {
        await tx.put(boards, {'id': 'b1', 'name': 'A'});
        await tx.put(boards, {'id': 'b2', 'name': 'B'});
      });
      await db.write((tx) => tx.put(boards, {'id': 'b3', 'name': 'C'}));
      var groups = {for (final row in await pendingRows(db)) row['key']: row['grp']};
      expect(groups['boards/b1'], groups['boards/b2']);
      expect(groups['boards/b3'], isNot(groups['boards/b1']));

      // Touching b2 and b3 together couples all three.
      await db.write((tx) async {
        await tx.put(boards, {'id': 'b2', 'name': 'B2'});
        await tx.put(boards, {'id': 'b3', 'name': 'C2'});
      });
      groups = {for (final row in await pendingRows(db)) row['key']: row['grp']};
      expect(groups.values.toSet(), hasLength(1));
    });

    test('local-only collections are never journaled', () async {
      await db.write((tx) => tx.put(prefs, {'id': 'layout', 'gap': 8}));
      expect(await pendingRows(db), isEmpty);
      expect(await db.get(prefs, 'layout'), {'id': 'layout', 'gap': 8});
    });
  });

  test('unknown top-level fields survive a write by this build', () async {
    // Simulate a field written by a newer build.
    await db.store.transact(
      (txn) => txn.put(docKey('boards', 'b1'), canonicalJson({'id': 'b1', 'name': 'A', 'icon': 'star'})),
    );
    await db.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'Renamed'}));
    expect(await db.get(boards, 'b1'), {'id': 'b1', 'name': 'Renamed', 'icon': 'star'});
  });

  group('integrity', () {
    test('a dangling reference rolls the transaction back', () async {
      await expectLater(
        db.write((tx) => tx.put(tasks, {'id': 't1', 'title': 'x', 'boardId': 'missing', 'done': false, 'order': 0})),
        throwsA(isA<IntegrityViolation>()),
      );
      expect(await db.get(tasks, 't1'), isNull);
      expect(await pendingRows(db), isEmpty);
    });

    test('deleting a referenced document requires the cascade in the same transaction', () async {
      await db.write((tx) async {
        await tx.put(boards, {'id': 'b1', 'name': 'A'});
        await tx.put(tasks, {'id': 't1', 'title': 'x', 'boardId': 'b1', 'done': false, 'order': 0});
      });
      await expectLater(db.write((tx) => tx.delete(boards, 'b1')), throwsA(isA<IntegrityViolation>()));
      expect(await db.get(boards, 'b1'), isNotNull);

      await db.write((tx) async {
        await tx.delete(tasks, 't1');
        await tx.delete(boards, 'b1');
      });
      expect(await db.get(boards, 'b1'), isNull);
    });

    test('references are checked within the transaction, not per statement', () async {
      await db.write((tx) async {
        await tx.put(tasks, {'id': 't1', 'title': 'x', 'boardId': 'b1', 'done': false, 'order': 0});
        await tx.put(boards, {'id': 'b1', 'name': 'created second'});
      });
      expect(await db.get(tasks, 't1'), isNotNull);
    });
  });

  test('re-entrant access fails fast instead of deadlocking', () async {
    await db.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'A'}));
    await expectLater(
      db.write((tx) => db.get(boards, 'b1')),
      throwsA(isA<StateError>()),
    );
    final inside = await db.write((tx) async {
      await tx.put(boards, {'id': 'b2', 'name': 'B'});
      return tx.query(boards).get();
    });
    expect(inside, hasLength(2));
  });

  group('queries', () {
    setUp(() async {
      await db.write((tx) async {
        await tx.put(boards, {'id': 'b1', 'name': 'A'});
        await tx.put(boards, {'id': 'b2', 'name': 'B'});
        await tx.put(tasks, {'id': 't1', 'title': 'one', 'boardId': 'b1', 'done': false, 'order': 2});
        await tx.put(tasks, {'id': 't2', 'title': 'two', 'boardId': 'b1', 'done': true, 'order': 1});
        await tx.put(tasks, {'id': 't3', 'title': 'three', 'boardId': 'b2', 'done': false, 'order': 0});
      });
    });

    test('filter and sort on indexed and unindexed fields', () async {
      final inB1 = await db.query(tasks).where('boardId', isEqualTo: 'b1').orderBy('order').get();
      expect(inB1.map((t) => t['id']), ['t2', 't1']);
      final open = await db.query(tasks).where('done', isEqualTo: false).orderBy('order', descending: true).get();
      expect(open.map((t) => t['id']), ['t1', 't3']);
      final some = await db.query(tasks).where('id', whereIn: ['t1', 't3']).limit(1).get();
      expect(some, hasLength(1));
    });

    test('watch emits the current result and every change, with origin', () async {
      final seen = <List<String>>[];
      final origins = <ChangeOrigin>[];
      final sub = db.query(tasks).where('boardId', isEqualTo: 'b2').watch().listen(
        (result) => seen.add([for (final t in result) t['id']! as String]),
      );
      final changeSub = db.changes.listen((event) => origins.add(event.origin));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await db.write((tx) => tx.put(tasks, {'id': 't4', 'title': 'four', 'boardId': 'b2', 'done': false, 'order': 5}));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await sub.cancel();
      await changeSub.cancel();
      expect(seen.first, ['t3']);
      expect(seen.last, ['t3', 't4']);
      expect(origins, [ChangeOrigin.local]);
    });
  });

  test('another connection’s writes are journaled and detected', () async {
    final dir = await Directory.systemTemp.createTemp('entanglement');
    final path = '${dir.path}/shared.db';
    final leader = await openLocal(executor: SqliteExecutor.open(path));
    final widget = await openLocal(executor: SqliteExecutor.open(path), role: SyncRole.passive);
    try {
      final events = <ChangeEvent>[];
      final sub = leader.changes.listen(events.add);
      await widget.write((tx) => tx.put(boards, {'id': 'w', 'name': 'from widget'}));
      expect(await leader.checkForExternalChanges(), isTrue);
      await Future<void>.delayed(Duration.zero);
      expect(events.single.origin, ChangeOrigin.external);
      expect(await pendingRows(leader), hasLength(1));
      expect(await leader.get(boards, 'w'), isNotNull);
      await sub.cancel();
    } finally {
      await leader.close();
      await widget.close();
      await dir.delete(recursive: true);
    }
  });

  test('local migrations transform documents and the base together', () async {
    final dir = await Directory.systemTemp.createTemp('entanglement');
    final path = '${dir.path}/migrate.db';
    try {
      final v1 = await openLocal(executor: SqliteExecutor.open(path));
      await v1.write((tx) => tx.put(boards, {'id': 'b1', 'name': 'old'}));
      await v1.close();

      final v2 = await openLocal(
        executor: SqliteExecutor.open(path),
        schema: testSchema(
          version: 2,
          migrations: {
            2: (collection, doc) => collection == 'boards' ? {...doc, 'name': (doc['name']! as String).toUpperCase()} : doc,
          },
        ),
      );
      expect(await v2.get(boards, 'b1'), {'id': 'b1', 'name': 'OLD'});
      await v2.close();

      await expectLater(
        openLocal(executor: SqliteExecutor.open(path)),
        throwsA(isA<LocalSchemaTooNew>()),
      );
    } finally {
      await dir.delete(recursive: true);
    }
  });
}
