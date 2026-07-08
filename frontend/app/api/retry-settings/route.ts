import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** GET/PUT /api/retry-settings — proxies to backend-go's GET/PUT
 *  /v1/retry-settings (Bearer-authenticated, scoped to the caller's
 *  merchant entity) — see
 *  payment-orchestrator-go/internal/api/retry_settings.go. GET returns
 *  the hardcoded defaults (24h/72h/168h ladder, 3 max attempts, 2s
 *  minimum spacing) until the merchant has called PUT at least once;
 *  PUT validates and upserts. Added 2026-07-08 to back
 *  app/workflows/retries/page.tsx's Live mode, mirroring
 *  app/api/payments/route.ts and app/api/customers/route.ts's
 *  established one-route-per-resource proxy pattern exactly. */
export async function GET(request: NextRequest) {
  return proxyToBackend(request, "v1/retry-settings");
}

export async function PUT(request: NextRequest) {
  return proxyToBackend(request, "v1/retry-settings");
}
