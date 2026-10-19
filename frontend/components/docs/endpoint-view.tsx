import Link from "next/link";

import { CodeTabs } from "@/components/docs/code-tabs";
import { FieldList } from "@/components/docs/field-list";
import { MethodBadge } from "@/components/docs/method-badge";
import { curlSample, nodeSample, pythonSample, type ApiEndpoint } from "@/lib/api-reference";

export function EndpointView({ endpoint, previous, next }: { endpoint: ApiEndpoint; previous?: ApiEndpoint; next?: ApiEndpoint }) {
  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="min-w-0">
        <p className="mb-2 text-sm font-medium text-primary">{endpoint.group}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{endpoint.title}</h1>
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <MethodBadge method={endpoint.method} />
          <code className="font-mono text-sm text-foreground">{endpoint.path}</code>
        </div>
        <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-muted-foreground">{endpoint.summary}</p>
        <p className="mt-3 text-sm text-muted-foreground">
          Requires the <code className="font-mono text-foreground">{endpoint.scope}</code> scope
          {endpoint.idempotent ? (
            <>
              {" "}and an <Link href="/docs/api#idempotency" className="font-medium text-primary hover:underline">Idempotency-Key</Link> header
            </>
          ) : null}
          .
        </p>

        <div className="mt-8">
          {endpoint.pathParams ? <FieldList title="Path parameters" fields={endpoint.pathParams} /> : null}
          {endpoint.queryParams ? <FieldList title="Query parameters" fields={endpoint.queryParams} /> : null}
          {endpoint.bodyParams ? <FieldList title="Body parameters" fields={endpoint.bodyParams} /> : null}
          {endpoint.responseFields ? <FieldList title="Response" fields={endpoint.responseFields} /> : null}
          {endpoint.errors ? (
            <section className="mb-8">
              <h2 className="mb-2 text-base font-semibold text-foreground">Errors</h2>
              <dl className="divide-y divide-border border-y border-border">
                {endpoint.errors.map((error) => (
                  <div key={`${error.status}-${error.when}`} className="flex gap-4 py-3">
                    <dt className="w-10 shrink-0 font-mono text-sm font-semibold text-foreground">{error.status}</dt>
                    <dd className="text-sm leading-relaxed text-muted-foreground">{error.when}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">
                All errors use the same shape. See <Link href="/docs/api#errors" className="text-primary hover:underline">Errors</Link>.
              </p>
            </section>
          ) : null}
        </div>

        <nav aria-label="Endpoint pagination" className="mt-10 flex justify-between gap-4 border-t border-border pt-6 text-sm">
          {previous ? (
            <Link href={`/docs/api/${previous.slug}`} className="text-muted-foreground hover:text-foreground">
              <span className="block text-xs">Previous</span>
              <span className="font-medium text-foreground">{previous.title}</span>
            </Link>
          ) : <span />}
          {next ? (
            <Link href={`/docs/api/${next.slug}`} className="text-right text-muted-foreground hover:text-foreground">
              <span className="block text-xs">Next</span>
              <span className="font-medium text-foreground">{next.title}</span>
            </Link>
          ) : null}
        </nav>
      </div>

      <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-20 xl:self-start">
        <CodeTabs
          title="Request"
          samples={[
            { label: "cURL", code: curlSample(endpoint) },
            { label: "Node.js", code: nodeSample(endpoint) },
            { label: "Python", code: pythonSample(endpoint) },
          ]}
        />
        <CodeTabs
          title="Response"
          samples={[{ label: String(endpoint.responseStatus), code: JSON.stringify(endpoint.response, null, 2) }]}
        />
      </aside>
    </div>
  );
}
