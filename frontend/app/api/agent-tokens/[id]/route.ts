import type { NextRequest } from "next/server";

import { proxyToBackend } from "@/lib/backend-proxy";

/** DELETE /api/agent-tokens/[id] — proxies to backend-go's DELETE
 *  /v1/agent-tokens/{id} (revoke; permanent, no "unrevoke"). */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyToBackend(request, `v1/agent-tokens/${encodeURIComponent(id)}`);
}
