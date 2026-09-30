// Runs the shared backend conformance suite against a real Supabase project
// set up per Entanglement/docs/supabase-setup.md:
//
//   ENTANGLEMENT_SUPABASE_URL=https://<ref>.supabase.co \
//   ENTANGLEMENT_SUPABASE_ANON_KEY=<publishable key> npx vitest run packages/supabase
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, test } from "vitest";

import { runBackendContract } from "../../core/test/backendContract.js";
import { SupabaseSyncBackend } from "../src/index.js";

const url = process.env.ENTANGLEMENT_SUPABASE_URL;
const key = process.env.ENTANGLEMENT_SUPABASE_ANON_KEY;

if (!url || !key) {
  test.skip("Supabase contract (set ENTANGLEMENT_SUPABASE_URL and ENTANGLEMENT_SUPABASE_ANON_KEY)", () => {});
} else {
  const newUser = async (): Promise<SupabaseClient> => {
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = `entanglement-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    const { data, error } = await client.auth.signUp({ email, password: `contract-${Math.random()}` });
    if (error || !data.session) {
      throw new Error(`Sign-up gave no session (${error?.message ?? "email confirmation on?"}).`);
    }
    return client;
  };

  describe("SupabaseSyncBackend", () => {
    runBackendContract(async () => {
      const alice = await newUser();
      const bob = await newUser();
      return {
        backend: new SupabaseSyncBackend(alice),
        otherAccount: new SupabaseSyncBackend(bob),
        dispose: async () => {
          await alice.removeAllChannels();
          await bob.removeAllChannels();
        },
      };
    });
  });
}
