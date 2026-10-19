import Link from "next/link";

import { CodeTabs } from "@/components/docs/code-tabs";
import { DocsHeader } from "@/components/docs/docs-header";
import { MethodBadge } from "@/components/docs/method-badge";
import { DocSection, InlineCode } from "@/components/docs/prose";
import { API_ENDPOINTS } from "@/lib/api-reference";

const SCOPES = [
  { scope: "*", grants: "Everything, including managing other keys." },
  { scope: "payments:read", grants: "Retrieve and list payments." },
  { scope: "payments:write", grants: "Create, capture, void and refund payments. Includes payments:read." },
  { scope: "customers:read", grants: "List customers' saved payment methods." },
  { scope: "customers:write", grants: "Reserved for customer updates. Includes customers:read." },
  { scope: "api_keys:read", grants: "List API keys." },
  { scope: "api_keys:write", grants: "Create and revoke API keys. Includes api_keys:read." },
];

const STATUSES = [
  { status: "400", meaning: "The request is malformed or a required header is missing. detail lists each invalid field." },
  { status: "401", meaning: "No API key, an unknown key, or a revoked key." },
  { status: "403", meaning: "The key is valid but lacks the scope this endpoint needs. title names the missing scope." },
  { status: "404", meaning: "The object does not exist in your account. Other accounts' objects also return 404." },
  { status: "409", meaning: "An idempotency conflict, or the payment is in a state that does not allow the action." },
  { status: "429", meaning: "A processor rate limit was hit. Back off and retry with the same Idempotency-Key." },
  { status: "5xx", meaning: "Something failed on our side. Retrying with the same Idempotency-Key is safe." },
];

export default function ApiIntroductionPage() {
  return (
    <div>
      <DocsHeader
        eyebrow="API reference"
        title="Introduction"
        description="A JSON REST API over HTTPS. Amounts are integers in minor units, timestamps are ISO 8601 in UTC, and IDs are UUIDs."
      />

      <DocSection id="base-url" title="Base URL">
        <p>
          All endpoints live under <InlineCode>/v1</InlineCode> on your API host. Sandbox and live use separate
          deployments and separate keys. The machine-readable OpenAPI spec is served at{" "}
          <InlineCode>/docs/json</InlineCode> on the same host, ready to import into Postman or a code generator.
        </p>
      </DocSection>

      <DocSection id="authentication" title="Authentication & scopes">
        <p>
          Send your secret key as a bearer token. Create keys in{" "}
          <Link href="/developers" className="font-medium text-primary hover:underline">Developers</Link>, and keep them on
          your servers only.
        </p>
        <CodeTabs samples={[{ label: "HTTP", code: `Authorization: Bearer po_3f9a1c2e7b4d8e6f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d` }]} />
        <p>
          Each key carries scopes. Reads need <InlineCode>:read</InlineCode>, everything that changes data needs{" "}
          <InlineCode>:write</InlineCode>, and a write scope always includes the matching read scope. A key missing a
          scope gets a 403 that names the scope it needs.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-foreground">
                <th className="py-2 pr-6 font-semibold">Scope</th>
                <th className="py-2 font-semibold">Grants</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {SCOPES.map((row) => (
                <tr key={row.scope}>
                  <td className="py-2.5 pr-6 align-top"><InlineCode>{row.scope}</InlineCode></td>
                  <td className="py-2.5">{row.grants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DocSection>

      <DocSection id="idempotency" title="Idempotency">
        <p>
          Every request that moves money requires an <InlineCode>Idempotency-Key</InlineCode> header. Use a value tied to
          the business action, such as the order ID. Sending the same key with the same body returns the original
          response without charging again, and the response carries <InlineCode>Idempotent-Replayed: true</InlineCode>.
          Reusing a key with a different body returns 409.
        </p>
        <p>
          Keys are scoped to your product and kept for 24 hours, so two of your products can safely use the same order
          numbers.
        </p>
      </DocSection>

      <DocSection id="errors" title="Errors">
        <p>
          Errors follow RFC 9457 problem details with content type <InlineCode>application/problem+json</InlineCode>.
        </p>
        <CodeTabs
          samples={[
            {
              label: "403",
              code: JSON.stringify(
                { type: "about:blank", title: "This API key is missing the payments:write scope", status: 403 },
                null,
                2,
              ),
            },
            {
              label: "400",
              code: JSON.stringify(
                { type: "about:blank", title: "Validation failed", status: 400, detail: "amount.currency: String must contain exactly 3 character(s)" },
                null,
                2,
              ),
            },
          ]}
        />
        <dl className="divide-y divide-border border-y border-border">
          {STATUSES.map((row) => (
            <div key={row.status} className="flex gap-4 py-2.5">
              <dt className="w-10 shrink-0 font-mono text-sm font-semibold text-foreground">{row.status}</dt>
              <dd className="text-sm">{row.meaning}</dd>
            </div>
          ))}
        </dl>
      </DocSection>

      <DocSection id="pagination" title="Pagination">
        <p>
          List endpoints return a <InlineCode>data</InlineCode> array and a <InlineCode>pagination</InlineCode> object.
          While <InlineCode>hasMore</InlineCode> is true, pass <InlineCode>nextCursor</InlineCode> as the{" "}
          <InlineCode>cursor</InlineCode> query parameter to get the next page. Results are newest first.
        </p>
      </DocSection>

      <DocSection id="endpoints" title="Endpoints">
        <ul className="divide-y divide-border border-y border-border">
          {API_ENDPOINTS.map((endpoint) => (
            <li key={endpoint.slug}>
              <Link href={`/docs/api/${endpoint.slug}`} className="flex items-center gap-3 py-2.5 hover:text-foreground">
                <MethodBadge method={endpoint.method} className="w-14 justify-center" />
                <code className="font-mono text-[13px] text-foreground">{endpoint.path}</code>
                <span className="ml-auto hidden text-sm sm:block">{endpoint.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </DocSection>
    </div>
  );
}
