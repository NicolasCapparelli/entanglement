import {
  AuthRequiredError,
  BackendError,
  changeFromJson,
  changeToJson,
  commitRequestToJson,
  Emitter,
  FatalBackendError,
  HistoryUnavailableError,
  StateDigest,
  TransientBackendError,
  type AccountSource,
  type Checkpoint,
  type Commit,
  type CommitRequest,
  type Head,
  type RestorePoint,
  type RestorePointKey,
  type RestorePointKind,
  type SubmitResult,
  type SyncBackend,
  type Unsubscribe,
} from "@entanglement/core";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

interface Result<T> {
  data: T | null;
  error: { code?: string; message: string } | null;
  status?: number;
}

/**
 * SyncBackend over Supabase (design spec §19), using the tables and functions
 * in `packages/entanglement_supabase/supabase/migrations/0001_entanglement.sql`
 * — the same server the Dart adapter talks to.
 *
 * Reads go straight to the tables (row-level security limits them to the
 * signed-in user); every write is an RPC enforcing the protocol server-side.
 */
export class SupabaseSyncBackend implements SyncBackend {
  constructor(private readonly client: SupabaseClient) {}

  private async userId(): Promise<string> {
    const { data } = await this.client.auth.getSession();
    const id = data.session?.user.id;
    if (!id) throw new AuthRequiredError("Not signed in.");
    return id;
  }

  async head(): Promise<Head | null> {
    return guard(async () => {
      const row = unwrap(
        (await this.client.from("ent_heads").select("*").eq("user_id", await this.userId()).maybeSingle()) as Result<Row>,
      );
      // Revision 0 is only the lock row of a first commit that did not land.
      if (!row || Number(row.revision) === 0) return null;
      return {
        revision: Number(row.revision),
        schemaVersion: Number(row.schema_version),
        minVersion: Number(row.min_version),
        stateDigest: StateDigest.parse(String(row.state_digest)),
        updatedAt: new Date(String(row.updated_at)),
      };
    });
  }

  async commits({ after, upTo, limit = 200 }: { after: number; upTo: number; limit?: number }): Promise<Commit[]> {
    return guard(async () => {
      const userId = await this.userId();
      const head = unwrap(
        (await this.client
          .from("ent_heads")
          .select("compacted_through")
          .eq("user_id", userId)
          .maybeSingle()) as Result<Row>,
      );
      const compacted = head ? Number(head.compacted_through) : 0;
      if (after < compacted) throw new HistoryUnavailableError(`Commits up to ${compacted} were compacted.`);
      const rows =
        unwrap(
          (await this.client
            .from("ent_commits")
            .select("*")
            .eq("user_id", userId)
            .gt("revision", after)
            .lte("revision", upTo)
            .order("revision", { ascending: true })
            .limit(limit)) as Result<Row[]>,
        ) ?? [];
      const commits = rows.map(commitFrom);
      // Compaction can run between the check above and this read.
      if (commits.length > 0 && commits[0]!.revision !== after + 1) {
        throw new HistoryUnavailableError("Commit history has a gap.");
      }
      return commits;
    });
  }

  async submit(request: CommitRequest): Promise<SubmitResult> {
    return guard(async () => {
      await this.userId();
      const rows = unwrap(
        (await this.client.rpc("ent_submit", { p_request: commitRequestToJson(request) })) as Result<Row[]>,
      );
      const row = rows?.[0];
      if (!row) throw new FatalBackendError("ent_submit returned nothing.");
      const revision = row.out_revision == null ? null : Number(row.out_revision);
      switch (row.out_status) {
        case "accepted":
          return { kind: "accepted", revision: revision ?? 0 };
        case "conflict":
          return { kind: "conflict", headRevision: revision ?? 0 };
        case "rejected_schema_too_old":
          return { kind: "rejected", reason: "schemaTooOld" };
        default:
          return { kind: "rejected", reason: "invalid" };
      }
    });
  }

  async checkpoint({ atOrBefore }: { atOrBefore: number }): Promise<Checkpoint | null> {
    return guard(async () => {
      const row = unwrap(
        (await this.client
          .from("ent_checkpoints")
          .select("*")
          .eq("user_id", await this.userId())
          .lte("revision", atOrBefore)
          .order("revision", { ascending: false })
          .limit(1)
          .maybeSingle()) as Result<Row>,
      );
      if (!row) return null;
      return {
        revision: Number(row.revision),
        schemaVersion: Number(row.schema_version),
        stateDigest: StateDigest.parse(String(row.state_digest)),
        entities: (row.entities as Row[]).map(changeFromJson),
        createdAt: new Date(String(row.created_at)),
      };
    });
  }

  async putCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await guard(async () => {
      await this.userId();
      unwrap(
        (await this.client.rpc("ent_put_checkpoint", {
          p_checkpoint: {
            revision: checkpoint.revision,
            schemaVersion: checkpoint.schemaVersion,
            stateDigest: checkpoint.stateDigest.hex,
            entities: checkpoint.entities.map(changeToJson),
          },
        })) as Result<unknown>,
      );
    });
  }

  async restorePoints(): Promise<RestorePoint[]> {
    return guard(async () => {
      const rows =
        unwrap(
          (await this.client
            .from("ent_restore_points")
            .select("*")
            .eq("user_id", await this.userId())
            .order("revision", { ascending: false })) as Result<Row[]>,
        ) ?? [];
      return rows.map((row) => ({
        revision: Number(row.revision),
        kind: String(row.kind) as RestorePointKind,
        label: row.label == null ? null : String(row.label),
        pinned: row.pinned === true,
        deviceLabel: row.device_label == null ? null : String(row.device_label),
        createdAt: new Date(String(row.created_at)),
      }));
    });
  }

  async putRestorePoint(point: RestorePoint): Promise<void> {
    await guard(async () => {
      await this.userId();
      unwrap(
        (await this.client.rpc("ent_put_restore_point", {
          p_revision: point.revision,
          p_kind: point.kind,
          p_label: point.label,
          p_pinned: point.pinned,
          p_device_label: point.deviceLabel,
        })) as Result<unknown>,
      );
    });
  }

  async deleteRestorePoints(keys: readonly RestorePointKey[]): Promise<void> {
    if (keys.length === 0) return;
    await guard(async () => {
      await this.userId();
      unwrap(
        (await this.client.rpc("ent_delete_restore_points", {
          p_keys: keys.map(({ revision, kind }) => ({ revision, kind })),
        })) as Result<unknown>,
      );
    });
  }

  async compact({ anchor }: { anchor: number }): Promise<void> {
    await guard(async () => {
      await this.userId();
      unwrap((await this.client.rpc("ent_compact", { p_anchor: anchor })) as Result<unknown>);
    });
  }

  /**
   * Postgres Changes on `ent_heads` for the signed-in user. The row holds only
   * revision metadata, so no user data travels on the socket.
   */
  onHint(listener: () => void): Unsubscribe | null {
    let channel: RealtimeChannel | null = null;
    let stopped = false;
    void (async () => {
      const { data } = await this.client.auth.getSession();
      const session = data.session;
      if (!session || stopped) return;
      // An RLS-protected table delivers nothing to an unauthenticated socket.
      await this.client.realtime.setAuth(session.access_token);
      channel = this.client
        .channel(`ent_heads:${session.user.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "ent_heads", filter: `user_id=eq.${session.user.id}` },
          () => listener(),
        )
        .subscribe();
    })();
    return () => {
      stopped = true;
      if (channel) void this.client.removeChannel(channel);
    };
  }
}

/** AccountSource over Supabase Auth. Create with `SupabaseAccountSource.create`. */
export class SupabaseAccountSource implements AccountSource {
  private readonly changes = new Emitter<string | null>();

  private constructor(
    client: SupabaseClient,
    private current: string | null,
  ) {
    client.auth.onAuthStateChange((_event, session) => {
      const next = session?.user.id ?? null;
      if (next === this.current) return;
      this.current = next;
      this.changes.emit(next);
    });
  }

  /** Reads the restored session first, so `currentAccount` is right at once. */
  static async create(client: SupabaseClient): Promise<SupabaseAccountSource> {
    const { data } = await client.auth.getSession();
    return new SupabaseAccountSource(client, data.session?.user.id ?? null);
  }

  currentAccount(): string | null {
    return this.current;
  }

  onAccountChange(listener: (account: string | null) => void): Unsubscribe {
    return this.changes.on(listener);
  }
}

function commitFrom(row: Row): Commit {
  return {
    revision: Number(row.revision),
    committedAt: new Date(String(row.committed_at)),
    request: {
      commitId: String(row.commit_id),
      parent: Number(row.parent),
      schemaVersion: Number(row.schema_version),
      compatibleSince: Number(row.compatible_since),
      deviceId: String(row.device_id),
      deviceLabel: row.device_label == null ? null : String(row.device_label),
      clientTime: row.client_time == null ? null : Number(row.client_time),
      message: row.message == null ? null : String(row.message),
      stateDigest: StateDigest.parse(String(row.state_digest)),
      changes: (row.changes as Row[]).map(changeFromJson),
    },
  };
}

/** Turns a supabase-js result into data or a framework error (spec §18.2). */
function unwrap<T>(result: Result<T>): T | null {
  const { error, status } = result;
  if (!error) return result.data;
  const code = error.code ?? "";
  if (code === "28000" || code === "PGRST301" || code === "PGRST302" || status === 401) {
    throw new AuthRequiredError(error.message);
  }
  // Status 0 / 5xx: the request never completed or the server failed.
  if (!status || status >= 500 || code.startsWith("08") || code === "57P01") {
    throw new TransientBackendError(error.message);
  }
  throw new FatalBackendError(error.message, code);
}

async function guard<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof BackendError) throw error;
    // Anything else is transport: fetch failures, timeouts, offline.
    throw new TransientBackendError(error instanceof Error ? error.message : String(error));
  }
}
