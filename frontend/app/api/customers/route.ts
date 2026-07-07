import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** GET /api/customers — proxies to backend-go's GET /v1/customers
 *  (Bearer-authenticated, keyset-paginated). This backend route was
 *  added 2026-07-07 specifically to back this page in Live mode — see
 *  payment-orchestrator-go/internal/api/customers.go's top doc comment
 *  and MIGRATION_NOTES.md's dated section. Its response only has
 *  id/externalRef/email/createdAt/updatedAt — no name/address/
 *  subscription fields, unlike Sandbox's mock data (the `customers`
 *  table has no such columns yet) — the Customers page's Live-mode
 *  rendering needs to account for that gap, not assume parity with
 *  Sandbox's richer mock shape. */
export async function GET(request: NextRequest) {
  return proxyToBackend(request, "v1/customers");
}
