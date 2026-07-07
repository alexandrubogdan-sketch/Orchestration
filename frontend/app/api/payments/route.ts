import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** GET /api/payments — proxies to backend-go's GET /v1/payments
 *  (Bearer-authenticated, keyset-paginated). Query params (cursor,
 *  limit, customerId, state, createdAfter, createdBefore) pass through
 *  unchanged — see payment-orchestrator-go/internal/api/payments.go's
 *  parseListPaymentsQuery for the exact set backend-go accepts. */
export async function GET(request: NextRequest) {
  return proxyToBackend(request, "v1/payments");
}
