import { NextResponse, type NextRequest } from "next/server";

import { getBackendConfig } from "./backend-config";

interface ProxyOptions {
  /** Set false for the two checkout-session routes that authenticate
   *  via the session's own client secret instead of a Bearer token
   *  (backend-go's GET /checkout/{id}/public and POST
   *  /checkout/{id}/confirm — see payment-orchestrator-go's
   *  checkout_sessions.go doc comment: these two routes are
   *  deliberately NOT mounted under backend-go's /v1 auth group).
   *  Defaults to true — every other route this app proxies to
   *  (checkout-sessions create, payments, customers) is Bearer-
   *  authenticated. */
  auth?: boolean;
}

/** The one place a browser-originated request is translated into a
 *  real call to backend-go — every app/api/* route handler in this app
 *  is a thin wrapper around this function. Holds BACKEND_API_TOKEN
 *  server-side (via getBackendConfig) and never returns it to the
 *  caller; forwards everything else (method, body, status code,
 *  response body) close to verbatim, so backend-go's own RFC 7807
 *  problem+json error shapes reach the frontend unchanged rather than
 *  being reshaped or swallowed here.
 *
 *  If BACKEND_API_BASE_URL/BACKEND_API_TOKEN aren't set (true today —
 *  see backend-config.ts's doc comment), responds 503 with a plain-
 *  English explanation rather than silently returning empty/fake data.
 *  Live mode having nothing real to call yet is an honest state to be
 *  in; quietly behaving like Sandbox mode would not be. */
export async function proxyToBackend(
  request: NextRequest,
  backendPath: string,
  options: ProxyOptions = {},
): Promise<NextResponse> {
  const config = getBackendConfig();
  if (!config) {
    return NextResponse.json(
      {
        title: "Live backend is not configured",
        detail:
          "BACKEND_API_BASE_URL and BACKEND_API_TOKEN are not set on this deployment. There is no live backend-go instance to call yet — switch back to Sandbox, or finish deploying backend-go and set both env vars.",
      },
      { status: 503 },
    );
  }

  const url = new URL(backendPath, `${config.baseUrl}/`);
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const headers = new Headers();
  const incomingContentType = request.headers.get("content-type");
  if (incomingContentType) {
    headers.set("content-type", incomingContentType);
  }
  if (options.auth !== false) {
    headers.set("authorization", `Bearer ${config.token}`);
  }
  // Forwarded as-is for the two client-secret-authenticated checkout
  // routes — backend-go reads this same header name
  // (checkout_sessions.go's handleGetPublicCheckoutSession) as a
  // fallback to the ?clientSecret= query param.
  const sessionSecret = request.headers.get("x-checkout-session-secret");
  if (sessionSecret) {
    headers.set("x-checkout-session-secret", sessionSecret);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let backendResponse: Response;
  try {
    backendResponse = await fetch(url, {
      method: request.method,
      headers,
      body: hasBody ? await request.text() : undefined,
      cache: "no-store",
    });
  } catch (err) {
    return NextResponse.json(
      {
        title: "Could not reach the live backend",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  const body = await backendResponse.text();
  return new NextResponse(body, {
    status: backendResponse.status,
    headers: {
      "content-type": backendResponse.headers.get("content-type") ?? "application/json",
    },
  });
}
