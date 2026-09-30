import 'dart:convert';

/// Largest integer every implementation can represent exactly (2^53 − 1).
const int maxSafeInteger = 9007199254740991;

/// Thrown when a value cannot be represented in canonical JSON.
class CanonicalJsonException implements Exception {
  CanonicalJsonException(this.message);

  final String message;

  @override
  String toString() => 'CanonicalJsonException: $message';
}

/// Encodes [value] as RFC 8785 (JCS) canonical JSON.
///
/// Every equality check in the framework — dirty detection, coalescing,
/// three-way decisions, digests — compares these strings, so two logically
/// equal values must always encode to identical bytes, in every
/// implementation. In particular a Dart `1.0` encodes as `1`, exactly as
/// JavaScript would.
String canonicalJson(Object? value) {
  final out = StringBuffer();
  _write(out, value);
  return out.toString();
}

/// Decodes JSON text produced by [canonicalJson] (or any JSON).
Object? decodeJson(String text) => jsonDecode(text);

/// Decodes a canonical document string into a map.
Map<String, Object?> decodeDocument(String text) {
  final value = jsonDecode(text);
  if (value is! Map) {
    throw CanonicalJsonException('A document must be a JSON object.');
  }
  return value.cast<String, Object?>();
}

void _write(StringBuffer out, Object? value) {
  switch (value) {
    case null:
      out.write('null');
    case bool b:
      out.write(b ? 'true' : 'false');
    case int i:
      if (i > maxSafeInteger || i < -maxSafeInteger) {
        throw CanonicalJsonException('Integer $i is outside ±(2^53 − 1).');
      }
      out.write(i.toString());
    case double d:
      out.write(formatCanonicalNumber(d));
    case String s:
      _writeString(out, s);
    case List<Object?> list:
      out.write('[');
      for (var index = 0; index < list.length; index++) {
        if (index > 0) out.write(',');
        _write(out, list[index]);
      }
      out.write(']');
    case Map<Object?, Object?> map:
      final keys = <String>[];
      for (final key in map.keys) {
        if (key is! String) {
          throw CanonicalJsonException('Object keys must be strings: $key');
        }
        keys.add(key);
      }
      // String.compareTo compares UTF-16 code units, which is what JCS wants.
      keys.sort();
      out.write('{');
      for (var index = 0; index < keys.length; index++) {
        if (index > 0) out.write(',');
        _writeString(out, keys[index]);
        out.write(':');
        _write(out, map[keys[index]]);
      }
      out.write('}');
    default:
      throw CanonicalJsonException(
        'Unsupported value of type ${value.runtimeType}.',
      );
  }
}

void _writeString(StringBuffer out, String value) {
  out.write('"');
  final units = value.codeUnits;
  for (var index = 0; index < units.length; index++) {
    final unit = units[index];
    switch (unit) {
      case 0x22:
        out.write(r'\"');
      case 0x5C:
        out.write(r'\\');
      case 0x08:
        out.write(r'\b');
      case 0x0C:
        out.write(r'\f');
      case 0x0A:
        out.write(r'\n');
      case 0x0D:
        out.write(r'\r');
      case 0x09:
        out.write(r'\t');
      default:
        if (unit < 0x20) {
          out.write(r'\u');
          out.write(unit.toRadixString(16).padLeft(4, '0'));
        } else if (unit >= 0xD800 && unit <= 0xDBFF) {
          final next = index + 1 < units.length ? units[index + 1] : -1;
          if (next >= 0xDC00 && next <= 0xDFFF) {
            out.writeCharCode(unit);
            out.writeCharCode(next);
            index++;
          } else {
            _writeLoneSurrogate(out, unit);
          }
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
          _writeLoneSurrogate(out, unit);
        } else {
          out.writeCharCode(unit);
        }
    }
  }
  out.write('"');
}

/// Matches ECMAScript's well-formed JSON.stringify for unpaired surrogates.
void _writeLoneSurrogate(StringBuffer out, int unit) {
  out.write(r'\u');
  out.write(unit.toRadixString(16));
}

/// Formats a double exactly like ECMAScript's `Number.prototype.toString`.
///
/// Dart's `double.toString` already produces the shortest round-tripping
/// digits; only the layout differs (`1.0` vs `1`, `1e20` written out in full).
/// So the digits and exponent are extracted from Dart's output and re-laid out
/// using the ECMAScript rules (ECMA-262 Number::toString).
String formatCanonicalNumber(double value) {
  if (!value.isFinite) {
    throw CanonicalJsonException('Non-finite number $value.');
  }
  if (value == 0) return '0';
  final negative = value < 0;
  var text = value.abs().toString();

  var exponent = 0;
  final eIndex = text.indexOf('e');
  if (eIndex >= 0) {
    exponent = int.parse(text.substring(eIndex + 1));
    text = text.substring(0, eIndex);
  }
  final dot = text.indexOf('.');
  final integerPart = dot >= 0 ? text.substring(0, dot) : text;
  final fractionPart = dot >= 0 ? text.substring(dot + 1) : '';

  var digits = integerPart + fractionPart;
  // `n` is the position of the decimal point relative to the first digit:
  // value = 0.d1d2d3… × 10^n.
  var n = integerPart.length + exponent;
  var leading = 0;
  while (leading < digits.length - 1 && digits.codeUnitAt(leading) == 0x30) {
    leading++;
  }
  digits = digits.substring(leading);
  n -= leading;
  var end = digits.length;
  while (end > 1 && digits.codeUnitAt(end - 1) == 0x30) {
    end--;
  }
  digits = digits.substring(0, end);
  final k = digits.length;

  final String result;
  if (k <= n && n <= 21) {
    result = digits + '0' * (n - k);
  } else if (0 < n && n <= 21) {
    result = '${digits.substring(0, n)}.${digits.substring(n)}';
  } else if (-6 < n && n <= 0) {
    result = '0.${'0' * -n}$digits';
  } else {
    final e = n - 1;
    final mantissa = k > 1 ? '${digits[0]}.${digits.substring(1)}' : digits;
    result = '${mantissa}e${e >= 0 ? '+' : '-'}${e.abs()}';
  }
  return negative ? '-$result' : result;
}
