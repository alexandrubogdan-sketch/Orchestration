import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** POST /api/checkout/[id]/confirm — proxies to backend-go's
 *  POST /checkout/{id}/confirm. Same client-secret authentication as
 *  the sibling public/route.ts — see that file's doc comment. This is
 *  the call that actually charges the card once the SDK has tokenized
 *  a payment method. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToBackend(request, `checkout/${encodeURIComponent(id)}/confirm`, { auth: false });
}
