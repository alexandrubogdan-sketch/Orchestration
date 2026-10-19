export interface Appearance {
  colorPrimary?: string;

  colorBackground?: string;

  colorText?: string;

  colorDanger?: string;

  fontFamily?: string;

  borderRadius?: string;

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

export function resolveAppearance(
  overrides: Appearance | undefined,
): Required<Appearance> {
  return { ...DEFAULT_APPEARANCE, ...overrides };
}

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
