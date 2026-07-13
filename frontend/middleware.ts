import { NextResponse } from "next/server";

/** 2026-07-13: the shared-password Basic Auth gate this file used to
 *  enforce (added under Task #315, Stripe integration audit
 *  2026-07-12) has been removed at the user's explicit request — the
 *  dashboard is intentionally open with no password now.
 *
 *  Worth knowing if this ever needs to come back: this file's git
 *  history (the commit that introduced Task #315) has the original
 *  HTTP Basic Auth implementation, gated on a SITE_ACCESS_PASSWORD env
 *  var with the whole app protected except /checkout, /api/checkout,
 *  and /api/mcp (which must stay public for end-customer checkout and
 *  MCP agent access respectively). Restoring it is a revert of that
 *  commit, not a rewrite from scratch.
 */

export function middleware(): NextResponse {
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Run on every path EXCEPT Next.js internals and common static
     * assets. Kept even though the handler above is now a no-op, so
     * re-enabling a gate later doesn't also require rebuilding this
     * matcher.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
