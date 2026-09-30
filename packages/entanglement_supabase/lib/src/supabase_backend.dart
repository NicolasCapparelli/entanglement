import 'dart:async';

import 'package:entanglement/entanglement.dart';
import 'package:supabase/supabase.dart';

/// [SyncBackend] over Supabase (design spec §19), using the tables and
/// functions in `supabase/migrations/0001_entanglement.sql`.
///
/// Reads go straight to the tables (row-level security limits them to the
/// signed-in user); every write is an RPC that enforces the protocol's
/// invariants server-side. The account always comes from the client's
/// session, never from a request.
class SupabaseSyncBackend implements SyncBackend {
  SupabaseSyncBackend(this._client);

  final SupabaseClient _client;

  String _userId() {
    final id = _client.auth.currentUser?.id;
    if (id == null) throw const AuthRequiredException('Not signed in.');
    return id;
  }

  @override
  Future<Head?> head() => _guard(() async {
    final row = await _client
        .from('ent_heads')
        .select()
        .eq('user_id', _userId())
        .maybeSingle();
    // A head at revision 0 exists only as a lock row for a first commit that
    // did not land; there is nothing in the account yet.
    if (row == null || _int(row['revision']) == 0) return null;
    return Head(
      revision: _int(row['revision']),
      schemaVersion: _int(row['schema_version']),
      minVersion: _int(row['min_version']),
      stateDigest: StateDigest.parse(row['state_digest']! as String),
      updatedAt: DateTime.parse(row['updated_at']! as String),
    );
  });

  @override
  Future<List<Commit>> commits({
    required int after,
    required int upTo,
    int limit = 200,
  }) => _guard(() async {
    final userId = _userId();
    final head = await _client
        .from('ent_heads')
        .select('compacted_through')
        .eq('user_id', userId)
        .maybeSingle();
    final compacted = head == null ? 0 : _int(head['compacted_through']);
    if (after < compacted) {
      throw HistoryUnavailableException(
        'Commits up to $compacted were compacted.',
      );
    }
    final rows = await _client
        .from('ent_commits')
        .select()
        .eq('user_id', userId)
        .gt('revision', after)
        .lte('revision', upTo)
        // postgrest-dart orders DESCENDING by default; the protocol needs
        // ascending revisions.
        .order('revision', ascending: true)
        .limit(limit);
    final commits = [for (final row in rows) _commitFrom(row)];
    // Compaction can run between the check above and this read.
    if (commits.isNotEmpty && commits.first.revision != after + 1) {
      throw const HistoryUnavailableException('Commit history has a gap.');
    }
    return commits;
  });

  @override
  Future<SubmitResult> submit(CommitRequest request) => _guard(() async {
    _userId();
    final rows = await _client.rpc<List<dynamic>>(
      'ent_submit',
      params: {'p_request': request.toJson()},
    );
    final row = (rows.first as Map).cast<String, Object?>();
    final status = row['out_status']! as String;
    final revision = row['out_revision'] == null
        ? null
        : _int(row['out_revision']);
    return switch (status) {
      'accepted' => SubmitAccepted(revision!),
      'conflict' => SubmitConflict(revision ?? 0),
      'rejected_schema_too_old' => const SubmitRejected(
        RejectReason.schemaTooOld,
      ),
      _ => const SubmitRejected(RejectReason.invalid),
    };
  });

  @override
  Future<Checkpoint?> checkpoint({required int atOrBefore}) =>
      _guard(() async {
        final row = await _client
            .from('ent_checkpoints')
            .select()
            .eq('user_id', _userId())
            .lte('revision', atOrBefore)
            .order('revision', ascending: false)
            .limit(1)
            .maybeSingle();
        if (row == null) return null;
        return Checkpoint(
          revision: _int(row['revision']),
          schemaVersion: _int(row['schema_version']),
          stateDigest: StateDigest.parse(row['state_digest']! as String),
          entities: [
            for (final entity in row['entities']! as List<dynamic>)
              Change.fromJson((entity as Map).cast<String, Object?>()),
          ],
          createdAt: DateTime.parse(row['created_at']! as String),
        );
      });

  @override
  Future<void> putCheckpoint(Checkpoint checkpoint) => _guard(() async {
    _userId();
    await _client.rpc<void>(
      'ent_put_checkpoint',
      params: {
        'p_checkpoint': {
          'revision': checkpoint.revision,
          'schemaVersion': checkpoint.schemaVersion,
          'stateDigest': checkpoint.stateDigest.hex,
          'entities': [
            for (final entity in checkpoint.entities) entity.toJson(),
          ],
        },
      },
    );
  });

  @override
  Future<List<RestorePoint>> restorePoints() => _guard(() async {
    final rows = await _client
        .from('ent_restore_points')
        .select()
        .eq('user_id', _userId())
        .order('revision', ascending: false);
    return [
      for (final row in rows)
        RestorePoint(
          revision: _int(row['revision']),
          kind: RestorePointKind.values.byName(row['kind']! as String),
          label: row['label'] as String?,
          pinned: row['pinned'] == true,
          deviceLabel: row['device_label'] as String?,
          createdAt: DateTime.parse(row['created_at']! as String),
        ),
    ];
  });

  @override
  Future<void> putRestorePoint(RestorePoint point) => _guard(() async {
    _userId();
    await _client.rpc<void>(
      'ent_put_restore_point',
      params: {
        'p_revision': point.revision,
        'p_kind': point.kind.name,
        'p_label': point.label,
        'p_pinned': point.pinned,
        'p_device_label': point.deviceLabel,
      },
    );
  });

  @override
  Future<void> deleteRestorePoints(List<RestorePointKey> keys) =>
      _guard(() async {
        if (keys.isEmpty) return;
        _userId();
        await _client.rpc<void>(
          'ent_delete_restore_points',
          params: {
            'p_keys': [
              for (final key in keys)
                {'revision': key.revision, 'kind': key.kind.name},
            ],
          },
        );
      });

  @override
  Future<void> compact({required int anchor}) => _guard(() async {
    _userId();
    await _client.rpc<void>('ent_compact', params: {'p_anchor': anchor});
  });

  /// Postgres Changes on `ent_heads` for the signed-in user. Opens the
  /// channel on first listen and closes it when the last listener leaves.
  @override
  Stream<void>? get hints {
    final userId = _client.auth.currentUser?.id;
    if (userId == null) return null;
    late StreamController<void> controller;
    RealtimeChannel? channel;
    controller = StreamController<void>.broadcast(
      onListen: () {
        // An RLS-protected table delivers nothing to an unauthenticated
        // socket, so hand it the current token explicitly.
        final token = _client.auth.currentSession?.accessToken;
        if (token != null) _client.realtime.setAuth(token);
        channel = _client
            .channel('ent_heads:$userId')
            .onPostgresChanges(
              event: PostgresChangeEvent.all,
              schema: 'public',
              table: 'ent_heads',
              filter: PostgresChangeFilter(
                type: PostgresChangeFilterType.eq,
                column: 'user_id',
                value: userId,
              ),
              callback: (_) => controller.add(null),
            )
            .subscribe();
      },
      onCancel: () async {
        final open = channel;
        channel = null;
        if (open != null) await _client.removeChannel(open);
      },
    );
    return controller.stream;
  }

  Commit _commitFrom(Map<String, dynamic> row) => Commit(
    revision: _int(row['revision']),
    committedAt: DateTime.parse(row['committed_at']! as String),
    request: CommitRequest(
      commitId: row['commit_id']! as String,
      parent: _int(row['parent']),
      schemaVersion: _int(row['schema_version']),
      compatibleSince: _int(row['compatible_since']),
      deviceId: row['device_id']! as String,
      deviceLabel: row['device_label'] as String?,
      clientTime: row['client_time'] == null ? null : _int(row['client_time']),
      message: row['message'] as String?,
      stateDigest: StateDigest.parse(row['state_digest']! as String),
      changes: [
        for (final change in row['changes']! as List<dynamic>)
          Change.fromJson((change as Map).cast<String, Object?>()),
      ],
    ),
  );

  static int _int(Object? value) => (value! as num).toInt();

  /// Translates vendor failures into the framework's error kinds
  /// (spec §18.2), so the core never sees a Supabase exception.
  Future<T> _guard<T>(Future<T> Function() body) async {
    try {
      return await body();
    } on BackendException {
      rethrow;
    } on AuthException catch (error) {
      throw AuthRequiredException(error.message);
    } on PostgrestException catch (error) {
      final code = error.code;
      if (code == '28000' || code == 'PGRST301' || code == 'PGRST302') {
        throw AuthRequiredException(error.message);
      }
      if (code != null && (code.startsWith('08') || code == '57P01')) {
        throw TransientBackendException(error.message);
      }
      throw FatalBackendException(error.message, code: code);
    } on TimeoutException catch (error) {
      throw TransientBackendException(error.message ?? 'Timed out.');
    } on Exception catch (error) {
      // Transport failures (SocketException, ClientException, …) differ by
      // platform and share no type — and dart:io would break web builds — so
      // anything else is treated as transient and retried.
      throw TransientBackendException('$error');
    }
  }
}

/// [AccountSource] over Supabase Auth.
class SupabaseAccountSource implements AccountSource {
  SupabaseAccountSource(this._client);

  final SupabaseClient _client;

  @override
  String? get currentAccount => _client.auth.currentUser?.id;

  @override
  Stream<String?> get accountChanges => _client.auth.onAuthStateChange
      .map((state) => state.session?.user.id)
      .distinct();
}
