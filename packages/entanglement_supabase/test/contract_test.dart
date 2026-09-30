// Runs the shared backend conformance suite against a real Supabase project
// with supabase/migrations/0001_entanglement.sql applied.
//
//   ENTANGLEMENT_SUPABASE_URL=https://xyz.supabase.co \
//   ENTANGLEMENT_SUPABASE_ANON_KEY=... \
//   dart test
//
// Each test signs up two throwaway users, so the project must allow email
// sign-up without confirmation (fine for a local or scratch project; do not
// point this at production).
import 'dart:io';

import 'package:entanglement_supabase/entanglement_supabase.dart';
import 'package:supabase/supabase.dart';
import 'package:test/test.dart';

import '../../entanglement/test/backend_contract.dart';

void main() {
  final url = Platform.environment['ENTANGLEMENT_SUPABASE_URL'];
  final key = Platform.environment['ENTANGLEMENT_SUPABASE_ANON_KEY'];
  if (url == null || key == null) {
    test('Supabase contract', () {}, skip: 'Set ENTANGLEMENT_SUPABASE_URL and ENTANGLEMENT_SUPABASE_ANON_KEY.');
    return;
  }

  Future<SupabaseClient> newUser() async {
    // Implicit flow: PKCE needs a storage backend plain `dart test` lacks
    // (supabase_flutter supplies one in apps).
    final client = SupabaseClient(
      url,
      key,
      authOptions: const AuthClientOptions(
        authFlowType: AuthFlowType.implicit,
        autoRefreshToken: false,
      ),
    );
    final email = 'entanglement-${DateTime.now().microsecondsSinceEpoch}@example.test';
    final response = await client.auth.signUp(email: email, password: 'contract-${email.hashCode}');
    if (response.session == null) {
      throw StateError('Sign-up returned no session; disable email confirmation for this project.');
    }
    return client;
  }

  runBackendContract(() async {
    final alice = await newUser();
    final bob = await newUser();
    return ContractHarness(
      backend: SupabaseSyncBackend(alice),
      otherAccount: SupabaseSyncBackend(bob),
      dispose: () async {
        await alice.dispose();
        await bob.dispose();
      },
    );
  });
}
