import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

import '../tool/vectors.dart';

/// The committed vectors must match the implementation. If this fails after
/// an intentional change, regenerate with `dart run tool/vectors.dart` — and
/// know that every other implementation must change too.
void main() {
  buildVectors().forEach((name, expected) {
    test('$name.json matches the implementation', () {
      final file = File('$vectorsDir/$name.json');
      expect(file.existsSync(), isTrue, reason: 'run dart run tool/vectors.dart');
      expect(jsonDecode(file.readAsStringSync()), jsonDecode(jsonEncode(expected)));
    });
  });
}
