import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

import {
  CloudflareSyncBackend,
  EntanglementAccount,
  handleEntanglementRequest,
  type CloudflareBackendOptions,
  type DurableObjectStateLike,
  type SyncStorage,
  type WebSocketLike,
} from "../src/index.js";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// -- The real thing: the example Worker and the Durable Object under workerd ---

/** The example Worker, bundled and served by Miniflare (workerd) on a real port. */
export class MiniflareHost {
  private constructor(
    private readonly mf: Miniflare,
    readonly baseUrl: string,
    readonly persistDir: string,
  ) {}

  static async start(persistDir = mkdtempSync(join(tmpdir(), "ent-cf-"))): Promise<MiniflareHost> {
    const bundle = await build({
      entryPoints: [here("../example/worker.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      alias: { "@entanglement/core": here("../../core/src/index.ts") },
    });
    const mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2025-09-01",
      durableObjects: { ENTANGLEMENT_ACCOUNT: { className: "EntanglementAccount", useSQLite: true } },
      durableObjectsPersist: join(persistDir, "do"),
      kvNamespaces: ["TOKENS"],
      kvPersist: join(persistDir, "kv"),
      host: "127.0.0.1",
      port: 0,
    });
    const url = await mf.ready;
    return new MiniflareHost(mf, `${url.origin}/v1`, persistDir);
  }

  /** Lets `token` act as `account`. */
  async grant(token: string, account: string): Promise<void> {
    const kv = await this.mf.getKVNamespace("TOKENS");
    await kv.put(await sha256Hex(token), account);
  }

  backend(token: string | null, extra: Partial<CloudflareBackendOptions> = {}): CloudflareSyncBackend {
    return new CloudflareSyncBackend({ baseUrl: this.baseUrl, getToken: () => token, ...extra });
  }

  /** Stops workerd, flushing storage to disk. */
  async stop(options: { keepFiles?: boolean } = {}): Promise<void> {
    await this.mf.dispose();
    if (!options.keepFiles) rmSync(this.persistDir, { recursive: true, force: true });
  }
}

/** True if `needle` appears in any file under `dir`, including SQLite WALs. */
export function directoryContains(dir: string, needle: string): boolean {
  const bytes = Buffer.from(needle);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (directoryContains(path, needle)) return true;
    } else if (readFileSync(path).includes(bytes)) {
      return true;
    }
  }
  return false;
}

// -- The same code over node:sqlite, with no Worker runtime -------------------

export function nodeSqliteStorage(): SyncStorage {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const statement = db.prepare(query);
        const args = bindings as never[];
        if (statement.columns().length > 0) {
          const rows = statement.all(...args) as Record<string, unknown>[];
          return { toArray: () => rows };
        }
        statement.run(...args);
        return { toArray: () => [] };
      },
    },
    transactionSync<T>(body: () => T): T {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** Server half of a fake hibernating WebSocket, wired straight to a client half. */
class FakeSocketPair {
  readonly client: WebSocketLike & { closed: boolean };
  readonly server = { send: (message: string) => this.client.onmessage?.({ data: message }) };

  constructor(open: (server: FakeSocketPair["server"]) => void) {
    this.client = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      closed: false,
      send: () => {},
      close: () => {
        this.client.closed = true;
      },
    };
    queueMicrotask(() => {
      open(this.server);
      this.client.onopen?.({});
    });
  }
}

/**
 * Stands in for Cloudflare: one EntanglementAccount per account on its own
 * node:sqlite database, behind handleEntanglementRequest, with a trivial
 * token -> account table. `fetch` is the client's transport.
 */
export class NodeHost {
  private readonly objects = new Map<string, { object: EntanglementAccount; sockets: { send(m: string): void }[] }>();
  readonly tokens = new Map<string, string>();
  readonly storages = new Map<string, SyncStorage>();

  private objectFor(account: string) {
    let entry = this.objects.get(account);
    if (!entry) {
      const sockets: { send(m: string): void }[] = [];
      const storage = nodeSqliteStorage();
      this.storages.set(account, storage);
      const ctx: DurableObjectStateLike = {
        storage,
        acceptWebSocket: (socket) => sockets.push(socket as { send(m: string): void }),
        getWebSockets: () => sockets,
      };
      entry = { object: new EntanglementAccount(ctx), sockets };
      this.objects.set(account, entry);
    }
    return entry;
  }

  grant(token: string, account: string): void {
    this.tokens.set(token, account);
  }

  readonly env = {
    ENTANGLEMENT_ACCOUNT: {
      idFromName: (name: string) => name,
      get: (account: string) => ({ fetch: (request: Request) => this.objectFor(account).object.fetch(request) }),
    },
  };

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const auth = request.headers.get("authorization");
    const account = auth?.startsWith("Bearer ") ? this.tokens.get(auth.slice(7)) : undefined;
    if (!account) return new Response('{"error":{"code":"unauthenticated","message":"no"}}', { status: 401 });
    return handleEntanglementRequest(request, this.env, account);
  };

  backend(token: string | null, extra: Partial<CloudflareBackendOptions> = {}): CloudflareSyncBackend {
    return new CloudflareSyncBackend({
      baseUrl: "http://sync.test/v1",
      getToken: () => token,
      fetch: this.fetch as typeof fetch,
      createWebSocket: (_url, protocols) => {
        const account = this.tokens.get(atobUrl(protocols.find((p) => p.startsWith("bearer."))!.slice(7)));
        if (!account) throw new Error("unauthorized");
        return new FakeSocketPair((server) => this.objectFor(account).sockets.push(server)).client;
      },
      ...extra,
    });
  }
}

function atobUrl(text: string): string {
  return Buffer.from(text, "base64url").toString();
}
