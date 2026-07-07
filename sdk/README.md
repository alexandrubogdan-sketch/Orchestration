# @alphapayments/checkout-sdk

A browser-embeddable checkout SDK for **Alpha Payments**. It gives merchants a
Stripe.js/Elements-shaped API — `loadCheckout()`, `createElement()`,
`confirm()` — that talks to Alpha Payments' own checkout-session backend
contract and to whichever PSP (Stripe, Solidgate, or the built-in mock) that
session was created against.

If you already know Stripe.js, this SDK should feel immediately familiar. If
you don't, the [Quick start](#quick-start) below is a complete integration.

## Architecture

A checkout session flows through five hops, only three of which this SDK
owns:

1. **Merchant server -> Alpha Payments server.** Your backend calls
   `POST /v1/checkout-sessions` with your **private** Bearer key (never
   exposed to the browser) and gets back `{ id, clientSecret, expiresAt,
   amount }`. This is the only step outside this SDK's scope — do it from
   your own server, right before you render your checkout page.
2. **Merchant server -> merchant frontend.** Send that `id` and
   `clientSecret` down to your own frontend (embedded in the page, an API
   response, wherever). This SDK never sees your private key — only the
   session-scoped `clientSecret`.
3. **Browser SDK -> Alpha Payments (public config).** `loadCheckout({
   apiBaseUrl, sessionId, clientSecret })` calls the public, unauthenticated
   `GET /checkout/{id}/public` endpoint to learn the session's amount, status,
   and which PSP (`stripe` / `solidgate` / `mock`) is active, plus that PSP's
   publishable key.
4. **Browser SDK -> PSP's own client-side tokenization.** Based on the active
   PSP, the SDK loads that PSP's own client-side SDK (for Stripe: the real
   `https://js.stripe.com/v3`) and mounts a card entry UI. When you call
   `checkout.confirm()`, the SDK tokenizes the entered card **with the PSP
   directly** — your server, and this SDK's own backend calls, never see raw
   card numbers.
5. **Browser SDK -> Alpha Payments (confirm) -> optional automatic 3DS.** The
   resulting PSP token (`paymentMethodRef`) is POSTed to
   `POST /checkout/{id}/confirm`. If the PSP requires further customer
   authentication (3D Secure), the backend response carries the *PSP's own*
   client secret (distinct from your checkout session's `clientSecret`), and
   this SDK automatically drives that challenge (e.g.
   `stripe.confirmCardPayment(...)`) and re-confirms — by default, your
   integration code never needs to know 3DS happened at all.

## Quick start

```bash
npm install @alphapayments/checkout-sdk
```

Server-side (step 1 above — pseudocode, any backend language):

```
POST https://api.example.com/v1/checkout-sessions
Authorization: Bearer <your private key>
{ "amount": { "minorUnits": 4999, "currency": "usd" }, "citMit": "cit" }

-> { "id": "cs_...", "clientSecret": "cs_secret_...", "expiresAt": "...", "amount": {...} }
```

Send `id` and `clientSecret` to your page, then:

```ts
import { loadCheckout } from "@alphapayments/checkout-sdk";

const checkout = await loadCheckout({
  apiBaseUrl: "https://api.example.com",
  sessionId: session.id,
  clientSecret: session.clientSecret,
});

const card = checkout.createElement("card", {
  appearance: { colorPrimary: "#6366f1", borderRadius: "10px" },
});
card.mount("#card-container");

card.on("change", (state) => {
  submitButton.disabled = !state.complete;
  errorEl.textContent = state.error ?? "";
});

// Optional: one-click Apple Pay / Google Pay button. Auto-hides itself
// if the active driver or the browser doesn't support it.
const expressCheckout = checkout.createElement("expressCheckout");
expressCheckout.mount("#express-checkout-container");

submitButton.onclick = async () => {
  const result = await checkout.confirm({ element: card });
  if (result.status === "succeeded") {
    window.location.href = "/thank-you";
  } else if (result.status === "error") {
    errorEl.textContent = result.error.message;
  } else {
    // result.status === "requires_action" — see "Automatic 3DS" below
    // for the (rare) cases this can happen.
  }
};
```

## React

```tsx
import { CheckoutProvider, CardElement, useCheckout } from "@alphapayments/checkout-sdk/react";
import { useState } from "react";

function PayButton() {
  const checkout = useCheckout();
  const [error, setError] = useState<string>();

  return (
    <>
      <CardElement onChange={(s) => setError(s.error)} />
      <button
        onClick={async () => {
          const result = await checkout.confirm();
          if (result.status === "error") setError(result.error.message);
        }}
      >
        Pay
      </button>
    </>
  );
}

function App({ sessionId, clientSecret }: { sessionId: string; clientSecret: string }) {
  return (
    <CheckoutProvider
      apiBaseUrl="https://api.example.com"
      sessionId={sessionId}
      clientSecret={clientSecret}
      loading={<p>Loading checkout…</p>}
    >
      <PayButton />
    </CheckoutProvider>
  );
}
```

`<CheckoutProvider>` loads the session once and exposes it via `useCheckout()`
to any descendant. `<CardElement/>` mounts/unmounts the underlying vanilla
`CardElement` in a `useEffect`, matching `@stripe/react-stripe-js` ergonomics.
There's also an `<ExpressCheckoutElement/>` component with `onReady`/
`onPaymentMethod` props for the wallet button.

react/react-dom are **optional peer dependencies** — only the `/react`
subpath imports them, so plain-JS integrations never need React installed.

## `checkout.confirm()`

In the vanilla API you always pass `{ element }` explicitly. In React,
`<CardElement/>` registers itself with the session on mount, which is what
lets `checkout.confirm()` be called with **no arguments** as shown above —
under the hood it's the same `confirm({ element })` call, just with `element`
defaulted to whichever `<CardElement/>` is currently mounted.

Returns a discriminated union:

```ts
type ConfirmResult =
  | { status: "succeeded"; payment: Payment }
  | { status: "requires_action" }
  | { status: "error"; error: { message: string; code?: string } };
```

### Automatic 3DS

By default, **3DS is fully automatic**. If the backend's confirm response
indicates the PSP needs further client-side action (a non-terminal payment
state paired with the *PSP's own* client secret), the SDK:

1. calls the active driver's `confirmAction(pspClientSecret)` (for Stripe:
   `stripe.confirmCardPayment(pspClientSecret)`);
2. re-confirms the checkout session (safe — confirm is idempotent per
   session, so retrying never double-charges);
3. classifies the new state and returns the final `succeeded`/`error` result.

`requires_action` is only ever returned to your code when the action
genuinely **cannot** be automated:

- the active driver has no way to drive the action at all, or
- `driver.confirmAction()` itself reports failure in a way that isn't a hard
  decline (e.g. the customer closed/abandoned a 3DS challenge popup), or
- the backend reports a non-terminal, non-failure state with **no** PSP
  client secret to act on (nothing for the SDK to drive — genuinely needs
  your own handling).

If you want to show custom UI during the (usually sub-second) 3DS challenge,
pass `onBeforeAction`:

```ts
await checkout.confirm({
  element: card,
  onBeforeAction: () => showSpinner("Verifying your card…"),
});
```

This is optional lifecycle plumbing — you never need it for 3DS to work.

### State classification

The backend's `confirm` response carries a free-text `state` string (see
`payment-orchestrator-go`'s `internal/domain/statemachine.go` for the
canonical enum: `created`, `requires_action`, `authorizing`, `authorized`,
`capturing`, `captured`, `refund_pending`, `refunded`, `dispute_opened`,
`dispute_won`, `dispute_lost`, `declined`, `voided`, `failed`, `settled`).
Rather than scatter `state.includes(...)` checks throughout the codebase,
every bit of that matching logic lives in one function,
`classifyPaymentState()` in `src/state-classification.ts`:

- contains `"captured"`, `"authorized"`, or `"settled"` -> success
- contains `"declined"` or `"failed"` -> hard failure
- anything else with a PSP client secret present -> drive 3DS, then re-check
- anything else -> pending (surfaced to you as `requires_action`)

If the backend's exact state enum or matching rule ever needs correcting,
this is the only file that needs to change.

## Appearance API

A deliberate subset of Stripe's real
[Appearance API](https://docs.stripe.com/elements/appearance-api), so it maps
almost 1:1 into Stripe's own `elements({ appearance })` option when the
Stripe driver is active, and drives CSS custom properties on the mock/
solidgate drivers' rendered inputs otherwise.

| Variable | Description | Default |
| --- | --- | --- |
| `colorPrimary` | Primary/accent color (focus ring, buttons) | `#6366f1` |
| `colorBackground` | Input/surface background color | `#ffffff` |
| `colorText` | Default text color | `#1a1a1a` |
| `colorDanger` | Validation/error state color | `#df1b41` |
| `fontFamily` | CSS font-family stack | system UI stack |
| `borderRadius` | Corner radius for inputs | `6px` |
| `spacingUnit` | Base spacing unit between fields | `4px` |

```ts
checkout.createElement("card", {
  appearance: { colorPrimary: "#16a34a", borderRadius: "12px", spacingUnit: "6px" },
});
```

## Security model

- **`clientSecret` scoping.** The only credential this SDK ever holds is the
  checkout session's `clientSecret`, obtained by *your* server and handed to
  *your* frontend. It is scoped to exactly one session, expires after 15
  minutes, and can only read that session's public config or confirm that
  session's payment — it cannot create sessions, list other sessions, or do
  anything your private Bearer key can do. This SDK **never** calls
  `POST /v1/checkout-sessions` (that endpoint requires your private key and
  must only ever be called from your server).
- **No persistent storage.** This SDK never touches `localStorage`,
  `sessionStorage`, or cookies. The `clientSecret` and any PSP tokens live in
  memory for the lifetime of the page only.
- **Card data never reaches your server or Alpha Payments' servers in raw
  form.** Card entry happens inside the active driver (Stripe's real
  cross-origin iframe for the `stripe` driver; this SDK's own inputs for
  `mock`/`solidgate`) and is tokenized directly against the PSP before
  anything is sent over the wire to `/checkout/{id}/confirm`.
- **Shadow DOM isolation — read this carefully.** The `mock` and `solidgate`
  drivers render real `<input>` fields for card number/expiry/CVC inside a
  `mode: "closed"` Shadow DOM. This stops *casual* access from the host page
  (e.g. `document.querySelector` or `element.shadowRoot` from arbitrary page
  code cannot reach these inputs). **This is not the same guarantee Stripe's
  real Elements provide.** Stripe's card Element runs inside a genuine
  cross-origin `<iframe>`, isolated at the browser process/origin level —
  no script running on your page, however privileged, can read values out of
  a cross-origin iframe it doesn't control. A closed Shadow DOM is a same-origin,
  same-JS-realm construct: any script already executing on your page with
  enough privilege (a determined XSS payload, or a compromised/malicious
  third-party `<script>` tag) *can* still reach into a closed shadow root via
  the DOM APIs available to same-realm code. **Do not present the mock/
  solidgate drivers as PCI-SAQ-A-equivalent to Stripe's real iframe-based
  Elements** — they are a good-enough sandbox/demo/fallback experience, not a
  cardholder-data isolation boundary. If PCI scope matters for your
  integration, use the `stripe` driver (see below) or a driver with
  equivalent real cross-origin isolation.
- **Why the Stripe driver loads `js.stripe.com` at runtime instead of
  bundling `@stripe/stripe-js`.** See the header comment in
  `src/drivers/stripe-driver.ts` — in short, Stripe's own documentation
  requires loading their script fresh from their origin on every page load
  (for instant security patching and fraud monitoring), and self-hosting/
  bundling it breaks PCI SAQ A eligibility. `@stripe/stripe-js` is listed as
  an **optional peer dependency** purely so you get its TypeScript types —
  its runtime is never included in this package's bundle.

## Drivers

| PSP | Status |
| --- | --- |
| `stripe` | Real integration against Stripe.js — dynamic script load, real `Elements`/`card` Element, real `createPaymentMethod`/`confirmCardPayment`, real `paymentRequest` for express checkout. |
| `mock` | Fully self-contained fake PSP for local dev/demos/tests. Real client-side Luhn/expiry/CVC validation, fake tokens, no network calls. |
| `solidgate` | **Functional placeholder, not a verified integration** — see below. |

### Solidgate: known gap

`src/drivers/solidgate-driver.ts` is explicitly flagged in its header comment
as **the least verified part of this SDK**. Unlike the Stripe driver (built
against Stripe's real, published, well-documented client API), Solidgate's
actual embeddable tokenization widget/SDK was not independently researched
for this build — there was no reachable documentation or sandbox account in
this build environment. What ships today reuses the mock driver's UX shape
(real inputs, same client-side validation) and produces a fake
`pm_solidgate_<random>`-shaped ref, so the rest of the SDK could be built and
tested end-to-end against a `psp: "solidgate"` session. **Do not present this
to a merchant as a real Solidgate integration.** Before shipping one: get
Solidgate's actual client-side SDK docs/sandbox credentials and replace
`mountCard`/`tokenize`/`confirmAction` in that file with real calls.

## Package layout

```
src/
  index.ts                       # main entry — exports loadCheckout()
  session.ts                     # CheckoutSession: createElement/confirm
  appearance.ts                  # Appearance API + Stripe mapper
  validation.ts                  # Luhn / expiry / CVC pure functions
  state-classification.ts        # classifyPaymentState() — single source of truth
  http.ts                        # fetch wrapper + typed errors
  elements/
    card-element.ts              # public CardElement wrapper
    express-checkout-element.ts  # wallet button wrapper
    card-inputs.ts                # shared DOM/CSS for mock+solidgate inputs
  drivers/
    types.ts                     # Driver interface
    stripe-driver.ts             # real Stripe.js integration
    stripe-types.ts              # narrow ambient Stripe types
    mock-driver.ts                # fake PSP
    solidgate-driver.ts           # placeholder (see above)
  react/
    index.tsx                    # CheckoutProvider, useCheckout, <CardElement/>
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
npm run build       # tsup — dual ESM/CJS + .d.ts, main entry + ./react subpath
```
