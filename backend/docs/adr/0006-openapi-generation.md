# ADR-0006: OpenAPI generation for the Milestone 4 API

## Status

Accepted — flagged for review (new dependencies beyond the fixed stack)

## Context

T4.2 requires the `/v1/*` API surface to be "OpenAPI generated." The
fixed stack doesn't name an OpenAPI tool, and SPEC.md's working
agreement says to ask before adding a new dependency.

## Decision

Add three packages, all official/first-party to tools already in the
stack:

- `@fastify/swagger` — generates an OpenAPI 3 document from Fastify
  route schemas at runtime (official Fastify ecosystem plugin).
- `@fastify/swagger-ui` — serves that document as interactive docs at
  `GET /docs`.
- `zod-to-json-schema` — converts the Zod validators the routes already
  use (T4.2: "all Zod-validated") into the JSON Schema `@fastify/swagger`
  needs, so the OpenAPI document is generated FROM the same validators
  that enforce requests at runtime, not hand-maintained separately and
  liable to drift.

## Rationale

- Zod is already in the fixed stack for boundary validation
  (Non-negotiable-adjacent stack rule). Reusing the same schemas for
  documentation means one source of truth instead of two things that
  can silently disagree.
- `@fastify/swagger`/`@fastify/swagger-ui` are maintained by the
  Fastify core team, the same team that owns the `fastify` package
  itself — not a random third-party dependency.
- The alternative (hand-writing a static OpenAPI YAML/JSON file) fails
  "generated," per T4.2's own wording, on day one.

## Consequences

- Every route that should appear in the docs needs its Zod schemas
  attached via Fastify's `schema` option (src/api/openapi.ts converts
  them); a route added without this is still fully functional but
  invisible in `/docs` — a discipline issue to catch in review, not
  something enforced by tooling yet.
- Three more dependencies to keep patched (`npm audit`, T7.6).
