import 'package:entanglement/entanglement.dart';
import 'package:test/test.dart';

void main() {
  group('canonicalJson', () {
    test('sorts keys recursively and drops whitespace', () {
      expect(
        canonicalJson({
          'b': 1,
          'a': {'d': true, 'c': null},
          'list': [3, 1],
        }),
        '{"a":{"c":null,"d":true},"b":1,"list":[3,1]}',
      );
    });

    test('formats numbers like ECMAScript', () {
      final cases = <double, String>{
        1.0: '1',
        -0.0: '0',
        1.5: '1.5',
        0.001: '0.001',
        0.000001: '0.000001',
        1e-7: '1e-7',
        1e20: '100000000000000000000',
        1e21: '1e+21',
        1.23e22: '1.23e+22',
        123456789.125: '123456789.125',
        -2.5e-10: '-2.5e-10',
        5e-324: '5e-324',
        1.7976931348623157e308: '1.7976931348623157e+308',
      };
      cases.forEach((value, expected) {
        expect(canonicalJson(value), expected, reason: '$value');
      });
      expect(canonicalJson(42), '42');
    });

    test('an int and an integral double are the same value', () {
      expect(canonicalJson({'x': 1.0}), canonicalJson({'x': 1}));
    });

    test('escapes strings like JSON.stringify', () {
      expect(canonicalJson('a"b\\c\n\t\u0001é€😀'), r'"a\"b\\c\n\t\u0001é€😀"');
      expect(canonicalJson('\ud800x'), r'"\ud800x"');
    });

    test('sorts keys by UTF-16 code units', () {
      expect(canonicalJson({'é': 1, 'z': 2, '😀': 3, 'Z': 4}), '{"Z":4,"z":2,"é":1,"😀":3}');
    });

    test('rejects values with no canonical form', () {
      expect(() => canonicalJson(double.nan), throwsA(isA<CanonicalJsonException>()));
      expect(() => canonicalJson(1 << 60), throwsA(isA<CanonicalJsonException>()));
      expect(() => canonicalJson({1: 'x'}), throwsA(isA<CanonicalJsonException>()));
    });
  });

  group('StateDigest', () {
    test('is order-independent and updates incrementally', () {
      final docs = [
        ('tasks', 'a', '{"t":1}'),
        ('tasks', 'b', '{"t":2}'),
        ('boards', 'x', '{"n":"x"}'),
      ];
      final forward = StateDigest.of(docs);
      final backward = StateDigest.of(docs.reversed);
      expect(forward, backward);

      final edited = forward.replace('tasks', 'a', '{"t":1}', '{"t":9}');
      expect(
        edited,
        StateDigest.of([('tasks', 'a', '{"t":9}'), docs[1], docs[2]]),
      );
      final removed = edited.replace('tasks', 'a', '{"t":9}', null);
      expect(removed, StateDigest.of(docs.skip(1)));
      expect(StateDigest.of(const []), StateDigest.empty);
      expect(StateDigest.empty.hex, '0' * 64);
    });

    test('round-trips through hex', () {
      final digest = StateDigest.of([('c', 'i', '{}')]);
      expect(StateDigest.parse(digest.hex), digest);
    });
  });
}
