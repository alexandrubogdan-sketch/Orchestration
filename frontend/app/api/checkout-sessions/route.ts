import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** POST /api/checkout-sessions — proxies to backend-go's
 *  POST /v1/checkout-sessions (Bearer-authenticated; the merchant's own
 *  server creates a checkout session, not the end user's browser). See
 *  payment-orchestrator-go/internal/api/checkout_sessions.go. */
export async function POST(request: NextRequest) {
  return proxyToBackend(request, "v1/checkout-sessions");
}
