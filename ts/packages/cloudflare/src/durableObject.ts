import { AccountServer } from "./server.js";
import type { SyncStorage } from "./storage.js";
import { ACCOUNT_HEADER, API_PREFIX, ServerError, SUBPROTOCOL, type ErrorBody } from "./wire.js";

/** The parts of a Durable Object `ctx` this class uses. */
export interface DurableObjectStateLike {
  readonly storage: SyncStorage;
  blockConcurrencyWhile?<T>(body: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: unknown): void;
  getWebSockets(): { send(message: string): void }[];
  setWebSocketAutoResponse?(pair: unknown): void;
}

type Json = Record<string, unknown>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * One account's sync server as a Durable Object (Mille spec §9.3). Bind it as
 * a SQLite-backed class and address it by account ID; a hosting Worker should
 * call `handleEntanglementRequest`, which authenticates nothing itself but
 * stamps the account on every request. Not reachable from the internet except
 * through that Worker, so the account header is trusted.
 *
 * Hints go to subscribed WebSockets through the Hibernation API: the object
 * can be evicted between hints and the sockets survive. A hint carries only
 * the new revision.
 */
export class EntanglementAccount {
  private readonly server: AccountServer;

  constructor(
    private readonly ctx: DurableObjectStateLike,
    _env?: unknown,
  ) {
    this.server = new AccountServer(ctx.storage, (revision) => this.broadcast(revision));
    const migrate = async (): Promise<void> => this.server.migrate();
    if (ctx.blockConcurrencyWhile) void ctx.blockConcurrencyWhile(migrate);
    else this.server.migrate();
    const Pair = (globalThis as { WebSocketRequestResponsePair?: new (request: string, response: string) => unknown })
      .WebSocketRequestResponsePair;
    // Keepalives are answered without waking a hibernated object.
    if (Pair && ctx.setWebSocketAutoResponse) ctx.setWebSocketAutoResponse(new Pair("ping", "pong"));
  }

  private broadcast(revision: number): void {
    const message = JSON.stringify({ type: "hint", revision });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket that is closing; its close handler cleans up.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const account = request.headers.get(ACCOUNT_HEADER);
      if (!account) return fail(401, "unauthenticated", "Missing account.");
      this.server.bindAccount(account);
      const url = new URL(request.url);
      if (!url.pathname.startsWith(API_PREFIX)) return fail(404, "not_found", "Unknown route.");
      const route = `${request.method} ${url.pathname.slice(API_PREFIX.length)}`;

      if (route === "GET subscribe") return this.subscribe(request);
      switch (route) {
        case "GET head":
          return json({ head: this.server.head() });
        case "GET commits":
          return json({
            commits: this.server.commits(
              intParam(url, "after"),
              intParam(url, "upTo"),
              url.searchParams.has("limit") ? intParam(url, "limit") : 200,
            ),
          });
        case "GET checkpoint":
          return json({ checkpoint: this.server.checkpoint(intParam(url, "atOrBefore")) });
        case "GET restore-points":
          return json({ restorePoints: this.server.restorePoints() });
      }
      if (request.method !== "POST") return fail(404, "not_found", "Unknown route.");
      const body = await readBody(request);
      switch (route) {
        case "POST submit":
          return json(this.server.submit(body));
        case "POST checkpoint":
          this.server.putCheckpoint(body);
          return json({});
        case "POST restore-points":
          this.server.putRestorePoint(body);
          return json({});
        case "POST restore-points/delete":
          this.server.deleteRestorePoints(body.keys);
          return json({});
        case "POST compact":
          this.server.compact(body.anchor as number);
          return json({});
      }
      return fail(404, "not_found", "Unknown route.");
    } catch (error) {
      if (error instanceof ServerError) return fail(error.status, error.code, error.message);
      return fail(500, "internal", error instanceof Error ? error.message : String(error));
    }
  }

  private subscribe(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return fail(426, "upgrade_required", "Expected a WebSocket upgrade.");
    }
    const Pair = (globalThis as { WebSocketPair?: new () => Record<number, unknown> }).WebSocketPair;
    if (!Pair) return fail(501, "unsupported", "WebSockets are unavailable here.");
    const pair = new Pair();
    this.ctx.acceptWebSocket(pair[1]);
    const headers = new Headers();
    if (request.headers.get("sec-websocket-protocol")?.includes(SUBPROTOCOL)) {
      headers.set("sec-websocket-protocol", SUBPROTOCOL);
    }
    return new Response(null, { status: 101, headers, webSocket: pair[0] } as ResponseInit);
  }

  // -- WebSocket Hibernation handlers ------------------------------------------

  webSocketMessage(socket: { send(message: string): void }, message: string | ArrayBuffer): void {
    // Clients only ping. (With auto-response active this is not even reached.)
    if (message === "ping") socket.send("pong");
  }

  webSocketClose(socket: { close(code?: number, reason?: string): void }, code: number): void {
    try {
      // 1005/1006 are reserved and cannot be echoed.
      socket.close(code >= 1000 && code < 1005 ? code : 1000, "closing");
    } catch {
      // Already closed.
    }
  }

  webSocketError(): void {}
}

function fail(status: number, code: string, message: string): Response {
  const body: ErrorBody = { error: { code, message } };
  return json(body, status);
}

function intParam(url: URL, name: string): number {
  const raw = url.searchParams.get(name);
  const value = raw === null || raw === "" ? NaN : Number(raw);
  if (!Number.isSafeInteger(value)) throw new ServerError(400, "invalid_request", `Bad ${name}.`);
  return value;
}

async function readBody(request: Request): Promise<Json> {
  try {
    const body = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) return body as Json;
  } catch {
    // fall through
  }
  throw new ServerError(400, "invalid_request", "Expected a JSON object.");
}
