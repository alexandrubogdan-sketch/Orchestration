# Payment Orchestrator — Frontend

Internal dashboard for the payment orchestrator backend (see `../backend`
in this repo). Built per `backend/docs/design.md` §1, informed by
research into Primer, Yuno, Solidgate, and PayNext's dashboard/routing
UX.

## Stack

Next.js 16 (App Router) + TypeScript + Tailwind CSS v4, `@xyflow/react`
(React Flow v12) for the workflow builder canvas, Zustand for the
workflow builder's editable state, Recharts for the dashboard chart,
lucide-react for icons — matching the stack used by
[reactflow.dev's Workflow Editor template](https://reactflow.dev/ui/templates/workflow-editor),
which is what this project's canvas is modeled on.

## Status: backend is complete (all 8 milestones); this UI still runs on mock data

The `backend` now has a full API (`/v1/payments`, `/v1/customers/:id/payment-methods`,
subscriptions/dunning, routing, reconciliation, a second PSP — see
`backend/docs/design.md`). This frontend was built early, against the
backend's data model but before the API existed, and every page still
renders deterministic mock data (`lib/mock-data.ts`), not a live fetch.

Wiring it up is mechanical, not a rewrite for `/dashboard` and `/payments`
— those page components and types (`lib/types.ts`) already match the
backend's real shapes (`backend/src/db/types.ts`, `backend/src/domain/`):

- Replace `getMockPayments()` calls with fetches against `GET
  /v1/payments`.
- Requests need a per-product Bearer token (`backend/src/api/auth.ts`,
  `backend/scripts/seed.ts` prints one).

`/plans`, `/integrations`, and `/workflows` are a bigger gap: they were
rebuilt this pass to match **PayNext's** dashboard model
(docs.paynext.com/guides/platform/{workflows,plans} and
docs.paynext.com/integrations/overview — fetched and read live, not
recalled from training data), not this backend's actual schema. See
"Known gaps" below for exactly where that model and the backend's
`routing_rules`/subscriptions tables disagree.

## Pages

- **`/dashboard`** — cross-provider KPIs (approval rate, decline rate,
  volume, active disputes), a volume + approval-rate chart, decline
  breakdown by normalized code, and performance by legal entity
  (US-LLC / EU-BV).
- **`/payments`** — filterable/searchable payment list, drilling into
  `/payments/[id]` for the full timeline (stable event names, matching
  SPEC.md T4.3's serializer contract).
- **`/plans`** — billing plan catalog (renamed from "Subscriptions"):
  name, billing interval, one default price plus per-country price
  overrides (currency + amount + country, add as many rows as needed),
  and an optional trial (interval + its own price rows). Modeled on
  docs.paynext.com/guides/platform/plans. This replaces the old
  per-customer subscription list — there's no drill-down into
  individual customers' subscriptions anymore (see gaps below).
- **`/integrations`** — connect processors (Stripe, Solidgate — this
  backend's two built adapters) so they're selectable from a Workflow's
  Authorize Payment action. Modeled on
  docs.paynext.com/integrations/overview; connecting is mock-only (see
  gaps below).
- **`/workflows`** — a list of workflows, one per payment method (Cards
  / Apple Pay / Google Pay — PayNext allows exactly one workflow per
  method). "Create workflow" picks the payment method, then opens a
  canvas that starts from a single **Payment Create** trigger node.
  From there, a "+" appends the next node: a **Condition** (transaction
  type, BIN, card network, issuer country code, currency, issuer name,
  customer country, metadata, or CIT processor) or an **Action**
  (Authorize Payment — pick a connected processor, an optional fallback
  processor, and a 3D Secure mode of No 3DS / Adaptive / Frictionless
  per docs.paynext.com/guides/payments/3d-secure — plus Settle Payment,
  Block Payment, Set Metadata, or Delay). Export the current config as
  JSON via the toolbar.

## Known gaps / next steps

- **Workflows/Plans/Integrations are modeled on PayNext, not on this
  backend's actual schema.** Specific mismatches: the backend's real
  Milestone 5 routing engine (`routing_rules` table — see
  `backend/docs/adr/0007-routing-rules-engine.md`) has no concept of a
  linear trigger→condition→action chain, AND/OR groups, or a Split
  node; the backend's Milestone 8 subscriptions tables
  (`backend/docs/adr/*subscriptions*`) are per-customer subscription
  instances, not the plan-catalog-with-localized-pricing model built
  here; and there's no backend endpoint at all yet for storing
  processor credentials (`/integrations` writes nowhere real). Treat
  all three pages as a UI/UX spec to reconcile against the backend
  schema before wiring them to live data, not as a preview of the real
  API shape.
- **Workflow canvas is a single linear chain, not PayNext's full
  model.** No AND/OR condition groups, no branching (a Condition node
  doesn't have separate match/no-match paths — every node just runs in
  the order it was added), and no Split (percentage traffic division)
  node. This was a deliberate simplification ("make it simple — only
  node available from scratch is Payment Create, then a plus to add
  conditions/actions").
- **`/integrations` connecting is mock-only.** "Connect" just masks and
  stores the pasted key in local Zustand state — there's no real
  Stripe/Solidgate OAuth or API-key exchange, and nothing is sent to
  the backend. A real implementation needs a backend endpoint to store
  `psp_accounts.secret_ref`-style credentials (see
  `backend/src/adapters/stripe/credentials.ts` for the pattern the
  backend already uses) plus a way to test the connection before
  marking it "Connected".
- **No auto-layout algorithm.** `elkjs` is installed but not wired up —
  node positions use a fixed vertical column (`lib/workflow-graph.ts`).
- **No persistence.** Workflow, Plan, and Integration edits all live in
  Zustand state only; refreshing the page resets to the seeded mock
  data in `lib/mock-data.ts`.
- **Plans pricing editor assumes 2-decimal currencies.** The
  amount-entry field always divides/multiplies by 100; zero-decimal
  currencies (JPY, KRW, etc. — see `lib/utils.ts#formatMoney`'s
  `zeroDecimal` set) will show/store the wrong amount if selected.
- **No auth.** This is an internal tool; the backend's per-product API
  tokens (`backend/src/api/auth.ts`) will eventually gate the real API,
  but this frontend itself has no login screen — add one before this is
  reachable outside a trusted network.
- Dark mode, Geist font (dropped because `next/font/google` needs
  network access to Google Fonts at build time, which isn't guaranteed
  in every build environment), and the reference template's "runner"
  feature are not implemented.

## Development

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # production build
npm run lint
```
