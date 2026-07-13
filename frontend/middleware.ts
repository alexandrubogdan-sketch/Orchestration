import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Stripe integration audit (2026-07-12), Task #315 — this frontend has
 *  zero authentication of its own today: anyone with the URL can open
 *  the dashboard, view every customer's PII, and (once Live mode is
 *  wired to a real backend) trigger real captures/refunds. The user's
 *  explicit instruction for this pass was the fastest option that ships
 *  today — a single shared password gating the whole app — not a real
 *  per-user identity provider (Clerk/NextAuth), which is real, deferred
 *  scope, not something to half-build here.
 *
 *  Mechanism: HTTP Basic Auth, checked in middleware before any route
 *  handler or page runs. Chosen over a custom login page + session
 *  cookie specifically because it needs no new page, no session store,
 *  and no client-side state — the browser's own native credential
 *  prompt (and its own remembered-credentials autofill) does all of
 *  that for free. The username is not checked at all (any value is
 *  accepted); only the password is compared, against SITE_ACCESS_PASSWORD.
 *
 *  NOT gated, and why:
 *   - /checkout — the embeddable checkout page itself. Its whole point
 *     is that an END CUSTOMER (who has never heard of this admin
 *     dashboard and has no shared password) opens it, embedded in the
 *     merchant's own site, to enter a card. Gating it would break every
 *     checkout.
 *   - /api/checkout/* — the public checkout-session Route Handlers
 *     (GET .../public, POST .../confirm) the checkout page above calls
 *     directly from the customer's own browser session — same reasoning.
 *   - /api/mcp — the MCP server route (app/api/[transport]/route.ts).
 *     Callers here are MCP clients (Claude, etc.) sending a Bearer
 *     agent token, not a browser with Basic-Auth credentials on file;
 *     forcing Basic Auth here would break every MCP integration and
 *     duplicate an authorization decision internal/api/agent_tokens.go
 *     already makes correctly on the backend. See that route's own top
 *     doc comment.
 *   - Next.js internals / static assets (_next, favicon.ico, etc.) —
 *     excluded via this file's `config.matcher` below, not via the
 *     early-return list, so they never even reach this function.
 *
 *  FAIL-CLOSED IF UNCONFIGURED: if SITE_ACCESS_PASSWORD is unset, every
 *  gated request is rejected (401) rather than the gate silently
 *  opening — an accidental missing env var in a real deploy must never
 *  be equivalent to "no password required," which is the opposite of
 *  this feature's entire purpose.
 */

const PUBLIC_PATH_PREFIXES = ["/checkout", "/api/checkout", "/api/mcp"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Alpha Payments", charset="UTF-8"' },
  });
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const sitePassword = process.env.SITE_ACCESS_PASSWORD;
  if (!sitePassword) {
    // Fail closed — see this file's top doc comment.
    return unauthorized();
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return unauthorized();
  }

  let decoded: string;
  try {
    decoded = atob(authHeader.slice("Basic ".length));
  } catch {
    return unauthorized();
  }

  // decoded is "username:password" — the username is intentionally
  // ignored (see this file's top doc comment); only everything after
  // the first colon is compared.
  const separatorIndex = decoded.indexOf(":");
  const suppliedPassword = separatorIndex === -1 ? decoded : decoded.slice(separatorIndex + 1);

  if (suppliedPassword !== sitePassword) {
    return unauthorized();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Run on every path EXCEPT Next.js internals and common static
     * assets — those never need to reach the check above at all.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
