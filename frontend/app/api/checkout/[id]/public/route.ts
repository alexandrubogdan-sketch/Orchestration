import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** GET /api/checkout/[id]/public — proxies to backend-go's
 *  GET /checkout/{id}/public. NOT Bearer-authenticated on either side:
 *  the caller is the end user's browser, authenticated via the
 *  checkout session's own client secret (?clientSecret= or the
 *  X-Checkout-Session-Secret header — proxyToBackend forwards both),
 *  matching backend-go's own routing (that route is deliberately
 *  mounted outside its /v1 Bearer-auth group — see
 *  checkout_sessions.go's registerPublicCheckoutSessionRoutes doc
 *  comment). Proxying anyway (rather than having the SDK call
 *  backend-go directly) keeps CORS and the backend's base URL entirely
 *  server-side. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToBackend(request, `checkout/${encodeURIComponent(id)}/public`, { auth: false });
}
