import { toCssVariables, type Appearance } from "../appearance";
import { isValidCvc, isValidExpiry, isValidLuhn } from "../validation";
import type { CardElementChangeState } from "../drivers/types";

/**
 * Shared DOM/CSS construction for the raw card-number/expiry/CVC
 * `<input>` fields used by BOTH the mock driver and the solidgate
 * driver. Stripe's driver does NOT use this — Stripe owns its own
 * iframe-hosted input DOM, so stripe-driver.ts only mirrors this
 * module's *shape* (grouping, labeling conventions), not its code.
 *
 * Card inputs are attached inside a `mode: "closed"` Shadow DOM by
 * the caller (see attachCardInputs below). Closed mode stops casual
 * `element.shadowRoot` access from the host page, but this is NOT
 * equivalent to Stripe's real cross-origin iframe isolation: any
 * script already running on the host page (e.g. an XSS payload, or a
 * malicious/compromised third-party script tag) can still read these
 * input values directly, because they execute in the same JS
 * realm/origin as the rest of the page. See README "Security model"
 * for the honest version of this caveat — do not oversell it.
 */

export interface CardInputElements {
  root: HTMLElement;
  shadowRoot: ShadowRoot;
  numberInput: HTMLInputElement;
  expiryInput: HTMLInputElement;
  cvcInput: HTMLInputElement;
}

const STYLE_TEMPLATE = (appearance: Appearance | undefined): string => `
  :host {
    ${toCssVariables(appearance)}
    display: block;
  }
  .ap-card-row {
    display: flex;
    gap: var(--ap-spacing-unit);
    font-family: var(--ap-font-family);
  }
  .ap-card-field {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: calc(var(--ap-spacing-unit) / 2);
  }
  .ap-card-field input {
    box-sizing: border-box;
    width: 100%;
    padding: calc(var(--ap-spacing-unit) * 3) calc(var(--ap-spacing-unit) * 2);
    font-family: var(--ap-font-family);
    font-size: 15px;
    color: var(--ap-color-text);
    background: var(--ap-color-background);
    border: 1px solid #cfd2d8;
    border-radius: var(--ap-border-radius);
    outline: none;
  }
  .ap-card-field input:focus {
    border-color: var(--ap-color-primary);
    box-shadow: 0 0 0 1px var(--ap-color-primary);
  }
  .ap-card-field input[data-invalid="true"] {
    border-color: var(--ap-color-danger);
  }
  .ap-card-number {
    flex: 2 1 auto;
  }
`;

/**
 * Builds the card-input DOM inside a closed Shadow DOM attached to
 * `container`, and wires up basic input formatting (spacing digits in
 * the card number, "/" insertion in the expiry field).
 */
export function attachCardInputs(
  container: HTMLElement,
  appearance: Appearance | undefined,
): CardInputElements {
  const root = document.createElement("div");
  container.appendChild(root);
  const shadowRoot = root.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = STYLE_TEMPLATE(appearance);
  shadowRoot.appendChild(style);

  const row = document.createElement("div");
  row.className = "ap-card-row";

  const numberField = document.createElement("div");
  numberField.className = "ap-card-field ap-card-number";
  const numberInput = document.createElement("input");
  numberInput.type = "text";
  numberInput.inputMode = "numeric";
  numberInput.autocomplete = "cc-number";
  numberInput.placeholder = "Card number";
  numberInput.maxLength = 23; // 19 digits + up to 4 spaces
  numberField.appendChild(numberInput);

  const expiryField = document.createElement("div");
  expiryField.className = "ap-card-field ap-card-expiry";
  const expiryInput = document.createElement("input");
  expiryInput.type = "text";
  expiryInput.inputMode = "numeric";
  expiryInput.autocomplete = "cc-exp";
  expiryInput.placeholder = "MM/YY";
  expiryInput.maxLength = 7;
  expiryField.appendChild(expiryInput);

  const cvcField = document.createElement("div");
  cvcField.className = "ap-card-field ap-card-cvc";
  const cvcInput = document.createElement("input");
  cvcInput.type = "text";
  cvcInput.inputMode = "numeric";
  cvcInput.autocomplete = "cc-csc";
  cvcInput.placeholder = "CVC";
  cvcInput.maxLength = 4;
  cvcField.appendChild(cvcInput);

  row.appendChild(numberField);
  row.appendChild(expiryField);
  row.appendChild(cvcField);
  shadowRoot.appendChild(row);

  numberInput.addEventListener("input", () => {
    numberInput.value = formatCardNumber(numberInput.value);
  });
  expiryInput.addEventListener("input", () => {
    expiryInput.value = formatExpiry(expiryInput.value);
  });
  cvcInput.addEventListener("input", () => {
    cvcInput.value = cvcInput.value.replace(/\D/g, "");
  });

  return { root, shadowRoot, numberInput, expiryInput, cvcInput };
}

function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 19);
  const groups = digits.match(/.{1,4}/g);
  return groups ? groups.join(" ") : digits;
}

function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 2) {
    return digits;
  }
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

/**
 * Computes the current CardElementChangeState from the three raw
 * input values, using the shared pure validators.
 */
export function computeChangeState(elements: CardInputElements): CardElementChangeState {
  const numberValue = elements.numberInput.value.trim();
  const expiryValue = elements.expiryInput.value.trim();
  const cvcValue = elements.cvcInput.value.trim();

  const empty = numberValue === "" && expiryValue === "" && cvcValue === "";

  const numberValid = isValidLuhn(numberValue);
  const expiryValid = isValidExpiry(expiryValue);
  const cvcValid = isValidCvc(cvcValue);

  elements.numberInput.dataset.invalid = String(numberValue !== "" && !numberValid);
  elements.expiryInput.dataset.invalid = String(expiryValue !== "" && !expiryValid);
  elements.cvcInput.dataset.invalid = String(cvcValue !== "" && !cvcValid);

  if (empty) {
    return { complete: false, empty: true };
  }

  if (numberValue !== "" && !numberValid) {
    return { complete: false, empty: false, error: "Card number is invalid." };
  }
  if (expiryValue !== "" && !expiryValid) {
    return { complete: false, empty: false, error: "Expiry date is invalid or in the past." };
  }
  if (cvcValue !== "" && !cvcValid) {
    return { complete: false, empty: false, error: "Security code is invalid." };
  }

  const complete = numberValid && expiryValid && cvcValid;
  return { complete, empty: false };
}
