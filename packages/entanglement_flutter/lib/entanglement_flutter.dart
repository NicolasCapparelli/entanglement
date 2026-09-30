/// Flutter wiring for Entanglement.
library;

import 'dart:async';

import 'package:entanglement/entanglement.dart';
import 'package:flutter/widgets.dart';

export 'package:entanglement/entanglement.dart';
export 'src/open_native.dart'
    if (dart.library.js_interop) 'src/open_web.dart'
    show openAppDatabase;

/// Forwards app lifecycle to an [EntanglementDb] (design spec §20):
/// resuming picks up writes from other isolates and re-checks the remote;
/// pausing makes realtime mode's best-effort final push.
class EntanglementLifecycle with WidgetsBindingObserver {
  EntanglementLifecycle(this.db);

  final EntanglementDb db;

  void attach() => WidgetsBinding.instance.addObserver(this);

  void detach() => WidgetsBinding.instance.removeObserver(this);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(db.checkForExternalChanges());
        unawaited(db.sync?.resume());
      case AppLifecycleState.paused || AppLifecycleState.hidden:
        unawaited(db.sync?.pause());
      case AppLifecycleState.inactive || AppLifecycleState.detached:
        break;
    }
  }
}
