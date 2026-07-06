/**
 * T7.5: "Load test: 10x expected peak."
 *
 * Run with k6 (https://k6.io — a standalone binary, not an npm
 * dependency, so this doesn't touch package.json or need the
 * "ask before adding a dependency" conversation):
 *
 *   k6 run -e BASE_URL=http://localhost:3000 -e API_TOKEN=po_xxx scripts/load-test.k6.js
 *
 * ASSUMPTION FLAGGED (per SPEC.md's working agreement — encode, don't
 * guess): this codebase has no real production traffic data yet (it's
 * a new build), so "expected peak" is a documented placeholder —
 * EXPECTED_PEAK_RPS below — not a number derived from any actual
 * measurement. Replace it with a real figure once one exists (e.g.
 * from the pilot product's actual volume) and re-run; the 10x
 * multiplier itself is SPEC.md's own instruction, not something this
 * script invented.
 *
 * Scenario: sustained POST /v1/payments traffic against the mock PSP
 * (`docs.paynext.com`... no — against `psp=mock`, deterministic,
 * no external network dependency), each request a fresh
 * Idempotency-Key so every one is a genuine new payment, not a cache
 * hit. A small fraction of requests deliberately use the 4000/5000/9000
 * magic amounts (src/adapters/mock/index.ts) so the load test also
 * exercises the decline/3DS/timeout-retry code paths under load, not
 * just the happy path.
 *
 * NOT RUN in this build environment — no live Postgres/Redis/API
 * process reachable from this sandbox (same disclosed limitation as
 * every other "requires real infra" artifact in this repo). Run it
 * against a real `make dev` stack (or a staging deployment) before
 * treating its results as a genuine capacity signal.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_TOKEN = __ENV.API_TOKEN; // required — see scripts/seed.ts for how to mint one
const PRODUCT_CUSTOMER_EMAIL = __ENV.CUSTOMER_EMAIL || 'load-test@example.com';

// Documented placeholder — see the top-of-file flag.
const EXPECTED_PEAK_RPS = 50;
const TARGET_RPS = EXPECTED_PEAK_RPS * 10;

export const options = {
  scenarios: {
    sustained_10x_peak: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: Math.ceil(TARGET_RPS * 0.5),
      maxVUs: TARGET_RPS * 2,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% hard failures (5xx/network) — declines are expected 2xx responses, not failures
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
  },
};

const declineRate = new Rate('business_decline_rate');

// Magic amounts, src/adapters/mock/index.ts — mixed in at low frequency
// so the load test also exercises non-happy-path code (decline
// handling, 3DS branch, the T2.6 timeout-retry path), not just captures.
function pickAmount() {
  const roll = Math.random();
  if (roll < 0.05) return 4000; // decline
  if (roll < 0.08) return 5000; // requires_action
  if (roll < 0.09) return 9000; // timeout-after-success
  return 1999 + Math.floor(Math.random() * 8000); // normal, varied
}

export default function () {
  const idempotencyKey = `loadtest-${__VU}-${__ITER}-${Date.now()}`;
  const payload = JSON.stringify({
    customerEmail: PRODUCT_CUSTOMER_EMAIL,
    amount: { minorUnits: pickAmount(), currency: 'USD' },
    paymentMethodRef: `pm_loadtest_${__VU}_${__ITER}`,
    citMit: 'cit',
    captureMethod: 'automatic',
  });

  const res = http.post(`${BASE_URL}/v1/payments`, payload, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_TOKEN}`,
      'idempotency-key': idempotencyKey,
    },
  });

  const ok = check(res, {
    'status is 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  if (ok) {
    const body = res.json();
    declineRate.add(body && body.state === 'declined');
  }
}
