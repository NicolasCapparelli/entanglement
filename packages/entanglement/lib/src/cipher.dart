import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'canonical.dart';
import 'protocol.dart';

/// Thrown when data cannot be decrypted: unknown key, tampering, or plaintext
/// where ciphertext is required.
class CipherException implements Exception {
  const CipherException(this.message);

  final String message;

  @override
  String toString() => 'CipherException: $message';
}

/// Client-side encryption of everything a backend stores (spec/cipher.md).
///
/// Token: `e1.<keyId>.<base64url(nonce24 ‖ ciphertext ‖ tag16)>`,
/// XChaCha20-Poly1305 with the context string as associated data.
abstract interface class Cipher {
  Future<String> seal(String plaintext, String context);

  Future<String> open(String token, String context);
}

final _keyId = RegExp(r'^[A-Za-z0-9_-]{1,32}$');
final _base64Url = RegExp(r'^[A-Za-z0-9_-]*$');
const _prefix = 'e1';
const _nonceLength = 24;
const _tagLength = 16;
const _keyLength = 32;

class KeyCipher implements Cipher {
  /// [keys] is every key this device can decrypt with, by ID (32 bytes each);
  /// [activeKeyId] is the one used to encrypt. [nonce] is a test hook.
  KeyCipher({
    required Map<String, List<int>> keys,
    required this.activeKeyId,
    List<int> Function()? nonce,
  }) : _keys = {
         for (final entry in keys.entries) entry.key: SecretKey(entry.value),
       },
       _nonce = nonce {
    for (final entry in keys.entries) {
      if (!_keyId.hasMatch(entry.key)) {
        throw CipherException('Invalid key ID "${entry.key}".');
      }
      if (entry.value.length != _keyLength) {
        throw CipherException('Key "${entry.key}" must be $_keyLength bytes.');
      }
    }
    if (!_keys.containsKey(activeKeyId)) {
      throw const CipherException('The active key is not among the keys.');
    }
  }

  final String activeKeyId;
  final Map<String, SecretKey> _keys;
  final List<int> Function()? _nonce;
  final _algorithm = Xchacha20.poly1305Aead();

  @override
  Future<String> seal(String plaintext, String context) async {
    final nonce = _nonce?.call() ?? _algorithm.newNonce();
    final box = await _algorithm.encrypt(
      utf8.encode(plaintext),
      secretKey: _keys[activeKeyId]!,
      nonce: nonce,
      aad: _aad(context),
    );
    final bytes = Uint8List.fromList([
      ...nonce,
      ...box.cipherText,
      ...box.mac.bytes,
    ]);
    return '$_prefix.$activeKeyId.${base64Url.encode(bytes).replaceAll('=', '')}';
  }

  @override
  Future<String> open(String token, String context) async {
    final parts = token.split('.');
    if (parts.length != 3 || parts[0] != _prefix) {
      throw const CipherException('Not an encrypted value.');
    }
    final key = _keys[parts[1]];
    if (key == null) {
      throw CipherException('No key "${parts[1]}" to decrypt with.');
    }
    if (!_base64Url.hasMatch(parts[2])) {
      throw const CipherException('Malformed encrypted value.');
    }
    final Uint8List bytes;
    try {
      bytes = base64Url.decode(base64Url.normalize(parts[2]));
    } on FormatException {
      throw const CipherException('Malformed encrypted value.');
    }
    if (bytes.length < _nonceLength + _tagLength) {
      throw const CipherException('Malformed encrypted value.');
    }
    try {
      final plain = await _algorithm.decrypt(
        SecretBox(
          bytes.sublist(_nonceLength, bytes.length - _tagLength),
          nonce: bytes.sublist(0, _nonceLength),
          mac: Mac(bytes.sublist(bytes.length - _tagLength)),
        ),
        secretKey: key,
        aad: _aad(context),
      );
      return utf8.decode(plain);
    } on SecretBoxAuthenticationError {
      throw const CipherException('Decryption failed: wrong key or altered data.');
    } on FormatException {
      throw const CipherException('Decryption failed: wrong key or altered data.');
    }
  }
}

List<int> _aad(String context) => utf8.encode('entanglement/e1|$context');

/// Contexts bound into each ciphertext, so a server cannot swap them between
/// slots.
abstract final class CipherContext {
  static String value(String collection, String id) =>
      'value|$collection|$id';
  static String message(String commitId) => 'message|$commitId';
  static String deviceLabel(String commitId) => 'deviceLabel|$commitId';
  static String restoreLabel(int revision, String kind) =>
      'restoreLabel|$revision|$kind';
  static String restoreDevice(int revision, String kind) =>
      'restoreDevice|$revision|$kind';
}

/// A document value on the wire: the canonical JSON `{"$enc":"<token>"}`.
Future<String> sealValue(
  Cipher cipher,
  String collection,
  String id,
  String value,
) async => canonicalJson({
  r'$enc': await cipher.seal(value, CipherContext.value(collection, id)),
});

Future<String> openValue(
  Cipher cipher,
  String collection,
  String id,
  String wire,
) async {
  final parsed = jsonDecode(wire);
  final token = parsed is Map<String, Object?> && parsed.length == 1
      ? parsed[r'$enc']
      : null;
  if (token is! String) {
    throw CipherException('Document $collection/$id is not encrypted.');
  }
  return canonicalJson(
    jsonDecode(await cipher.open(token, CipherContext.value(collection, id))),
  );
}

/// Wraps a backend so it only ever sees ciphertext. State digests pass
/// through untouched: the engine computes them over plaintext.
class EncryptedBackend implements SyncBackend {
  EncryptedBackend(this._inner, this._cipher);

  final SyncBackend _inner;
  final Cipher _cipher;

  @override
  Future<Head?> head() => _inner.head();

  @override
  Future<List<Commit>> commits({
    required int after,
    required int upTo,
    int limit = 200,
  }) async {
    final commits = await _inner.commits(after: after, upTo: upTo, limit: limit);
    return [
      for (final commit in commits)
        Commit(
          revision: commit.revision,
          request: await _openRequest(commit.request),
          committedAt: commit.committedAt,
        ),
    ];
  }

  @override
  Future<SubmitResult> submit(CommitRequest request) async {
    final id = request.commitId;
    return _inner.submit(
      CommitRequest(
        commitId: id,
        parent: request.parent,
        schemaVersion: request.schemaVersion,
        compatibleSince: request.compatibleSince,
        deviceId: request.deviceId,
        deviceLabel: request.deviceLabel == null
            ? null
            : await _cipher.seal(request.deviceLabel!, CipherContext.deviceLabel(id)),
        clientTime: request.clientTime,
        message: request.message == null
            ? null
            : await _cipher.seal(request.message!, CipherContext.message(id)),
        stateDigest: request.stateDigest,
        changes: await _sealChanges(request.changes),
      ),
    );
  }

  @override
  Future<Checkpoint?> checkpoint({required int atOrBefore}) async {
    final checkpoint = await _inner.checkpoint(atOrBefore: atOrBefore);
    if (checkpoint == null) return null;
    return Checkpoint(
      revision: checkpoint.revision,
      schemaVersion: checkpoint.schemaVersion,
      stateDigest: checkpoint.stateDigest,
      entities: await _openChanges(checkpoint.entities),
      createdAt: checkpoint.createdAt,
    );
  }

  @override
  Future<void> putCheckpoint(Checkpoint checkpoint) async =>
      _inner.putCheckpoint(
        Checkpoint(
          revision: checkpoint.revision,
          schemaVersion: checkpoint.schemaVersion,
          stateDigest: checkpoint.stateDigest,
          entities: await _sealChanges(checkpoint.entities),
          createdAt: checkpoint.createdAt,
        ),
      );

  @override
  Future<List<RestorePoint>> restorePoints() async {
    final points = await _inner.restorePoints();
    return [
      for (final point in points)
        RestorePoint(
          revision: point.revision,
          kind: point.kind,
          label: point.label == null
              ? null
              : await _cipher.open(
                  point.label!,
                  CipherContext.restoreLabel(point.revision, point.kind.name),
                ),
          pinned: point.pinned,
          deviceLabel: point.deviceLabel == null
              ? null
              : await _cipher.open(
                  point.deviceLabel!,
                  CipherContext.restoreDevice(point.revision, point.kind.name),
                ),
          createdAt: point.createdAt,
        ),
    ];
  }

  @override
  Future<void> putRestorePoint(RestorePoint point) async =>
      _inner.putRestorePoint(
        RestorePoint(
          revision: point.revision,
          kind: point.kind,
          label: point.label == null
              ? null
              : await _cipher.seal(
                  point.label!,
                  CipherContext.restoreLabel(point.revision, point.kind.name),
                ),
          pinned: point.pinned,
          deviceLabel: point.deviceLabel == null
              ? null
              : await _cipher.seal(
                  point.deviceLabel!,
                  CipherContext.restoreDevice(point.revision, point.kind.name),
                ),
          createdAt: point.createdAt,
        ),
      );

  @override
  Future<void> deleteRestorePoints(List<RestorePointKey> keys) =>
      _inner.deleteRestorePoints(keys);

  @override
  Future<void> compact({required int anchor}) => _inner.compact(anchor: anchor);

  @override
  Stream<void>? get hints => _inner.hints;

  Future<CommitRequest> _openRequest(CommitRequest request) async {
    final id = request.commitId;
    return CommitRequest(
      commitId: id,
      parent: request.parent,
      schemaVersion: request.schemaVersion,
      compatibleSince: request.compatibleSince,
      deviceId: request.deviceId,
      deviceLabel: request.deviceLabel == null
          ? null
          : await _cipher.open(request.deviceLabel!, CipherContext.deviceLabel(id)),
      clientTime: request.clientTime,
      message: request.message == null
          ? null
          : await _cipher.open(request.message!, CipherContext.message(id)),
      stateDigest: request.stateDigest,
      changes: await _openChanges(request.changes),
    );
  }

  Future<List<Change>> _sealChanges(List<Change> changes) async => [
    for (final c in changes)
      Change(
        collection: c.collection,
        id: c.id,
        group: c.group,
        value: c.value == null
            ? null
            : await sealValue(_cipher, c.collection, c.id, c.value!),
      ),
  ];

  Future<List<Change>> _openChanges(List<Change> changes) async => [
    for (final c in changes)
      Change(
        collection: c.collection,
        id: c.id,
        group: c.group,
        value: c.value == null
            ? null
            : await openValue(_cipher, c.collection, c.id, c.value!),
      ),
  ];
}
