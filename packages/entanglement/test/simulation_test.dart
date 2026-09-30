import 'dart:math';

import 'package:entanglement/entanglement.dart';
import 'package:test/test.dart';

import 'support.dart';

/// Seeded multi-device simulation (spec §23.3).
///
/// Devices make random edits (with references and cascades), sync at random,
/// and the server drops requests and responses at random. Once faults stop
/// and everyone syncs, every device must hold the identical state, with no
/// pending changes, no conflicts, and a clean commit history.
void main() {
  group('automatic policies', () {
    for (var seed = 1; seed <= 150; seed++) {
      test('seed $seed converges', () => simulate(seed));
    }
  });
  group('asking, with random resolutions, restores and overwrites', () {
    for (var seed = 1001; seed <= 1150; seed++) {
      test('seed $seed converges', () => simulate(seed, interactive: true));
    }
  });
}

Future<void> simulate(int seed, {bool interactive = false}) async {
  final random = Random(seed);
  final server = InMemoryServer();
  var faultRate = 0.15;
  server.faults = (op, {required after}) => random.nextDouble() < faultRate;

  final policies = [
    ConflictPolicy.preferRemote,
    ConflictPolicy.preferLocal,
    if (interactive) ...[ConflictPolicy.ask, ConflictPolicy.ask],
  ];
  final devices = <Device>[];
  for (var index = 0; index < 4; index++) {
    final device = await Device.create(
      server,
      name: 'd$index',
      options: SyncOptions(
        vcs: const VcsOptions(remoteCheckEvery: null),
        history: HistoryOptions(
          dailyRestorePoints: false,
          checkpointEvery: 3 + random.nextInt(6),
          keepRestorePoints: 1 + random.nextInt(3),
        ),
      ),
    );
    await device.sync.setConflictPolicy(policies[random.nextInt(policies.length)]);
    devices.add(device);
  }

  var counter = 0;
  String fresh(String prefix) => '$prefix${seed}_${counter++}';

  Future<void> randomEdit(Device device) async {
    final state = await device.state();
    final boardIds = [for (final key in state.keys) if (key.collection == 'boards') key.id];
    final taskIds = [for (final key in state.keys) if (key.collection == 'tasks') key.id];
    final noteIds = [for (final key in state.keys) if (key.collection == 'notes') key.id];
    T pick<T>(List<T> items) => items[random.nextInt(items.length)];

    switch (random.nextInt(9)) {
      case 0:
        await device.addBoard(fresh('b'), 'board $counter');
      case 1 when boardIds.isNotEmpty:
        await device.db.write((tx) => tx.patch(boards, pick(boardIds), {'name': 'renamed ${counter++}'}));
      case 2 when boardIds.isNotEmpty:
        final board = pick(boardIds);
        await device.db.write((tx) async {
          for (final task in await tx.query(tasks).where('boardId', isEqualTo: board).get()) {
            await tx.delete(tasks, task['id']! as String);
          }
          await tx.delete(boards, board);
        });
      case 3 || 4 when boardIds.isNotEmpty:
        await device.addTask(fresh('t'), 'task', pick(boardIds), order: random.nextInt(5));
      case 5 when taskIds.isNotEmpty:
        await device.db.write((tx) => tx.patch(tasks, pick(taskIds), {'title': 'edit ${counter++}'}));
      case 6 when taskIds.isNotEmpty:
        await device.db.write((tx) => tx.patch(tasks, pick(taskIds), {'done': random.nextBool()}));
      case 7 when taskIds.isNotEmpty && boardIds.length > 1:
        await device.db.write((tx) => tx.patch(tasks, pick(taskIds), {'boardId': pick(boardIds)}));
      case 8:
        if (noteIds.isNotEmpty && random.nextBool()) {
          await device.db.write((tx) => tx.delete(notes, pick(noteIds)));
        } else {
          await device.db.write((tx) => tx.put(notes, {'id': fresh('n'), 'text': 'note'}));
        }
      default:
        await device.addBoard(fresh('b'), 'board');
    }
  }

  var lastOp = '';

  Future<void> resolveAll(Device device) async {
    for (final unit in await device.sync.conflicts()) {
      await device.sync.resolve(
        unit.id,
        random.nextBool() ? Resolution.keepLocal : Resolution.keepRemote,
      );
    }
  }

  Future<void> randomSync(Device device) async {
    try {
      final roll = random.nextInt(interactive ? 20 : 3);
      lastOp = 'sync op $roll';
      switch (roll) {
        case 0:
          await device.sync.push();
        case 1:
          await device.sync.pull();
        case 2:
          await device.sync.sync();
        case 3 || 4 || 5:
          await resolveAll(device);
        case 6:
          final points = await device.sync.restorePoints();
          if (points.isNotEmpty) {
            await device.sync.restore(points[random.nextInt(points.length)]);
          }
        case 7:
          await device.sync.overwriteRemoteWithLocal();
        case 8:
          await device.sync.discardLocalAndPull();
        default:
          await device.sync.sync();
      }
    } on BackendException {
      // Injected faults; the next attempt must recover.
    } on IntegrityViolation {
      // A keepRemote/keepLocal that would break a reference is refused; the
      // unit stays held and another choice is made later.
    }
  }

  for (var step = 0; step < 250; step++) {
    final device = devices[random.nextInt(devices.length)];
    final edit = random.nextDouble() < 0.55;
    try {
      edit ? await randomEdit(device) : await randomSync(device);
    } catch (error) {
      fail('seed $seed step $step, ${device.name} ${edit ? 'edit' : lastOp}: $error');
    }
  }

  // Quiesce: no more faults or edits; everyone resolves and syncs until
  // nothing moves.
  faultRate = 0;
  for (var round = 0; round < 8; round++) {
    for (final device in devices) {
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          await resolveAll(device);
          break;
        } on IntegrityViolation {
          continue;
        }
      }
      try {
        await device.sync.sync();
      } catch (error) {
        fail('seed $seed quiesce round $round, ${device.name}: $error');
      }
    }
  }

  final reference = await devices.first.state();
  for (final device in devices) {
    expect(await device.state(), reference, reason: '${device.name} diverged (seed $seed)');
    expect(device.sync.status.hasLocalChanges, isFalse, reason: device.name);
    expect(device.sync.status.conflictCount, 0, reason: device.name);
    expect(device.sync.status.relation, SyncRelation.upToDate, reason: device.name);
  }

  // The head digest describes exactly the converged state.
  final head = server.headOf('alice')!;
  expect(
    StateDigest.of([for (final entry in reference.entries) (entry.key.collection, entry.key.id, entry.value)]),
    head.stateDigest,
  );
  // Every task points at an existing board.
  for (final entry in reference.entries.where((entry) => entry.key.collection == 'tasks')) {
    final boardId = decodeDocument(entry.value)['boardId'];
    expect(reference.containsKey(docKey('boards', boardId! as String)), isTrue);
  }
  // Commit ids are unique and revisions dense.
  final commits = server.commitsOf('alice');
  expect(commits.map((commit) => commit.request.commitId).toSet(), hasLength(commits.length));
  for (var index = 1; index < commits.length; index++) {
    expect(commits[index].revision, commits[index - 1].revision + 1);
  }

  for (final device in devices) {
    await device.close();
  }
}
