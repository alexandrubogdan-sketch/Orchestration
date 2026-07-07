/** Server-only. Never import this from a "use client" component or
 *  anything that ends up in a browser bundle — BackendConfig.token is
 *  the real backend-go Bearer API token, and it must only ever be read
 *  here, on the server, inside an app/api/* Route Handler (see
 *  lib/backend-proxy.ts, the only caller). This is exactly the
 *  server-side-proxy approach agreed on for Live mode: the browser
 *  talks to this Next.js app's own /api/* routes, never to backend-go
 *  directly with a Bearer token in hand.
 *
 *  BACKEND_API_BASE_URL / BACKEND_API_TOKEN are not set anywhere yet —
 *  there is no deployed backend-go instance to point them at (see
 *  payment-orchestrator-go/MIGRATION_NOTES.md's "sandbox constraint"
 *  section: that module has never even been compiled). getBackendConfig
 *  returning null is the expected, correct state until that changes;
 *  lib/backend-proxy.ts turns a null config into a clear 503, not a
 *  silent fallback to fake data — Live mode must never quietly behave
 *  like Sandbox mode. */
export interface BackendConfig {
  /** No trailing slash. */
  baseUrl: string;
  token: string;
}

export function getBackendConfig(): BackendConfig | null {
  const baseUrl = process.env.BACKEND_API_BASE_URL;
  const token = process.env.BACKEND_API_TOKEN;
  if (!baseUrl || !token) {
    return null;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}
