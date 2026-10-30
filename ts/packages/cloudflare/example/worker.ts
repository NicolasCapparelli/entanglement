// Reference hosting Worker (not deployed from here; the tests run it under
// Miniflare). In an app, import from "@entanglement/cloudflare" instead.
import { bearerTokenFromRequest, handleEntanglementRequest, type DurableObjectNamespaceLike } from "../src/index.js";

export { EntanglementAccount } from "../src/index.js";

interface Env {
  ENTANGLEMENT_ACCOUNT: DurableObjectNamespaceLike;
  /** Device token SHA-256 (hex) -> account ID. Replace with your own auth. */
  TOKENS: { get(key: string): Promise<string | null> };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = bearerTokenFromRequest(request);
    // Tokens are stored hashed, so a leaked KV listing is not a set of logins.
    const accountId = token ? await env.TOKENS.get(await sha256Hex(token)) : null;
    if (!accountId) {
      return new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Invalid token." } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return handleEntanglementRequest(request, env as unknown as Record<string, unknown>, accountId);
  },
};
