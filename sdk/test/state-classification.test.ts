import { describe, expect, it } from "vitest";
import { classifyPaymentState } from "../src/state-classification";

describe("classifyPaymentState", () => {
  it.each(["captured", "Captured", "authorized", "settled", "auto_captured"])(
    "classifies %s as success",
    (state) => {
      expect(classifyPaymentState({ state })).toBe("success");
    },
  );

  it.each(["declined", "Declined", "failed", "authorization_failed"])(
    "classifies %s as hard_failure",
    (state) => {
      expect(classifyPaymentState({ state })).toBe("hard_failure");
    },
  );

  it("classifies a non-terminal state with a pspClientSecret as drive_action", () => {
    expect(
      classifyPaymentState({ state: "requires_action", pspClientSecret: "pi_123_secret_abc" }),
    ).toBe("drive_action");
  });

  it("classifies a non-terminal state with no pspClientSecret as pending", () => {
    expect(classifyPaymentState({ state: "authorizing" })).toBe("pending");
  });

  it("prioritizes success/failure matching over drive_action even if a secret is present", () => {
    expect(
      classifyPaymentState({ state: "captured", pspClientSecret: "pi_123_secret_abc" }),
    ).toBe("success");
    expect(
      classifyPaymentState({ state: "declined", pspClientSecret: "pi_123_secret_abc" }),
    ).toBe("hard_failure");
  });
});
