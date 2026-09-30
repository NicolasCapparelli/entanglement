typedef Json = Map<String, Object?>;

/// Identifies one document.
typedef DocKey = ({String collection, String id});

DocKey docKey(String collection, String id) =>
    (collection: collection, id: id);

/// A dependency from one document on another (spec §5.4).
///
/// The target must exist — and pass [check], when given — in every committed
/// local state and every merged state. [check] covers references into the
/// inside of an aggregate, such as a quadrant id within a board document.
class Ref {
  const Ref(this.collection, this.id, {this.check});

  final String collection;
  final String id;
  final bool Function(Json target)? check;

  DocKey get key => docKey(collection, id);
}

/// How a collection merges a document both sides changed differently
/// (spec §5.6).
sealed class MergePolicy {
  const MergePolicy();

  /// Any both-sides change is a conflict. The default.
  static const MergePolicy wholeDocument = WholeDocumentMerge();

  /// Three-way merge per top-level key. Keys listed together in a group merge
  /// as one value, for fields that must stay consistent with each other.
  const factory MergePolicy.fieldwise({List<Set<String>> groups}) =
      FieldwiseMerge;

  /// Application-defined merge. Must be deterministic: every device that sees
  /// the same three inputs must reach the same outcome.
  const factory MergePolicy.custom(CustomMergeFunction merge) = CustomMerge;
}

class WholeDocumentMerge extends MergePolicy {
  const WholeDocumentMerge();
}

class FieldwiseMerge extends MergePolicy {
  const FieldwiseMerge({this.groups = const []});

  final List<Set<String>> groups;
}

typedef CustomMergeFunction =
    CustomMergeOutcome Function(Json? base, Json? local, Json? remote);

class CustomMerge extends MergePolicy {
  const CustomMerge(this.merge);

  final CustomMergeFunction merge;
}

sealed class CustomMergeOutcome {
  const CustomMergeOutcome();
}

/// The merged document, or null to delete it.
class Merged extends CustomMergeOutcome {
  const Merged(this.value);

  final Json? value;
}

class Unmergeable extends CustomMergeOutcome {
  const Unmergeable();
}

final RegExp _identifier = RegExp(r'^[A-Za-z][A-Za-z0-9_]*$');

/// A collection of JSON documents, untyped. [Collection] adds a typed codec on
/// top; the engine only ever works with this view.
class CollectionDef {
  CollectionDef(
    this.name, {
    this.fields,
    this.indexes = const {},
    this.refs,
    this.merge = MergePolicy.wholeDocument,
    this.sync = true,
  }) {
    if (!_identifier.hasMatch(name)) {
      throw ArgumentError.value(
        name,
        'name',
        'Collection names are letters, digits and underscores, starting with '
            'a letter.',
      );
    }
    for (final field in indexes) {
      if (!_identifier.hasMatch(field)) {
        throw ArgumentError.value(field, 'indexes', 'Not an identifier.');
      }
    }
  }

  /// Placeholder for a collection written by a newer build that this build
  /// does not declare. Its documents are stored and synced untouched, so an
  /// older build never drops data it does not understand.
  CollectionDef.opaque(String name) : this(name);

  final String name;

  /// Top-level keys this build understands. Stored keys outside this set are
  /// carried over on every write (spec §5.5). Null disables carry-over: a
  /// write replaces the whole document.
  final Set<String>? fields;

  /// Top-level fields to index for queries.
  final Set<String> indexes;

  /// Outgoing references of a document (spec §5.4).
  final List<Ref> Function(Json doc)? refs;

  final MergePolicy merge;

  /// False for local-only collections, which are never journaled or synced.
  final bool sync;

  String get table => 'c_$name';

  List<Ref> refsOf(Json doc) => refs?.call(doc) ?? const [];
}

/// A collection with a typed codec for application model classes.
class Collection<T> extends CollectionDef {
  Collection(
    super.name, {
    required this.decode,
    required this.encode,
    required this.idOf,
    super.fields,
    super.indexes,
    super.refs,
    super.merge,
    super.sync,
  });

  final T Function(Json json) decode;
  final Json Function(T value) encode;
  final String Function(T value) idOf;

  /// A collection whose values are plain JSON maps carrying their id under
  /// [idField].
  static Collection<Json> json(
    String name, {
    String idField = 'id',
    Set<String>? fields,
    Set<String> indexes = const {},
    List<Ref> Function(Json doc)? refs,
    MergePolicy merge = MergePolicy.wholeDocument,
    bool sync = true,
  }) => Collection<Json>(
    name,
    decode: (json) => json,
    encode: (value) => value,
    idOf: (value) => value[idField]! as String,
    fields: fields,
    indexes: indexes,
    refs: refs,
    merge: merge,
    sync: sync,
  );
}

/// A pure, deterministic document transform used by schema migrations. Return
/// null to delete the document.
typedef DocumentMigration = Json? Function(String collection, Json doc);

/// The application's data model (spec §17).
class Schema {
  Schema({
    required this.version,
    int? compatibleSince,
    required List<CollectionDef> collections,
    this.migrations = const {},
  }) : compatibleSince = compatibleSince ?? version,
       collections = List.unmodifiable(collections) {
    if (version < 1) throw ArgumentError.value(version, 'version');
    if (this.compatibleSince > version) {
      throw ArgumentError('compatibleSince cannot exceed version.');
    }
    final names = <String>{};
    for (final collection in collections) {
      if (collection.name.startsWith('ent_')) {
        throw ArgumentError('The "ent_" prefix is reserved: ${collection.name}');
      }
      if (!names.add(collection.name)) {
        throw ArgumentError('Duplicate collection ${collection.name}.');
      }
    }
  }

  /// This build's payload format.
  final int version;

  /// The oldest format that can safely read and write data this build writes.
  /// Raise it (to [version]) for breaking changes; leave it for additive ones.
  final int compatibleSince;

  final List<CollectionDef> collections;

  /// `toVersion -> transform`, applied in order to bring older documents up to
  /// [version].
  final Map<int, DocumentMigration> migrations;
}
