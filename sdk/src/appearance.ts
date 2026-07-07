/**
 * Appearance API — a deliberate, small subset of Stripe's real
 * Appearance API (see https://docs.stripe.com/elements/appearance-api)
 * so merchants who already know Stripe.js can guess our shape, and so
 * the stripe-driver can forward these variables almost 1:1 into
 * Stripe's own `appearance.variables`.
 */
export interface Appearance {
  /** Primary brand/accent color, e.g. button and focus-ring color. */
  colorPrimary?: string;
  /** Background color of input fields / the card element surface. */
  colorBackground?: string;
  /** Default text color. */
  colorText?: string;
  /** Color used for validation/error states. */
  colorDanger?: string;
  /** CSS font-family stack applied to rendered inputs. */
  fontFamily?: string;
  /** Corner radius for inputs, e.g. "6px". */
  borderRadius?: string;
  /** Base spacing unit used for padding/margins between fields, e.g. "4px". */
  spacingUnit?: string;
}

export const DEFAULT_APPEARANCE: Required<Appearance> = {
  colorPrimary: "#6366f1",
  colorBackground: "#ffffff",
  colorText: "#1a1a1a",
  colorDanger: "#df1b41",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  borderRadius: "6px",
  spacingUnit: "4px",
};

/** Merges a partial Appearance override on top of the SDK defaults. */
export function resolveAppearance(
  overrides: Appearance | undefined,
): Required<Appearance> {
  return { ...DEFAULT_APPEARANCE, ...overrides };
}

/**
 * Shape of Stripe.js's `Elements` `appearance` option, narrowed to
 * just the fields this SDK populates. See
 * https://docs.stripe.com/elements/appearance-api for the full shape;
 * Stripe accepts (and ignores) additional variables/rules we don't
 * set, so this narrow shape is safe to pass straight into
 * `stripe.elements({ appearance })`.
 */
export interface StripeAppearanceOptions {
  variables: {
    colorPrimary: string;
    colorBackground: string;
    colorText: string;
    colorDanger: string;
    fontFamily: string;
    borderRadius: string;
    spacingUnit: string;
  };
}

/**
 * Pure mapping function from our Appearance vocabulary to Stripe's
 * `appearance` option shape (`variables`), so it can be unit tested
 * without ever loading stripe.js.
 */
export function toStripeAppearance(
  appearance: Appearance | undefined,
): StripeAppearanceOptions {
  const resolved = resolveAppearance(appearance);
  return {
    variables: {
      colorPrimary: resolved.colorPrimary,
      colorBackground: resolved.colorBackground,
      colorText: resolved.colorText,
      colorDanger: resolved.colorDanger,
      fontFamily: resolved.fontFamily,
      borderRadius: resolved.borderRadius,
      spacingUnit: resolved.spacingUnit,
    },
  };
}

/**
 * Renders an Appearance object into a CSS custom-property block, used
 * by the mock/solidgate drivers' Shadow DOM stylesheet
 * (see elements/card-inputs.ts).
 */
export function toCssVariables(appearance: Appearance | undefined): string {
  const resolved = resolveAppearance(appearance);
  return `
    --ap-color-primary: ${resolved.colorPrimary};
    --ap-color-background: ${resolved.colorBackground};
    --ap-color-text: ${resolved.colorText};
    --ap-color-danger: ${resolved.colorDanger};
    --ap-font-family: ${resolved.fontFamily};
    --ap-border-radius: ${resolved.borderRadius};
    --ap-spacing-unit: ${resolved.spacingUnit};
  `.trim();
}
