import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** POST /api/customers/[id]/billing-portal-session — proxies to
 *  backend-go's POST /v1/customers/{id}/billing-portal-session
 *  (Bearer-authenticated). See that route's own top doc comment
 *  (internal/api/billing_portal.go) for what this does and its scope —
 *  only customers with a Stripe customer_psp_refs row get a session;
 *  everyone else gets a 404 the button below surfaces as an error
 *  message rather than a broken redirect. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToBackend(request, `v1/customers/${encodeURIComponent(id)}/billing-portal-session`);
}
