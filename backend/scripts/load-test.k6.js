import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_TOKEN = __ENV.API_TOKEN;
const PRODUCT_CUSTOMER_EMAIL = __ENV.CUSTOMER_EMAIL || 'load-test@example.com';

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
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
  },
};

const declineRate = new Rate('business_decline_rate');

function pickAmount() {
  const roll = Math.random();
  if (roll < 0.05) return 4000;
  if (roll < 0.08) return 5000;
  if (roll < 0.09) return 9000;
  return 1999 + Math.floor(Math.random() * 8000);
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
