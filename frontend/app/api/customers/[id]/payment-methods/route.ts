import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** GET /api/customers/[id]/payment-methods — proxies to backend-go's
 *  GET /v1/customers/{id}/payment-methods (Bearer-authenticated). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToBackend(request, `v1/customers/${encodeURIComponent(id)}/payment-methods`);
}
