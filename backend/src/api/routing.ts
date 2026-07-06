/**
 * SUPERSEDED by Milestone 5 — kept only as a compatibility re-export so
 * nothing that still imports from `../routing.js` (this file's old
 * path) silently diverges from the real implementation.
 *
 * The naive "lowest-id enabled psp_account" strategy this file used to
 * implement directly now lives as the fallback branch inside
 * `src/routing/evaluator.ts#evaluateRouting` (used when no
 * `routing_rules` row matches) — the strategy itself didn't disappear,
 * it just stopped being the ONLY strategy. `NoRoutablePspAccountError`
 * and `RoutingDecision` are re-exported from `src/routing/types.ts`,
 * their new home (per SPEC.md's REPO LAYOUT: `src/routing/` is where
 * "rules engine, circuit breaker" belong).
 */
export { NoRoutablePspAccountError, type RoutingDecision } from '../routing/types.js';
export { evaluateRouting } from '../routing/evaluator.js';
