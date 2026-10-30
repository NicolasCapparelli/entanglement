import 'package:entanglement/entanglement.dart';
import 'package:test/test.dart';

import 'support.dart';

void main() {
  late InMemoryServer server;
  final devices = <Device>[];

  Future<Device> local(String name) async {
    final d = await Device.create(server, name: name, localOnly: true);
    devices.add(d);
    return d;
  }

  Future<Device> synced(String name) async {
    final d = await Device.create(server, name: name);
    devices.add(d);
    return d;
  }

  setUp(() => server = InMemoryServer());
  tearDown(() async {
    for (final d in devices) {
      await d.close();
    }
    devices.clear();
  });

  group('attachSync', () {
    test('local history is published by the first push and reaches another device', () async {
      final a = await local('a');
      expect(a.db.sync, isNull);
      await a.addBoard('b1', 'Home');
      await a.addTask('t1', 'Milk', 'b1');
      final engine = await a.attach(server);
      expect(a.db.sync, same(engine));
      await engine.push();
      expect(server.headOf('alice')?.revision, 1);
      final b = await synced('b');
      await b.sync.pull();
      expect((await b.task('t1'))?['title'], 'Milk');
      expect(await b.state(), await a.state());
    });

    test('refuses by default when the remote has other history', () async {
      final other = await synced('other');
      await other.addBoard('r1', 'Remote');
      await other.sync.push();
      final a = await local('a');
      await a.addBoard('l1', 'Local');
      await expectLater(a.attach(server), throwsA(isA<SyncRemoteHasHistoryException>()));
      expect(a.db.sync, isNull);
      expect(await a.board('l1'), isNotNull);
      expect(await a.board('r1'), isNull);
    });

    test('a device with nothing unsynced just pulls', () async {
      final other = await synced('other');
      await other.addBoard('r1', 'Remote');
      await other.sync.push();
      final a = await local('a');
      await a.attach(server);
      await a.sync.sync();
      expect(await a.board('r1'), isNotNull);
    });

    test('merge combines both sides', () async {
      final other = await synced('other');
      await other.addBoard('r1', 'Remote');
      await other.sync.push();
      final a = await local('a');
      await a.addBoard('l1', 'Local');
      await a.attach(server, ifRemoteHasHistory: RemoteHistoryChoice.merge);
      await a.sync.sync();
      expect(await a.board('r1'), isNotNull);
      expect(await a.board('l1'), isNotNull);
      await other.sync.pull();
      expect(await other.board('l1'), isNotNull);
    });

    test('useRemote discards local data (backed up)', () async {
      final other = await synced('other');
      await other.addBoard('r1', 'Remote');
      await other.sync.push();
      final a = await local('a');
      await a.addBoard('l1', 'Local');
      await a.attach(server, ifRemoteHasHistory: RemoteHistoryChoice.useRemote);
      expect(await a.board('l1'), isNull);
      expect(await a.board('r1'), isNotNull);
      expect((await a.sync.localBackups()).length, 1);
    });

    test('useLocal overwrites the remote', () async {
      final other = await synced('other');
      await other.addBoard('r1', 'Remote');
      await other.sync.push();
      final a = await local('a');
      await a.addBoard('l1', 'Local');
      await a.attach(server, ifRemoteHasHistory: RemoteHistoryChoice.useLocal);
      await other.sync.pull();
      expect(await other.board('l1'), isNotNull);
      expect(await other.board('r1'), isNull);
    });

    test('detach keeps local data; reattach continues', () async {
      final a = await local('a');
      await a.addBoard('b1', 'One');
      await a.attach(server);
      await a.sync.push();
      await a.db.detachSync();
      expect(a.db.sync, isNull);
      await a.addBoard('b2', 'Two');
      await a.attach(server);
      await a.sync.push();
      expect(server.headOf('alice')?.revision, 2);
      await expectLater(a.attach(server), throwsStateError);
    });
  });
}
