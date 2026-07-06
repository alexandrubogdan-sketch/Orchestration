# T7.6 Security pass

## 1. Dependency audit (`npm audit`)

**Production dependencies (`npm audit --omit=dev`): 0 vulnerabilities**
as of this pass.

One finding was fixed: `kysely@0.27.6` had a high-severity advisory
(GHSA-wmrf-hv6w-mr66 and two related CVEs) covering SQL injection via
unsanitized JSON path keys (`Kysely<any>` / silenced compilation
errors) and a MySQL-specific backslash-escaping issue in `sql.lit()`.
This codebase uses neither: `db` is always fully typed as
`Kysely<Database>` (never `Kysely<any>`), the dialect is
`PostgresDialect` (not MySQL), and nothing calls `sql.lit()` or
`JSONPathBuilder` (`.key()`/`.at()`) anywhere in `src/` (verified by
grep). Even so — bumped to `kysely@0.29.2` (the patched release) since
a free, verified-non-breaking fix beats "we don't think we're exposed."
Re-ran the full `tsc`/`eslint`/`vitest` suite after the bump: clean,
177/177 unit+contract tests still passing, zero source changes needed.

**Dev dependencies**: `npm audit` (including devDependencies) reports
7 findings, all inside two chains that never ship to production:

- `vitest`/`vite`/`esbuild` — a moderate-severity dev-server request
  issue (esbuild's dev server accepting cross-origin requests). Only
  relevant if `vite`'s dev server were exposed on a shared network,
  which it isn't here (it's Vitest's transform pipeline, not a running
  dev server in this repo).
- `node-pg-migrate`/`glob` — a high-severity command-injection issue
  in `glob`'s CLI (`-c`/`--cmd` with `shell: true`). This codebase
  uses `node-pg-migrate` as a library (via `npm run migrate:up`, not
  its own CLI wrapping `glob -c`), and never invokes glob's CLI flag
  directly.

Both fixes are available only via major version bumps flagged as
breaking by `npm audit fix --force` (`vitest@4.x`, `node-pg-migrate@8.x`).
Given: (a) neither is reachable from production, (b) both would need a
full test-suite/migration-tooling re-verification pass I don't have
capacity to do blind in this session without risking regressing a
currently fully-green 177-test suite, this is flagged as a **follow-up
task**, not silently ignored — tracked here rather than fixed
speculatively.

## 2. Log-scrubbing test (Non-negotiable #8)

`test/unit/logger-redaction.test.ts` already covered key-based
redaction (any key named `card`/`number`/`cvv`/`pan`/`client_secret`,
at any nesting depth). This pass added a genuinely new layer:
**value-pattern redaction** (`src/observability/logger.ts`'s
`PAN_PATTERN`/`redactPanPatterns`) that catches a card-number-shaped
value (13-19 digits, ISO/IEC 7812, optionally space/dash-grouped) **no
matter what key it's under** — closing the gap where a PAN accidentally
logged under an unexpected field (e.g. `{ note: rawCardNumber }`, a
plausible future bug) would previously have sailed through untouched.

This deliberately over-redacts in edge cases (a 13-digit epoch-
millisecond timestamp logged as a bare string would also get
`[REDACTED]`) — an accepted trade-off given Non-negotiable #8's
absolute wording. Four new tests confirm: redaction under an unrelated
key, dash/space-grouped numbers, that short numeric values (last4,
quantities) are correctly left alone, and that the pattern check is
recursive.

## 3. Authorization tests (`test/integration/authz.test.ts`)

`src/api/auth.ts`'s own docblock flagged this as the thing its
preHandler hook does NOT itself guarantee: "scoping (a product can
only ever see/act on its own data) is NOT enforced here — every route
handler is responsible for filtering its own queries by
`request.auth.productId`." This test is what actually proves every
mutating/reading route does that, rather than trusting it by
inspection:

- No token -> 401, never reaches a handler.
- A sibling product under the SAME merchant entity cannot read
  another product's payment (404 — the route treats "exists but not
  yours" identically to "doesn't exist," which is itself a deliberate
  anti-enumeration choice, not an oversight).
- A completely different merchant entity: same result.
- The owning product can read its own payment.
- `GET /v1/payments` (list) for product B never includes product A's
  payment.
- `capture`/`void`/`refunds` all reject a foreign token with 404.
- A `revoked_at` token is rejected (401) even though the row still
  exists in `api_tokens` — proves the auth hook's `revoked_at IS NULL`
  check is load-bearing, not just present.

Not yet covered (flagged, not silently skipped): there is no
HTTP-level admin API for creating/revoking `routing_rules` or
`api_tokens` yet (ADR-0007's flagged follow-up), so there's no authz
surface to test there beyond what the repo-layer functions already
assume (a trusted caller, e.g. an internal admin script). Revisit if/
when that surface gets an HTTP API.
