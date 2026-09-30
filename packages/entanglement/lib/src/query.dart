import 'dart:async';

import 'canonical.dart';
import 'schema.dart';
import 'store.dart';

const Object _unset = Object();

/// A query over one collection (spec §8.1). Reads are always local.
///
/// Any top-level field can be filtered or sorted on; declared indexes only
/// make it faster.
class Query<T> {
  /// A query over committed data, which can also be watched.
  Query(EntanglementStore store, this._collection)
    : _store = store,
      _reader = null;

  /// A query inside a transaction, seeing its uncommitted writes.
  Query.inTransaction(StoreReader reader, this._collection)
    : _store = null,
      _reader = reader;

  final EntanglementStore? _store;
  final StoreReader? _reader;
  final Collection<T> _collection;
  final List<String> _clauses = [];
  final List<Object?> _args = [];
  final List<String> _order = [];
  int? _limit;

  Query<T> where(
    String field, {
    Object? isEqualTo = _unset,
    Object? isNotEqualTo = _unset,
    Object? isLessThan = _unset,
    Object? isLessThanOrEqualTo = _unset,
    Object? isGreaterThan = _unset,
    Object? isGreaterThanOrEqualTo = _unset,
    List<Object?>? whereIn,
    bool? isNull,
  }) {
    final column = _column(field);
    void add(String op, Object? value) {
      _clauses.add('$column $op ?');
      _args.add(_bindable(value));
    }

    if (!identical(isEqualTo, _unset)) {
      isEqualTo == null ? _clauses.add('$column IS NULL') : add('=', isEqualTo);
    }
    if (!identical(isNotEqualTo, _unset)) {
      isNotEqualTo == null
          ? _clauses.add('$column IS NOT NULL')
          : add('!=', isNotEqualTo);
    }
    if (!identical(isLessThan, _unset)) add('<', isLessThan);
    if (!identical(isLessThanOrEqualTo, _unset)) add('<=', isLessThanOrEqualTo);
    if (!identical(isGreaterThan, _unset)) add('>', isGreaterThan);
    if (!identical(isGreaterThanOrEqualTo, _unset)) {
      add('>=', isGreaterThanOrEqualTo);
    }
    if (whereIn != null) {
      if (whereIn.isEmpty) {
        _clauses.add('0');
      } else {
        _clauses.add('$column IN (${List.filled(whereIn.length, '?').join(', ')})');
        _args.addAll(whereIn.map(_bindable));
      }
    }
    if (isNull != null) {
      _clauses.add(isNull ? '$column IS NULL' : '$column IS NOT NULL');
    }
    return this;
  }

  Query<T> orderBy(String field, {bool descending = false}) {
    _order.add('${_column(field)} ${descending ? 'DESC' : 'ASC'}');
    return this;
  }

  Query<T> limit(int count) {
    _limit = count;
    return this;
  }

  Future<List<T>> get() {
    final reader = _reader;
    return reader != null ? _load(reader) : _store!.read(_load);
  }

  Future<List<T>> _load(StoreReader reader) async {
    final where = _clauses.isEmpty ? '' : ' WHERE ${_clauses.join(' AND ')}';
    // Ordering by id last keeps results stable when sort keys tie.
    final order = ' ORDER BY ${[..._order, 'id'].join(', ')}';
    final limit = _limit == null ? '' : ' LIMIT $_limit';
    final rows = await reader.sql.select(
      'SELECT doc FROM "${_collection.table}"$where$order$limit',
      _args,
    );
    return [
      for (final row in rows)
        _collection.decode(decodeDocument(row['doc']! as String)),
    ];
  }

  /// Emits the current results, then again whenever the collection changes.
  Stream<List<T>> watch() {
    final store = _store;
    if (store == null) {
      throw StateError('A query inside a transaction cannot be watched.');
    }
    return watchQuery(store, {_collection.name}, get);
  }

  String _column(String field) {
    if (!RegExp(r'^[A-Za-z][A-Za-z0-9_]*$').hasMatch(field)) {
      throw ArgumentError.value(field, 'field', 'Not a top-level field name.');
    }
    return _collection.indexes.contains(field)
        ? '"ix_$field"'
        : "json_extract(doc, '\$.$field')";
  }

  static Object? _bindable(Object? value) => switch (value) {
    true => 1,
    false => 0,
    _ => value,
  };
}

/// Re-runs [load] whenever any of [collections] changes, never running two
/// loads at once and never emitting results out of order.
Stream<R> watchQuery<R>(
  EntanglementStore store,
  Set<String> collections,
  Future<R> Function() load,
) {
  late StreamController<R> controller;
  StreamSubscription<ChangeEvent>? subscription;
  var running = false;
  var dirty = false;

  Future<void> refresh() async {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        final result = await load();
        if (!controller.isClosed) controller.add(result);
      } while (dirty && !controller.isClosed);
    } catch (error, stack) {
      if (!controller.isClosed) controller.addError(error, stack);
    } finally {
      running = false;
    }
  }

  controller = StreamController<R>(
    onListen: () {
      subscription = store.changes
          .where((event) => event.collections.any(collections.contains))
          .listen((_) => refresh());
      refresh();
    },
    onCancel: () => subscription?.cancel(),
  );
  return controller.stream;
}
