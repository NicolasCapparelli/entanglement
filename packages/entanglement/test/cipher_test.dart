import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:entanglement/entanglement.dart';
import 'package:test/test.dart';

import 'support.dart';

Uint8List unhex(String text) => Uint8List.fromList([
  for (var i = 0; i < text.length; i += 2)
    int.parse(text.substring(i, i + 2), radix: 16),
]);

String dump(InMemoryServer server) => jsonEncode(
  [
    for (final c in server.commitsOf('alice')) c.request.toJson(),
  ],
);

void main() {
  final vectors =
      jsonDecode(File('../../spec/vectors/cipher.json').readAsStringSync())
          as Map<String, Object?>;
  final keys = {
    for (final e in (vectors['keys']! as Map<String, Object?>).entries)
      e.key: unhex(e.value! as String),
  };
  KeyCipher cipherFor(String active, [String? nonce]) => KeyCipher(
    keys: keys,
    activeKeyId: active,
    nonce: nonce == null ? null : () => unhex(nonce),
  );
  List<Map<String, Object?>> list(String name) =>
      (vectors[name]! as List).cast<Map<String, Object?>>();

  group('cipher.json', () {
    for (final v in list('tokens')) {
      test(v['name']! as String, () async {
        final cipher = cipherFor(v['keyId']! as String, v['nonce']! as String);
        final context = v['context']! as String;
        expect(await cipher.seal(v['plaintext']! as String, context), v['token']);
        expect(await cipher.open(v['token']! as String, context), v['plaintext']);
      });
    }
    for (final v in list('values')) {
      test('value ${v['collection']}/${v['id']}', () async {
        final cipher = cipherFor(v['keyId']! as String, v['nonce']! as String);
        final collection = v['collection']! as String;
        final id = v['id']! as String;
        expect(
          await sealValue(cipher, collection, id, v['canonical']! as String),
          v['wire'],
        );
        expect(
          await openValue(cipher, collection, id, v['wire']! as String),
          v['canonical'],
        );
      });
    }
    for (final v in list('failures')) {
      test('rejects: ${v['name']}', () {
        expect(
          cipherFor('k1').open(v['token']! as String, v['context']! as String),
          throwsA(isA<CipherException>()),
        );
      });
    }
  });

  group('encrypted sync', () {
    final devices = <Device>[];
    tearDown(() async {
      for (final d in devices) {
        await d.close();
      }
      devices.clear();
    });
    Uint8List key(int n) => Uint8List(32)..fillRange(0, 32, n);
    Future<Device> make(InMemoryServer server, String name, KeyCipher c) async {
      final d = await Device.create(server, name: name, cipher: c);
      devices.add(d);
      return d;
    }

    test('the server holds only ciphertext and devices converge', () async {
      final server = InMemoryServer();
      final cipher = KeyCipher(keys: {'a': key(1)}, activeKeyId: 'a');
      final one = await make(server, 'one', cipher);
      final two = await make(server, 'two', cipher);
      await one.addBoard('b1', 'Secret board');
      await one.sync.push(message: 'Private message');
      await two.sync.pull();
      expect((await two.board('b1'))!['name'], 'Secret board');
      final stored = dump(server);
      expect(stored, isNot(contains('Secret board')));
      expect(stored, isNot(contains('Private message')));
      expect(stored, isNot(contains('"one"')));
      expect(stored, contains(r'$enc'));
    });

    test('key rotation keeps old data readable', () async {
      final server = InMemoryServer();
      final one = await make(
        server,
        'one',
        KeyCipher(keys: {'a': key(1)}, activeKeyId: 'a'),
      );
      await one.addBoard('b1', 'Home');
      await one.sync.push();
      final rotated = KeyCipher(keys: {'a': key(1), 'b': key(2)}, activeKeyId: 'b');
      final two = await make(server, 'two', rotated);
      await two.sync.pull();
      await two.addBoard('b2', 'Work');
      await two.sync.push();
      final text = dump(server);
      expect(text, contains('e1.a.'));
      expect(text, contains('e1.b.'));
      final three = await make(server, 'three', rotated);
      await three.sync.pull();
      expect((await three.board('b1'))!['name'], 'Home');
      expect((await three.board('b2'))!['name'], 'Work');
    });
  });
}
