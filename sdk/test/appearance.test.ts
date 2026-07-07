import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, resolveAppearance, toCssVariables, toStripeAppearance } from "../src/appearance";

describe("resolveAppearance", () => {
  it("returns defaults when no overrides are given", () => {
    expect(resolveAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
  });

  it("merges partial overrides on top of defaults", () => {
    const resolved = resolveAppearance({ colorPrimary: "#ff0000" });
    expect(resolved.colorPrimary).toBe("#ff0000");
    expect(resolved.colorBackground).toBe(DEFAULT_APPEARANCE.colorBackground);
  });
});

describe("toStripeAppearance", () => {
  it("maps our vocabulary 1:1 into Stripe's variables shape", () => {
    const result = toStripeAppearance({
      colorPrimary: "#6366f1",
      borderRadius: "10px",
    });
    expect(result).toEqual({
      variables: {
        colorPrimary: "#6366f1",
        colorBackground: DEFAULT_APPEARANCE.colorBackground,
        colorText: DEFAULT_APPEARANCE.colorText,
        colorDanger: DEFAULT_APPEARANCE.colorDanger,
        fontFamily: DEFAULT_APPEARANCE.fontFamily,
        borderRadius: "10px",
        spacingUnit: DEFAULT_APPEARANCE.spacingUnit,
      },
    });
  });

  it("falls back to full defaults when appearance is undefined", () => {
    const result = toStripeAppearance(undefined);
    expect(result.variables.colorPrimary).toBe(DEFAULT_APPEARANCE.colorPrimary);
  });
});

describe("toCssVariables", () => {
  it("renders every appearance field as a CSS custom property", () => {
    const css = toCssVariables({ colorPrimary: "#123456" });
    expect(css).toContain("--ap-color-primary: #123456;");
    expect(css).toContain("--ap-border-radius:");
    expect(css).toContain("--ap-spacing-unit:");
  });
});
