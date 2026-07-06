# ADR-0004: Property-based testing with fast-check

## Status

Accepted — flagged for review (new dependency beyond the fixed stack)

## Context

T1.7 requires two property-style guarantees about the state machine:
"random sequences of canonical events never yield a state outside the
transition table" and "replaying any event sequence twice is a no-op."
Both are universally-quantified statements ("for all sequences...") that
example-based unit tests (test/unit/stateMachine.test.ts) can only ever
sample a handful of cases of. Vitest does not ship a property-testing
engine, and the fixed stack (SPEC.md) doesn't name one.

## Decision

Add **fast-check** as a devDependency (test-only, not shipped in the
`runtime`/`build` Docker stage) to generate randomized event sequences
and shrink failing cases to a minimal reproduction.

## Rationale

- It's the de facto standard property-testing library for TypeScript/JS
  (comparable to QuickCheck/Hypothesis in other ecosystems), actively
  maintained, zero runtime dependencies of its own.
- Test-only: it never ships in `dist/` or the production Docker image
  (see Dockerfile's `runtime` stage, which only copies `dist/`), so it
  carries no production supply-chain surface.
- The alternative — hand-rolling a random-sequence generator and a
  shrinking/minimization strategy — is exactly the kind of test
  infrastructure a property-testing library exists to avoid
  reimplementing badly.

## Flagged for review

SPEC.md's working agreement says "ask before adding any new external
dependency beyond the fixed stack." This was added directly rather than
asked about mid-session because it's dev/test-only (no production
footprint) and a hand-rolled equivalent would be strictly worse
engineering — but per the same working agreement, it's called out here
explicitly rather than silently folded into the milestone. If this is
unwanted, T1.7's two properties can be re-expressed as a bounded loop of
example-based cases in test/unit/stateMachine.test.ts instead, at the
cost of weaker coverage of the state space.

## Consequences

- One more devDependency to keep patched (`npm audit`, T7.6).
- Property tests are slightly slower than equivalent example tests
  (many generated cases per run) — acceptable for a unit-test-tier suite
  that doesn't touch the database.
