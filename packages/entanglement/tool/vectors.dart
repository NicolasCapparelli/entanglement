// Language-neutral conformance vectors (design spec §22.1).
//
// Inputs are written as JSON *text* so every implementation parses them with
// its own JSON parser — the same thing it will do with real data.
//
// Regenerate after an intentional behaviour change:
//   dart run tool/vectors.dart
// test/vectors_test.dart fails if the files and the implementation disagree.
import 'dart:convert';
import 'dart:io';

import 'package:entanglement/entanglement.dart';

const vectorsDir = '../../spec/vectors';

const canonicalInputs = [
  '{"b":1,"a":{"d":true,"c":null},"list":[3,1]}',
  '1.0', '-0.0', '1.5', '0.001', '0.000001', '1e-7', '1e20', '1e21', '1.23e22',
  '123456789.125', '-2.5e-10', '5e-324', '1.7976931348623157e308', '9007199254740991',
  r'"a\"b\\c\n\t\u0001é€😀"', r'"\u2028\u2029"', r'"\ud800x"',
  '{"é":1,"z":2,"😀":3,"Z":4}',
  '[{"y":[],"x":{}},true,false,null,""]',
];

const digestStates = [
  <List<String>>[],
  [['tasks', 'a', '{"t":1}']],
  [['tasks', 'a', '{"t":1}'], ['tasks', 'b', '{"t":2}'], ['boards', 'x', '{"n":"x"}']],
  [['notes', 'unicode é', '{"text":"😀"}']],
];

/// base, local, remote (JSON text or null = absent), policy.
const decideCases = [
  [null, null, null, 'whole'],
  ['{"a":1}', '{"a":1}', '{"a":2}', 'whole'],
  ['{"a":1}', '{"a":2}', '{"a":1}', 'whole'],
  ['{"a":1}', '{"a":2}', '{"a":2}', 'whole'],
  ['{"a":1}', '{"a":2}', '{"a":3}', 'whole'],
  ['{"a":1}', null, '{"a":3}', 'whole'],
  ['{"a":1}', '{"a":3}', null, 'fieldwise'],
  ['{"a":1}', null, null, 'whole'],
  [null, '{"a":1}', '{"a":2}', 'whole'],
  [null, '{"a":1,"b":1}', '{"a":1,"c":2}', 'fieldwise'],
  ['{"a":1,"b":1}', '{"a":2,"b":1}', '{"a":1,"b":2}', 'fieldwise'],
  ['{"a":1,"b":1}', '{"a":2,"b":1}', '{"a":3,"b":2}', 'fieldwise'],
  ['{"a":1,"b":1}', '{"b":1}', '{"a":1,"b":2}', 'fieldwise'],
  ['{"a":1,"b":1,"c":1}', '{"a":2,"b":1,"c":1}', '{"a":1,"b":2,"c":1}', 'fieldwise:a+b'],
  ['{"a":1,"b":1,"c":1}', '{"a":2,"b":1,"c":1}', '{"a":1,"b":1,"c":2}', 'fieldwise:a+b'],
  ['{"n":1.0}', '{"n":1}', '{"n":2}', 'whole'],
];

MergePolicy policyFor(String name) => switch (name) {
  'whole' => MergePolicy.wholeDocument,
  'fieldwise' => const MergePolicy.fieldwise(),
  'fieldwise:a+b' => const MergePolicy.fieldwise(groups: [{'a', 'b'}]),
  _ => throw ArgumentError(name),
};

Map<String, Object?> policyJson(String name) => switch (name) {
  'whole' => {'kind': 'wholeDocument'},
  'fieldwise' => {'kind': 'fieldwise', 'groups': <Object?>[]},
  'fieldwise:a+b' => {'kind': 'fieldwise', 'groups': [['a', 'b']]},
  _ => throw ArgumentError(name),
};

String? canon(String? text) => text == null ? null : canonicalJson(jsonDecode(text));

Map<String, Object?> decisionJson(Decision decision, String? local, String? remote) => switch (decision) {
  TakeLocal() => {'take': 'local', 'value': local == null ? null : jsonDecode(local)},
  TakeRemote() => {'take': 'remote', 'value': remote == null ? null : jsonDecode(remote)},
  TakeMerged(:final value) => {'take': 'merged', 'value': value == null ? null : jsonDecode(value)},
  ConflictDecision(:final reason, :final fields) => {'take': 'conflict', 'reason': reason.name, 'fields': fields},
};

/// A scripted commit sequence as it travels on the wire, and the state and
/// digest every implementation must reach by folding it (spec §9.6, §18.3).
Map<String, Object?> wireVector() {
  final state = <DocKey, String>{};
  var digest = StateDigest.empty;
  final commits = <Map<String, Object?>>[];

  void commit(int parent, List<(String, String, Object?)> writes, {String? message}) {
    final changes = <Change>[];
    for (var index = 0; index < writes.length; index++) {
      final (collection, id, value) = writes[index];
      final canonical = value == null ? null : canonicalJson(value);
      final key = docKey(collection, id);
      digest = digest.replace(collection, id, state[key], canonical);
      if (canonical == null) {
        state.remove(key);
      } else {
        state[key] = canonical;
      }
      changes.add(Change(collection: collection, id: id, value: canonical, group: index % 2));
    }
    commits.add(
      CommitRequest(
        commitId: '0192b5e4-7c1a-7d3e-9f10-00000000000$parent',
        parent: parent,
        schemaVersion: 1,
        compatibleSince: 1,
        deviceId: 'vector-device',
        deviceLabel: 'Vectors',
        clientTime: 1759140000000 + parent,
        message: message,
        stateDigest: digest,
        changes: changes,
      ).toJson(),
    );
  }

  commit(0, [
    ('boards', 'b1', {'id': 'b1', 'name': 'Home', 'position': 0}),
    ('tasks', 't1', {'id': 't1', 'title': 'Milk ü', 'boardId': 'b1', 'done': false, 'weight': 1.5}),
    ('tasks', 't2', {'id': 't2', 'title': 'Bread', 'boardId': 'b1', 'done': false, 'weight': 2.0}),
  ], message: 'first');
  commit(1, [
    ('tasks', 't1', {'id': 't1', 'title': 'Oat milk 😀', 'boardId': 'b1', 'done': true, 'weight': 1e-7}),
    ('tasks', 't2', null),
  ]);
  commit(2, [
    ('boards', 'b2', {'id': 'b2', 'name': 'Work', 'position': 1, 'nested': {'z': [1, 2], 'a': null}}),
    ('ent_sync_log', 'l1', {'id': 'l1', 'at': 1759140000000, 'discarded': <Object?>[]}),
  ]);

  final keys = state.keys.toList()
    ..sort((a, b) => a.collection == b.collection ? a.id.compareTo(b.id) : a.collection.compareTo(b.collection));
  return {
    'commits': commits,
    'finalState': [for (final key in keys) [key.collection, key.id, state[key]]],
    'finalDigest': digest.hex,
  };
}

Map<String, Object?> buildVectors() => {
  'canonical_json': [
    for (final input in canonicalInputs) {'input': input, 'canonical': canonicalJson(jsonDecode(input))},
  ],
  'digest': [
    for (final state in digestStates)
      {
        'documents': state,
        'entityHashes': [
          for (final doc in state)
            entityHash(doc[0], doc[1], canon(doc[2])).toRadixString(16).padLeft(64, '0'),
        ],
        'stateDigest': StateDigest.of([for (final doc in state) (doc[0], doc[1], canon(doc[2])!)]).hex,
      },
  ],
  'wire': wireVector(),
  'decide': [
    for (final c in decideCases)
      {
        'base': c[0],
        'local': c[1],
        'remote': c[2],
        'policy': policyJson(c[3]!),
        'expected': decisionJson(
          decide(base: canon(c[0]), local: canon(c[1]), remote: canon(c[2]), policy: policyFor(c[3]!)),
          canon(c[1]),
          canon(c[2]),
        ),
      },
  ],
};

void main() {
  const encoder = JsonEncoder.withIndent('  ');
  buildVectors().forEach((name, cases) {
    File('$vectorsDir/$name.json').writeAsStringSync('${encoder.convert(cases)}\n');
    stdout.writeln('wrote $vectorsDir/$name.json');
  });
}
