export type HttpMethod = "GET" | "POST" | "DELETE";

export interface ApiField {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

export interface ApiEndpoint {
  slug: string;
  group: string;
  title: string;
  method: HttpMethod;
  path: string;
  scope: string;
  summary: string;
  idempotent?: boolean;
  pathParams?: ApiField[];
  queryParams?: ApiField[];
  bodyParams?: ApiField[];
  requestBody?: Record<string, unknown>;
  responseStatus: number;
  response: unknown;
  responseFields?: ApiField[];
  errors?: { status: number; when: string }[];
}

const PAYMENT_ID = "01929c4e-5b7a-7c1e-9f3a-2d8e6b4a1c90";
const CUSTOMER_ID = "01929c4e-5b70-7a11-8b2c-4f6e9d3a7b10";

const payment = {
  id: PAYMENT_ID,
  productId: "01929c4d-1a20-7e55-a1b2-c3d4e5f60718",
  customerId: CUSTOMER_ID,
  amount: { minorUnits: 1999, currency: "USD" },
  state: "captured",
  citMit: "cit",
  createdAt: "2026-10-19T09:12:44.120Z",
  updatedAt: "2026-10-19T09:12:45.903Z",
};

const paymentFields: ApiField[] = [
  { name: "id", type: "string (uuid)", description: "Unique payment ID. Use it for every follow-up call." },
  { name: "productId", type: "string (uuid)", description: "Product the API key belongs to." },
  { name: "customerId", type: "string (uuid)", description: "Customer the payment is charged to." },
  { name: "amount.minorUnits", type: "integer", description: "Amount in the currency's smallest unit. 1999 USD is $19.99." },
  { name: "amount.currency", type: "string", description: "Three-letter ISO 4217 code." },
  { name: "state", type: "enum", description: "Current state. See Payment states in the Payments guide." },
  { name: "citMit", type: "enum", description: "cit for customer-initiated, mit for merchant-initiated (renewals)." },
  { name: "createdAt", type: "string (ISO 8601)", description: "When the payment was created." },
  { name: "updatedAt", type: "string (ISO 8601)", description: "When the payment last changed state." },
];

const idParam: ApiField[] = [{ name: "id", type: "string (uuid)", required: true, description: "The payment ID." }];

const apiKey = {
  id: "01929c50-0a41-7d3e-b6f2-8a9c1e4d2b77",
  name: "Finance reporting",
  prefix: "po_3f9a1c2e",
  scopes: ["payments:read", "customers:read"],
  createdAt: "2026-10-19T09:20:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

export const API_ENDPOINTS: ApiEndpoint[] = [
  {
    slug: "create-payment",
    group: "Payments",
    title: "Create a payment",
    method: "POST",
    path: "/v1/payments",
    scope: "payments:write",
    idempotent: true,
    summary:
      "Charges a payment method through the processor your routing rules pick. If the processor is unavailable, routing falls back to the next healthy one. The response comes back once the processor has answered.",
    bodyParams: [
      { name: "amount.minorUnits", type: "integer", required: true, description: "Amount in the smallest currency unit." },
      { name: "amount.currency", type: "string", required: true, description: "Three-letter ISO 4217 code, for example USD." },
      { name: "paymentMethodRef", type: "string", required: true, description: "Processor payment method token, for example a Stripe pm_ ID from the Checkout SDK." },
      { name: "customerId", type: "string (uuid)", description: "Existing customer. Required unless you send customerEmail." },
      { name: "customerEmail", type: "string", description: "Finds or creates the customer by email. Required unless you send customerId." },
      { name: "citMit", type: "enum", description: "cit (default) when the customer is present, mit for renewals and other merchant-initiated charges." },
      { name: "captureMethod", type: "enum", description: "automatic (default) captures straight away. manual stops at authorized so you can capture later." },
    ],
    requestBody: {
      customerEmail: "jane@example.com",
      amount: { minorUnits: 1999, currency: "USD" },
      paymentMethodRef: "pm_1Q2w3E4r5T6y7U8i",
      captureMethod: "automatic",
    },
    responseStatus: 201,
    response: payment,
    responseFields: [
      ...paymentFields,
      { name: "clientSecret", type: "string", description: "Only present when the customer must complete 3-D Secure. Pass it to the Checkout SDK." },
    ],
    errors: [
      { status: 400, when: "The body is invalid or the Idempotency-Key header is missing." },
      { status: 404, when: "customerId does not belong to your account." },
      { status: 409, when: "The Idempotency-Key was already used with a different body, or that request is still running." },
      { status: 429, when: "The processor's rate limit was reached. Retry with backoff." },
    ],
  },
  {
    slug: "retrieve-payment",
    group: "Payments",
    title: "Retrieve a payment",
    method: "GET",
    path: "/v1/payments/{id}",
    scope: "payments:read",
    summary: "Returns a payment with every processor attempt and its full timeline of events.",
    pathParams: idParam,
    responseStatus: 200,
    response: {
      ...payment,
      attempts: [{ attemptNumber: 1, status: "captured", createdAt: "2026-10-19T09:12:44.512Z" }],
      timeline: [
        { event: "started", occurredAt: "2026-10-19T09:12:44.130Z" },
        { event: "authorized", occurredAt: "2026-10-19T09:12:45.401Z" },
        { event: "captured", occurredAt: "2026-10-19T09:12:45.903Z" },
      ],
    },
    responseFields: [
      ...paymentFields,
      { name: "attempts[]", type: "array", description: "One entry per processor attempt, oldest first." },
      { name: "timeline[]", type: "array", description: "Stable event names such as started, authorized, captured, declined, refunded." },
    ],
    errors: [{ status: 404, when: "No payment with this ID exists in your account." }],
  },
  {
    slug: "list-payments",
    group: "Payments",
    title: "List payments",
    method: "GET",
    path: "/v1/payments",
    scope: "payments:read",
    summary: "Returns your payments, newest first. Results are paginated with a cursor.",
    queryParams: [
      { name: "limit", type: "integer", description: "1 to 100. Defaults to 20." },
      { name: "cursor", type: "string (uuid)", description: "nextCursor from the previous page." },
      { name: "customerId", type: "string (uuid)", description: "Only this customer's payments." },
      { name: "state", type: "string", description: "Only payments in this state, for example captured." },
      { name: "createdAfter", type: "string (ISO 8601)", description: "Created at or after this time." },
      { name: "createdBefore", type: "string (ISO 8601)", description: "Created at or before this time." },
    ],
    responseStatus: 200,
    response: { data: [payment], pagination: { hasMore: true, nextCursor: PAYMENT_ID } },
    responseFields: [
      { name: "data[]", type: "array", description: "Payment objects." },
      { name: "pagination.hasMore", type: "boolean", description: "Whether another page exists." },
      { name: "pagination.nextCursor", type: "string | null", description: "Pass as cursor to fetch the next page." },
    ],
  },
  {
    slug: "capture-payment",
    group: "Payments",
    title: "Capture a payment",
    method: "POST",
    path: "/v1/payments/{id}/capture",
    scope: "payments:write",
    idempotent: true,
    summary: "Captures a payment created with captureMethod manual. Only payments in the authorized state can be captured.",
    pathParams: idParam,
    responseStatus: 200,
    response: { ...payment, state: "captured" },
    responseFields: paymentFields,
    errors: [
      { status: 404, when: "No payment with this ID exists in your account." },
      { status: 409, when: "The payment is not in the authorized state." },
    ],
  },
  {
    slug: "void-payment",
    group: "Payments",
    title: "Void a payment",
    method: "POST",
    path: "/v1/payments/{id}/void",
    scope: "payments:write",
    idempotent: true,
    summary: "Releases an authorization without charging the customer. Use it instead of a refund when the payment is not captured yet.",
    pathParams: idParam,
    responseStatus: 200,
    response: { ...payment, state: "voided" },
    responseFields: paymentFields,
    errors: [{ status: 409, when: "The payment was already captured. Refund it instead." }],
  },
  {
    slug: "refund-payment",
    group: "Payments",
    title: "Refund a payment",
    method: "POST",
    path: "/v1/payments/{id}/refunds",
    scope: "payments:write",
    idempotent: true,
    summary: "Refunds a captured payment in full, or partially when you send an amount. You can issue several partial refunds.",
    pathParams: idParam,
    bodyParams: [
      { name: "amount.minorUnits", type: "integer", description: "Amount to refund. Leave out the amount to refund the remaining balance." },
      { name: "amount.currency", type: "string", description: "Must match the payment's currency." },
    ],
    requestBody: { amount: { minorUnits: 500, currency: "USD" } },
    responseStatus: 200,
    response: { ...payment, state: "refund_pending" },
    responseFields: paymentFields,
    errors: [{ status: 409, when: "The payment is not captured, or the amount exceeds what is left to refund." }],
  },
  {
    slug: "list-payment-methods",
    group: "Customers",
    title: "List a customer's payment methods",
    method: "GET",
    path: "/v1/customers/{id}/payment-methods",
    scope: "customers:read",
    summary: "Returns the active saved payment methods for a customer. Card details are limited to brand and last four digits.",
    pathParams: [{ name: "id", type: "string (uuid)", required: true, description: "The customer ID." }],
    responseStatus: 200,
    response: {
      data: [
        { id: "01929c4e-6c11-7f20-9a3b-5e7d1c2b8a44", type: "card", cardBrand: "visa", cardLast4: "4242", isActive: true, createdAt: "2026-10-19T09:12:44.300Z" },
      ],
    },
    responseFields: [
      { name: "data[].id", type: "string (uuid)", description: "Payment method ID." },
      { name: "data[].type", type: "string", description: "card today. More types arrive with new adapters." },
      { name: "data[].cardBrand", type: "string | null", description: "visa, mastercard, amex and so on." },
      { name: "data[].cardLast4", type: "string | null", description: "Last four digits." },
    ],
    errors: [{ status: 404, when: "No customer with this ID exists in your account." }],
  },
  {
    slug: "create-api-key",
    group: "API keys",
    title: "Create an API key",
    method: "POST",
    path: "/v1/api-keys",
    scope: "api_keys:write",
    summary: "Creates a key with the scopes you choose. The secret is returned in this response only. Store it straight away.",
    bodyParams: [
      { name: "name", type: "string", required: true, description: "A label you will recognise later, up to 100 characters." },
      { name: "scopes", type: "string[]", required: true, description: "One or more of *, payments:read, payments:write, customers:read, customers:write, api_keys:read, api_keys:write." },
    ],
    requestBody: { name: "Finance reporting", scopes: ["payments:read", "customers:read"] },
    responseStatus: 201,
    response: { ...apiKey, secret: "po_3f9a1c2e7b4d8e6f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d" },
    responseFields: [
      { name: "id", type: "string (uuid)", description: "Key ID, used to revoke it." },
      { name: "prefix", type: "string", description: "First characters of the secret, safe to display." },
      { name: "scopes", type: "string[]", description: "What the key can do." },
      { name: "secret", type: "string", description: "The full key. Never returned again." },
    ],
    errors: [{ status: 400, when: "The name is empty or a scope is not recognised." }],
  },
  {
    slug: "list-api-keys",
    group: "API keys",
    title: "List API keys",
    method: "GET",
    path: "/v1/api-keys",
    scope: "api_keys:read",
    summary: "Returns every key for your product, including revoked ones, newest first. Secrets are never included.",
    responseStatus: 200,
    response: { data: [apiKey] },
    responseFields: [
      { name: "data[].lastUsedAt", type: "string | null", description: "Last successful request, accurate to about a minute." },
      { name: "data[].revokedAt", type: "string | null", description: "Set once the key is revoked." },
    ],
  },
  {
    slug: "revoke-api-key",
    group: "API keys",
    title: "Revoke an API key",
    method: "DELETE",
    path: "/v1/api-keys/{id}",
    scope: "api_keys:write",
    summary: "Revokes a key immediately. Requests that use it get 401 from then on.",
    pathParams: [{ name: "id", type: "string (uuid)", required: true, description: "The key ID." }],
    responseStatus: 200,
    response: { ...apiKey, revokedAt: "2026-10-19T10:02:11.000Z" },
    errors: [{ status: 404, when: "The key does not exist or is already revoked." }],
  },
];

export function findEndpoint(slug: string): ApiEndpoint | undefined {
  return API_ENDPOINTS.find((endpoint) => endpoint.slug === slug);
}

function fillPath(path: string): string {
  return path.replace("{id}", PAYMENT_ID);
}

export function curlSample(endpoint: ApiEndpoint): string {
  const lines = [`curl -X ${endpoint.method} "$ALPHA_API_URL${fillPath(endpoint.path)}"`, `  -H "Authorization: Bearer $ALPHA_API_KEY"`];
  if (endpoint.idempotent) lines.push(`  -H "Idempotency-Key: order_8841_attempt_1"`);
  if (endpoint.requestBody) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${JSON.stringify(endpoint.requestBody, null, 2).replace(/\n/g, "\n  ")}'`);
  }
  return lines.join(" \\\n");
}

export function nodeSample(endpoint: ApiEndpoint): string {
  const options = [
    `  method: "${endpoint.method}",`,
    "  headers: {",
    "    Authorization: `Bearer ${process.env.ALPHA_API_KEY}`,",
    ...(endpoint.idempotent ? [`    "Idempotency-Key": "order_8841_attempt_1",`] : []),
    ...(endpoint.requestBody ? [`    "Content-Type": "application/json",`] : []),
    "  },",
    ...(endpoint.requestBody ? [`  body: JSON.stringify(${JSON.stringify(endpoint.requestBody, null, 2).replace(/\n/g, "\n  ")}),`] : []),
  ];
  return [
    `const response = await fetch(\`\${process.env.ALPHA_API_URL}${fillPath(endpoint.path)}\`, {`,
    ...options,
    "});",
    "const data = await response.json();",
  ].join("\n");
}

export function pythonSample(endpoint: ApiEndpoint): string {
  const headers = [
    `    "Authorization": f"Bearer {os.environ['ALPHA_API_KEY']}",`,
    ...(endpoint.idempotent ? [`    "Idempotency-Key": "order_8841_attempt_1",`] : []),
  ];
  const body = endpoint.requestBody
    ? `,\n    json=${JSON.stringify(endpoint.requestBody, null, 4).replace(/\n/g, "\n    ").replace(/true/g, "True").replace(/false/g, "False").replace(/null/g, "None")}`
    : "";
  return [
    "import os",
    "import requests",
    "",
    `response = requests.${endpoint.method.toLowerCase()}(`,
    `    f"{os.environ['ALPHA_API_URL']}${fillPath(endpoint.path)}",`,
    "    headers={",
    ...headers.map((h) => `    ${h}`),
    `    }${body},`,
    ")",
    "data = response.json()",
  ].join("\n");
}
