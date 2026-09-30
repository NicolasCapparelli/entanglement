import 'canonical.dart';
import 'query.dart';
import 'schema.dart';
import 'store.dart';

/// The application's handle inside `db.write` (spec §7.1).
///
/// Everything written through one [Tx] is one SQLite transaction and one
/// coupling group: published together, merged or conflicted together. Do not
/// await anything but [Tx] calls inside the callback.
class Tx {
  Tx(this._txn);

  final StoreTxn _txn;

  Future<T?> get<T>(Collection<T> collection, String id) async {
    final json = await _txn.getJson(docKey(collection.name, id));
    return json == null ? null : collection.decode(json);
  }

  /// A query that sees this transaction's own writes.
  Query<T> query<T>(Collection<T> collection) =>
      Query.inTransaction(_txn, collection);

  /// Inserts or replaces [value]. Top-level keys the stored document has but
  /// this build does not declare in `fields` are carried over (spec §5.5).
  Future<void> put<T>(Collection<T> collection, T value) => _putAt(
    collection,
    docKey(collection.name, collection.idOf(value)),
    collection.encode(value),
  );

  /// Untyped variant of [put].
  Future<void> putJson(CollectionDef collection, String id, Json document) =>
      _putAt(collection, docKey(collection.name, id), document);

  /// Merges [changes] into the stored document's top-level keys. The document
  /// must exist.
  Future<void> patch<T>(
    Collection<T> collection,
    String id,
    Json changes,
  ) async {
    final key = docKey(collection.name, id);
    final current = await _txn.getJson(key);
    if (current == null) {
      throw StateError('Cannot patch missing ${collection.name}/$id.');
    }
    await _putAt(collection, key, {...current, ...changes});
  }

  Future<void> delete<T>(Collection<T> collection, String id) =>
      _txn.put(docKey(collection.name, id), null);

  Future<void> _putAt(CollectionDef collection, DocKey key, Json document) async {
    final known = collection.fields;
    var next = document;
    if (known != null) {
      final stored = await _txn.getJson(key);
      if (stored != null) {
        next = {
          for (final entry in stored.entries)
            if (!known.contains(entry.key)) entry.key: entry.value,
          ...document,
        };
      }
    }
    await _txn.put(key, canonicalJson(next));
  }
}
