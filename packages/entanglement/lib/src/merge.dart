import 'canonical.dart';
import 'schema.dart';

/// Why a document could not be merged automatically.
enum ConflictReason { bothChanged, deleteVsEdit, fieldConflict, custom, integrity }

/// The outcome of the per-document three-way decision (spec §12.3).
sealed class Decision {
  const Decision();
}

class TakeLocal extends Decision {
  const TakeLocal();
}

class TakeRemote extends Decision {
  const TakeRemote();
}

/// A new value neither side had (a field-wise or custom merge). Null deletes.
class TakeMerged extends Decision {
  const TakeMerged(this.value);

  final String? value;
}

class ConflictDecision extends Decision {
  const ConflictDecision(this.reason, {this.fields = const []});

  final ConflictReason reason;

  /// For [ConflictReason.fieldConflict], the keys both sides changed
  /// differently.
  final List<String> fields;
}

/// Decides one document given its base, local and remote values as canonical
/// JSON (null = absent). Pure, and defined identically in every
/// implementation (spec §12.3, vectors/decide.json).
Decision decide({
  required String? base,
  required String? local,
  required String? remote,
  required MergePolicy policy,
}) {
  if (local == remote) return const TakeLocal();
  if (local == base) return const TakeRemote();
  if (remote == base) return const TakeLocal();
  if (local == null || remote == null) {
    return const ConflictDecision(ConflictReason.deleteVsEdit);
  }
  switch (policy) {
    case WholeDocumentMerge():
      return const ConflictDecision(ConflictReason.bothChanged);
    case FieldwiseMerge(:final groups):
      return _fieldwise(
        base == null ? const {} : decodeDocument(base),
        decodeDocument(local),
        decodeDocument(remote),
        groups,
      );
    case CustomMerge(:final merge):
      final outcome = merge(
        base == null ? null : decodeDocument(base),
        decodeDocument(local),
        decodeDocument(remote),
      );
      return switch (outcome) {
        Merged(:final value) => TakeMerged(
          value == null ? null : canonicalJson(value),
        ),
        Unmergeable() => const ConflictDecision(ConflictReason.custom),
      };
  }
}

Decision _fieldwise(Json base, Json local, Json remote, List<Set<String>> groups) {
  final keys = {...base.keys, ...local.keys, ...remote.keys};
  // Each key belongs to its declared group, or to a group of its own.
  final units = <List<String>>[];
  final grouped = <String>{};
  for (final group in groups) {
    final members = (group.where(keys.contains).toList()..sort());
    if (members.isNotEmpty) units.add(members);
    grouped.addAll(group);
  }
  for (final key in keys.toList()..sort()) {
    if (!grouped.contains(key)) units.add([key]);
  }

  String slice(Json doc, List<String> members) => canonicalJson({
    for (final key in members)
      if (doc.containsKey(key)) key: doc[key],
  });

  final result = <String, Object?>{};
  final conflicts = <String>[];
  for (final members in units) {
    final b = slice(base, members);
    final l = slice(local, members);
    final r = slice(remote, members);
    final Json source;
    if (l == r || r == b) {
      source = local;
    } else if (l == b) {
      source = remote;
    } else {
      conflicts.addAll(members);
      continue;
    }
    for (final key in members) {
      if (source.containsKey(key)) result[key] = source[key];
    }
  }
  if (conflicts.isNotEmpty) {
    return ConflictDecision(ConflictReason.fieldConflict, fields: conflicts);
  }
  return TakeMerged(canonicalJson(result));
}

/// Union-find over document keys, for building merge units (spec §12.4).
class UnionFind<K> {
  final Map<K, K> _parent = {};

  void add(K key) => _parent.putIfAbsent(key, () => key);

  K find(K key) {
    var root = key;
    while (_parent[root] != root) {
      root = _parent[root] as K;
    }
    // Path compression.
    var node = key;
    while (_parent[node] != root) {
      final next = _parent[node] as K;
      _parent[node] = root;
      node = next;
    }
    return root;
  }

  /// Returns true when two separate sets were joined.
  bool union(K a, K b) {
    final rootA = find(a);
    final rootB = find(b);
    if (rootA == rootB) return false;
    _parent[rootB] = rootA;
    return true;
  }

  void unionAll(Iterable<K> keys) {
    K? first;
    for (final key in keys) {
      if (first == null) {
        first = key;
      } else {
        union(first, key);
      }
    }
  }

  Map<K, List<K>> components() {
    final result = <K, List<K>>{};
    for (final key in _parent.keys) {
      (result[find(key)] ??= []).add(key);
    }
    return result;
  }
}
