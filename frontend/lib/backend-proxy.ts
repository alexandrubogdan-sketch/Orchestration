import { NextResponse, type NextRequest } from "next/server";

import { getBackendConfig } from "./backend-config";

interface ProxyOptions {
  auth?: boolean;
}

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
          "BACKEND_API_BASE_URL and BACKEND_API_TOKEN are not set on this deployment. Set both to the deployed backend and an API key with the right scopes, or switch back to Sandbox.",
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
