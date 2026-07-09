import { randomUUID } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { callBackend } from "@/lib/mcp/backend-client";
import { backendResult, MISSING_TOKEN_RESULT, runTool } from "@/lib/mcp/tool-helpers";

/** Alpha Payments' MCP (Model Context Protocol) server — lets an MCP
 *  client (Claude, or any other MCP-speaking agent) research and act on
 *  a merchant's own payments data: list/inspect payments, capture/void/
 *  refund a payment, list/inspect subscriptions, cancel a subscription,
 *  and look up a customer's saved payment methods.
 *
 *  Transport: Streamable HTTP (the MCP spec's current recommended
 *  transport), stateless — no session tracking, one request in, one
 *  JSON-RPC response out, which is exactly the shape a Vercel
 *  serverless function wants. Built on Vercel's own `mcp-handler`
 *  package rather than wiring @modelcontextprotocol/sdk's
 *  StreamableHTTPServerTransport by hand: that transport's
 *  `handleRequest(req, res, body)` expects Node's raw
 *  IncomingMessage/ServerResponse, which a Next.js App Router Route
 *  Handler does not give you (it deals in Fetch API Request/Response
 *  instead) — mcp-handler is Vercel's own adapter that bridges exactly
 *  that gap, so this route needed no bespoke Node-http shim.
 *
 *  Auth: every tool call must carry a real Alpha Payments agent token
 *  (see app/agents/page.tsx and payment-orchestrator-go's
 *  internal/api/agent_tokens.go) as a Bearer token — verifyToken below
 *  only checks that a token is PRESENT, not that it's valid; real
 *  verification and scoping (which merchant/product it belongs to,
 *  read_only vs read_write) happens entirely on backend-go's side, the
 *  moment a tool forwards that token to a real /v1/* call
 *  (lib/mcp/backend-client.ts). A bad or read_only-on-a-mutating-call
 *  token surfaces as that same call's normal 401/403 problem+json body,
 *  not a special case here — this route deliberately does not
 *  duplicate any authorization decision backend-go already makes.
 *
 *  basePath is "/api" to match this file's own app/api/[transport]
 *  location, so the live endpoint is POST .../api/mcp. */

const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;
  return { token: bearerToken, clientId: "alpha-payments-agent", scopes: [] };
};

const moneyShape = {
  amountMinorUnits: z
    .number()
    .int()
    .positive()
    .describe("Amount in the currency's smallest unit (e.g. cents for USD)."),
  currency: z.string().length(3).describe("ISO 4217 currency code, e.g. USD."),
};

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_payments",
      {
        title: "List payments",
        description:
          "List payments for the authenticated merchant, optionally filtered by customer, state, or a creation-date range. Use this to research a customer's payment history before taking action.",
        inputSchema: {
          customerId: z.string().optional().describe("Only payments for this customer id."),
          state: z
            .string()
            .optional()
            .describe("Only payments in this state, e.g. settled, declined, refunded, voided."),
          createdAfter: z.string().optional().describe("ISO 8601 timestamp; only payments created after this."),
          createdBefore: z.string().optional().describe("ISO 8601 timestamp; only payments created before this."),
          cursor: z.string().optional().describe("Pagination cursor from a previous call's nextCursor."),
          limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100. Defaults to 20."),
        },
      },
      async (args, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(args)) {
            if (value !== undefined) params.set(key, String(value));
          }
          const query = params.toString();
          return backendResult(await callBackend(token, "GET", `v1/payments${query ? `?${query}` : ""}`));
        }),
    );

    server.registerTool(
      "get_payment",
      {
        title: "Get payment",
        description:
          "Get full detail on one payment by id, including its capture/void/refund attempt history and event timeline.",
        inputSchema: {
          paymentId: z.string().describe("The payment id, e.g. from list_payments."),
        },
      },
      async ({ paymentId }, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          return backendResult(await callBackend(token, "GET", `v1/payments/${encodeURIComponent(paymentId)}`));
        }),
    );

    server.registerTool(
      "capture_payment",
      {
        title: "Capture payment",
        description:
          "Capture a previously authorized (manual capture) payment. Requires a read_write-scoped agent token; a read_only token gets a 403 from the backend.",
        inputSchema: {
          paymentId: z.string().describe("The payment id to capture."),
        },
      },
      async ({ paymentId }, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          return backendResult(
            await callBackend(token, "POST", `v1/payments/${encodeURIComponent(paymentId)}/capture`, {
              idempotencyKey: randomUUID(),
            }),
          );
        }),
    );

    server.registerTool(
      "void_payment",
      {
        title: "Void payment",
        description:
          "Void a payment that has not yet been captured/settled. Requires a read_write-scoped agent token; a read_only token gets a 403 from the backend.",
        inputSchema: {
          paymentId: z.string().describe("The payment id to void."),
        },
      },
      async ({ paymentId }, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          return backendResult(
            await callBackend(token, "POST", `v1/payments/${encodeURIComponent(paymentId)}/void`, {
              idempotencyKey: randomUUID(),
            }),
          );
        }),
    );

    server.registerTool(
      "refund_payment",
      {
        title: "Refund payment",
        description:
          "Refund a settled payment, in full or in part. Omit amountMinorUnits/currency to refund the full original amount. This is the tool a customer-service agent should call to resolve a refund request. Requires a read_write-scoped agent token; a read_only token gets a 403 from the backend.",
        inputSchema: {
          paymentId: z.string().describe("The payment id to refund."),
          amountMinorUnits: moneyShape.amountMinorUnits.optional(),
          currency: moneyShape.currency.optional(),
        },
      },
      async ({ paymentId, amountMinorUnits, currency }, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          if ((amountMinorUnits === undefined) !== (currency === undefined)) {
            return backendResult({
              status: 400,
              body: { title: "amountMinorUnits and currency must both be provided, or both omitted." },
            });
          }
          const body =
            amountMinorUnits !== undefined && currency !== undefined
              ? { amount: { minorUnits: amountMinorUnits, currency } }
              : undefined;
          return backendResult(
            await callBackend(token, "POST", `v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
              body,
              idempotencyKey: randomUUID(),
            }),
          );
        }),
    );

    server.registerTool(
      "list_customers",
      {
        title: "List customers",
        description: "List customers for the authenticated merchant.",
        inputSchema: {
          cursor: z.string().optional().describe("Pagination cursor from a previous call's nextCursor."),
          limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100. Defaults to 20."),
        },
      },
      async (args, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(args)) {
            if (value !== undefined) params.set(key, String(value));
          }
          const query = params.toString();
          return backendResult(await callBackend(token, "GET", `v1/customers${query ? `?${query}` : ""}`));
        }),
    );

    server.registerTool(
      "list_customer_payment_methods",
      {
        title: "List customer payment methods",
        description: "List a customer's active saved payment methods (card brand/last4, type).",
        inputSchema: {
          customerId: z.string().describe("The customer id, e.g. from list_customers or a payment's customerId."),
        },
      },
      async ({ customerId }, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          return backendResult(
            await callBackend(token, "GET", `v1/customers/${encodeURIComponent(customerId)}/payment-methods`),
          );
        }),
    );

    server.registerTool(
      "list_subscriptions",
      {
        title: "List subscriptions",
        description:
          "List subscriptions for the authenticated merchant, optionally filtered by customer. Use this to find a subscription id before calling cancel_subscription.",
        inputSchema: {
          customerId: z.string().optional().describe("Only subscriptions for this customer id."),
        },
      },
      async ({ customerId }, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          const query = customerId ? `?customerId=${encodeURIComponent(customerId)}` : "";
          return backendResult(await callBackend(token, "GET", `v1/subscriptions${query}`));
        }),
    );

    server.registerTool(
      "get_subscription",
      {
        title: "Get subscription",
        description: "Get one subscription's full detail by id, including billing amount, interval, and cancellation status.",
        inputSchema: {
          subscriptionId: z.string().describe("The subscription id, e.g. from list_subscriptions."),
        },
      },
      async ({ subscriptionId }, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          return backendResult(
            await callBackend(token, "GET", `v1/subscriptions/${encodeURIComponent(subscriptionId)}`),
          );
        }),
    );

    server.registerTool(
      "cancel_subscription",
      {
        title: "Cancel subscription",
        description:
          "Cancel a subscription. This is the tool a customer-service agent should call to resolve a cancellation request. Requires a read_write-scoped agent token; a read_only token gets a 403 from the backend.",
        inputSchema: {
          subscriptionId: z.string().describe("The subscription id to cancel."),
          reason: z.string().optional().describe('Free-text cancel reason. Defaults to "canceled via API".'),
        },
      },
      async ({ subscriptionId, reason }, extra) =>
        runTool(async () => {
          const token = extra.authInfo?.token;
          if (!token) return MISSING_TOKEN_RESULT;
          return backendResult(
            await callBackend(token, "POST", `v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
              body: reason ? { reason } : undefined,
            }),
          );
        }),
    );
  },
  {},
  {
    basePath: "/api",
    maxDuration: 60,
  },
);

const authHandler = withMcpAuth(handler, verifyToken, { required: true });

export { authHandler as GET, authHandler as POST };
