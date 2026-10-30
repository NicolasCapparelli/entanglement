import { HistoryUnavailableError, type Commit, type SyncBackend } from "@entanglement/core";

import { FaultyBackend, type SimTarget } from "../../core/test/simulation.js";

/** Every commit still held: starts after the compaction point the server names. */
export async function remainingCommits(backend: SyncBackend): Promise<Commit[]> {
  let after = 0;
  for (;;) {
    try {
      return await backend.commits({ after, upTo: Number.MAX_SAFE_INTEGER, limit: 1000 });
    } catch (error) {
      const compacted = error instanceof HistoryUnavailableError ? /up to (\d+)/.exec(error.message) : null;
      if (!compacted || Number(compacted[1]) <= after) throw error;
      after = Number(compacted[1]);
    }
  }
}

/** A simulation target over any host that can make a backend for a token. */
export function remoteTarget(make: (token: string | null) => SyncBackend, token: string): SimTarget {
  let rule: () => boolean = () => false;
  return {
    setFaults: (next) => {
      rule = next;
    },
    backend: (accounts) => new FaultyBackend(make(accounts.currentAccount() ? token : null), () => () => rule()),
    head: () => make(token).head(),
    commits: () => remainingCommits(make(token)),
  };
}
