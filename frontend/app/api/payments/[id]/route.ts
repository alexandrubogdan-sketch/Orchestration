import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** GET /api/payments/[id] — proxies to backend-go's
 *  GET /v1/payments/{id} (Bearer-authenticated). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToBackend(request, `v1/payments/${encodeURIComponent(id)}`);
}
