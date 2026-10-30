import { ACCOUNT_HEADER, API_PREFIX, SUBPROTOCOL } from "./wire.js";

/** The slice of a Durable Object namespace binding that the helper uses. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: any): { fetch(request: Request): Promise<Response> };
}

export interface HandleOptions {
  /** Name of the namespace binding in `env`. Default `ENTANGLEMENT_ACCOUNT`. */
  binding?: string;
}

/**
 * Forwards an already-authenticated request to the account's Durable Object.
 *
 * The hosting Worker authenticates the device token (see
 * `bearerTokenFromRequest`), decides the account ID, and calls this. Any
 * account header or credential the client sent is dropped: the DO sees only
 * the header set here, and never the bearer token.
 */
export async function handleEntanglementRequest(
  request: Request,
  env: Record<string, unknown>,
  accountId: string,
  options: HandleOptions = {},
): Promise<Response> {
  const namespace = env[options.binding ?? "ENTANGLEMENT_ACCOUNT"] as DurableObjectNamespaceLike | undefined;
  if (!namespace) throw new Error(`Missing Durable Object binding ${options.binding ?? "ENTANGLEMENT_ACCOUNT"}.`);
  if (!accountId) throw new Error("accountId is required.");

  const url = new URL(request.url);
  const at = url.pathname.indexOf(API_PREFIX);
  if (at < 0) return new Response("Not found", { status: 404 });
  const target = new URL(`https://entanglement.internal${url.pathname.slice(at)}${url.search}`);

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete(ACCOUNT_HEADER);
  if (headers.has("sec-websocket-protocol")) headers.set("sec-websocket-protocol", SUBPROTOCOL);
  headers.set(ACCOUNT_HEADER, accountId);

  const stub = namespace.get(namespace.idFromName(accountId));
  return stub.fetch(new Request(target, new Request(request, { headers })));
}
