import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'canonical.dart';

final BigInt _modulus = BigInt.one << 256;

/// SHA-256 of `JCS([collection, id, value])`, read as an unsigned 256-bit
/// big-endian integer. [canonicalValue] must already be canonical JSON; a null
/// value means "absent" and contributes nothing.
BigInt entityHash(String collection, String id, String? canonicalValue) {
  if (canonicalValue == null) return BigInt.zero;
  final text =
      '[${canonicalJson(collection)},${canonicalJson(id)},$canonicalValue]';
  final bytes = sha256.convert(utf8.encode(text)).bytes;
  var result = BigInt.zero;
  for (final byte in bytes) {
    result = (result << 8) | BigInt.from(byte);
  }
  return result;
}

/// Additive multiset digest of a whole synced state (spec §9.6).
///
/// The sum of every live document's [entityHash], mod 2^256. Being additive, it
/// updates in O(changes) as documents change, which is what lets every commit
/// and checkpoint carry the digest of the state it produces. It detects
/// divergence and corruption; it is not a security mechanism.
class StateDigest {
  const StateDigest._(this.value);

  static final StateDigest empty = StateDigest._(BigInt.zero);

  factory StateDigest.parse(String hex) {
    if (hex.length != 64) {
      throw FormatException('A state digest is 64 hex characters: $hex');
    }
    return StateDigest._(BigInt.parse(hex, radix: 16));
  }

  /// Digest of a complete state given as `collection -> id -> canonical value`.
  factory StateDigest.of(Iterable<(String, String, String)> documents) {
    var digest = StateDigest.empty;
    for (final (collection, id, value) in documents) {
      digest = digest.replace(collection, id, null, value);
    }
    return digest;
  }

  final BigInt value;

  /// Applies one document change: removes [before], adds [after].
  StateDigest replace(
    String collection,
    String id,
    String? before,
    String? after,
  ) {
    if (before == after) return this;
    final next =
        (value -
            entityHash(collection, id, before) +
            entityHash(collection, id, after)) %
        _modulus;
    return StateDigest._(next);
  }

  String get hex => value.toRadixString(16).padLeft(64, '0');

  @override
  bool operator ==(Object other) =>
      other is StateDigest && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => hex;
}
