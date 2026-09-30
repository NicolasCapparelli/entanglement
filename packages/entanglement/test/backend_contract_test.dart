import 'package:entanglement/entanglement.dart';

import 'backend_contract.dart';

void main() {
  runBackendContract(() async {
    final server = InMemoryServer();
    return ContractHarness(
      backend: InMemoryBackend(server, ManualAccountSource('alice')),
      otherAccount: InMemoryBackend(server, ManualAccountSource('bob')),
    );
  });
}
