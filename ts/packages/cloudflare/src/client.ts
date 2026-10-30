import {
  AuthRequiredError,
  BackendError,
  changeFromJson,
  changeToJson,
  commitRequestToJson,
  FatalBackendError,
  StateDigest,
  TransientBackendError,
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

import { base64UrlEncode, BEARER_PREFIX, errorFromResponse, SUBPROTOCOL } from "./wire.js";

type Json = Record<string, any>;

/** The few WebSocket members the adapter touches (browser, RN, undici, ...). */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface CloudflareBackendOptions {
  /** Where the Worker serves the API, e.g. `https://sync.example.com/v1`. */
  baseUrl: string;
  /** The device token. Null means signed out. */
  getToken: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
  /** For environments without a global WebSocket, or tests. */
  createWebSocket?: (url: string, protocols: string[]) => WebSocketLike;
  /** Hint socket reconnect backoff, default 1s doubling to 30s. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Keepalive ping interval, default 30s. */
  pingEveryMs?: number;
}

/**
 * SyncBackend over the Durable Object server in this package, through a Worker
 * that authenticates the device token. Errors map as the Supabase adapter's do
 * (spec §18.2): network failures, timeouts and 5xx are transient; 401 is
 * auth; a compacted range is history-unavailable; anything else is fatal.
 */
export class CloudflareSyncBackend implements SyncBackend {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: CloudflareBackendOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async token(): Promise<string> {
    const token = await this.options.getToken();
    if (!token) throw new AuthRequiredError("Not signed in.");
    return token;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
    try {
      const token = await this.token();
      const response = await this.doFetch(`${this.base}/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw errorFromResponse(response.status, text);
      try {
        return text ? (JSON.parse(text) as Json) : {};
      } catch {
        // A 2xx that is not our JSON: a captive portal or a proxy.
        throw new TransientBackendError("Unreadable response.");
      }
    } catch (error) {
      if (error instanceof BackendError) throw error;
      // Anything else is transport: fetch failures, timeouts, offline.
      throw new TransientBackendError(error instanceof Error ? error.message : String(error));
    }
  }

  async head(): Promise<Head | null> {
    const { head } = await this.call("GET", "head");
    if (!head) return null;
    return {
      revision: head.revision,
      schemaVersion: head.schemaVersion,
      minVersion: head.minVersion,
      stateDigest: StateDigest.parse(head.stateDigest),
      updatedAt: new Date(head.updatedAt),
    };
  }

  async commits({ after, upTo, limit = 200 }: { after: number; upTo: number; limit?: number }): Promise<Commit[]> {
    const { commits } = await this.call("GET", `commits?after=${after}&upTo=${upTo}&limit=${limit}`);
    return (commits as Json[]).map((row) => ({
      revision: row.revision,
      committedAt: new Date(row.committedAt),
      request: {
        commitId: row.request.commitId,
        parent: row.request.parent,
        schemaVersion: row.request.schemaVersion,
        compatibleSince: row.request.compatibleSince,
        deviceId: row.request.deviceId,
        deviceLabel: row.request.deviceLabel ?? null,
        clientTime: row.request.clientTime ?? null,
        message: row.request.message ?? null,
        stateDigest: StateDigest.parse(row.request.stateDigest),
        changes: (row.request.changes as Json[]).map(changeFromJson),
      },
    }));
  }

  async submit(request: CommitRequest): Promise<SubmitResult> {
    const result = await this.call("POST", "submit", commitRequestToJson(request));
    switch (result.status) {
      case "accepted":
        return { kind: "accepted", revision: result.revision ?? 0 };
      case "conflict":
        return { kind: "conflict", headRevision: result.revision ?? 0 };
      case "rejected_schema_too_old":
        return { kind: "rejected", reason: "schemaTooOld" };
      case "rejected_invalid":
        return { kind: "rejected", reason: "invalid" };
      default:
        throw new FatalBackendError("Unexpected submit response.");
    }
  }

  async checkpoint({ atOrBefore }: { atOrBefore: number }): Promise<Checkpoint | null> {
    const { checkpoint } = await this.call("GET", `checkpoint?atOrBefore=${atOrBefore}`);
    if (!checkpoint) return null;
    return {
      revision: checkpoint.revision,
      schemaVersion: checkpoint.schemaVersion,
      stateDigest: StateDigest.parse(checkpoint.stateDigest),
      entities: (checkpoint.entities as Json[]).map(changeFromJson),
      createdAt: new Date(checkpoint.createdAt),
    };
  }

  async putCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.call("POST", "checkpoint", {
      revision: checkpoint.revision,
      schemaVersion: checkpoint.schemaVersion,
      stateDigest: checkpoint.stateDigest.hex,
      entities: checkpoint.entities.map(changeToJson),
    });
  }

  async restorePoints(): Promise<RestorePoint[]> {
    const { restorePoints } = await this.call("GET", "restore-points");
    return (restorePoints as Json[]).map((row) => ({
      revision: row.revision,
      kind: row.kind as RestorePointKind,
      label: row.label ?? null,
      pinned: row.pinned === true,
      deviceLabel: row.deviceLabel ?? null,
      createdAt: new Date(row.createdAt),
    }));
  }

  async putRestorePoint(point: RestorePoint): Promise<void> {
    await this.call("POST", "restore-points", {
      revision: point.revision,
      kind: point.kind,
      label: point.label,
      pinned: point.pinned,
      deviceLabel: point.deviceLabel,
    });
  }

  async deleteRestorePoints(keys: readonly RestorePointKey[]): Promise<void> {
    if (keys.length === 0) return;
    await this.call("POST", "restore-points/delete", {
      keys: keys.map(({ revision, kind }) => ({ revision, kind })),
    });
  }

  async compact({ anchor }: { anchor: number }): Promise<void> {
    await this.call("POST", "compact", { anchor });
  }

  /**
   * A WebSocket to the account's Durable Object. Hints carry only a revision;
   * the listener also fires on every (re)connect, since a hint may have been
   * missed while the socket was down.
   */
  onHint(listener: () => void): Unsubscribe | null {
    const create =
      this.options.createWebSocket ??
      (typeof WebSocket === "undefined"
        ? null
        : (url: string, protocols: string[]) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    if (!create) return null;

    const minDelay = this.options.reconnectMinMs ?? 1_000;
    const maxDelay = this.options.reconnectMaxMs ?? 30_000;
    let stopped = false;
    let socket: WebSocketLike | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let delay = minDelay;

    const scheduleReconnect = (): void => {
      if (ping) clearInterval(ping);
      ping = null;
      socket = null;
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        void connect();
      }, delay);
      delay = Math.min(delay * 2, maxDelay);
    };

    const connect = async (): Promise<void> => {
      let token: string | null;
      try {
        token = await this.options.getToken();
      } catch {
        token = null;
      }
      if (stopped) return;
      if (!token) return scheduleReconnect();
      const url = `${this.base.replace(/^http/, "ws")}/subscribe`;
      let ws: WebSocketLike;
      try {
        ws = create(url, [SUBPROTOCOL, `${BEARER_PREFIX}${base64UrlEncode(token)}`]);
      } catch {
        return scheduleReconnect();
      }
      socket = ws;
      ws.onopen = () => {
        delay = minDelay;
        ping = setInterval(() => {
          try {
            ws.send("ping");
          } catch {
            // The close handler reconnects.
          }
        }, this.options.pingEveryMs ?? 30_000);
        listener();
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string" && event.data.startsWith("{")) listener();
      };
      ws.onclose = () => scheduleReconnect();
      ws.onerror = () => {};
    };

    void connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      const current = socket;
      socket = null;
      if (current) {
        current.onclose = null;
        try {
          current.close();
        } catch {
          // Already closed.
        }
      }
    };
  }
}
