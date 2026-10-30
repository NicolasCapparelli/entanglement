import {
  AuthRequiredError,
  FatalBackendError,
  HistoryUnavailableError,
  TransientBackendError,
  type BackendError,
} from "@entanglement/core";

/** Header a hosting Worker sets, after authenticating, to name the account. */
export const ACCOUNT_HEADER = "x-entanglement-account";

/** WebSocket subprotocol; the client adds `bearer.<base64url token>` beside it. */
export const SUBPROTOCOL = "entanglement.v1";
export const BEARER_PREFIX = "bearer.";

/** Path of the API under the Worker, e.g. `https://host/v1/head`. */
export const API_PREFIX = "/v1/";

export type SubmitStatus = "accepted" | "conflict" | "rejected_schema_too_old" | "rejected_invalid";

export interface ErrorBody {
  error: { code: string; message: string };
}

/** A failure the server reports with an HTTP status and a stable code. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const HISTORY_UNAVAILABLE = "history_unavailable";

/** Turns an HTTP failure into a framework error (spec §18.2). */
export function errorFromResponse(status: number, text: string): BackendError {
  let code = "";
  let message = text.slice(0, 300) || `HTTP ${status}`;
  try {
    const body = JSON.parse(text) as Partial<ErrorBody>;
    if (body.error) {
      code = String(body.error.code ?? "");
      message = String(body.error.message ?? message);
    }
  } catch {
    // Not ours (a proxy or platform error page); the status decides.
  }
  if (status === 401) return new AuthRequiredError(message);
  if (status === 410 || code === HISTORY_UNAVAILABLE) return new HistoryUnavailableError(message);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return new TransientBackendError(message);
  return new FatalBackendError(message, code || String(status));
}

export function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/**
 * The bearer token of a request: the Authorization header, or, for a
 * WebSocket (which cannot set headers from a browser or React Native), the
 * `bearer.<token>` subprotocol. A hosting Worker authenticates with this.
 */
export function bearerTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match) return match[1]!.trim();
  }
  const protocols = request.headers.get("sec-websocket-protocol");
  if (protocols) {
    for (const protocol of protocols.split(",").map((part) => part.trim())) {
      if (protocol.startsWith(BEARER_PREFIX)) {
        try {
          return base64UrlDecode(protocol.slice(BEARER_PREFIX.length));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
