export type PaymentStateClassification =
  "success" | "hard_failure" | "drive_action" | "pending";

export interface ClassifyPaymentStateInput {
  state: string;
  pspClientSecret?: string | null;
}

export function classifyPaymentState(
  input: ClassifyPaymentStateInput,
): PaymentStateClassification {
  const normalized = input.state.toLowerCase();

  if (
    normalized.includes("captured") ||
    normalized.includes("authorized") ||
    normalized.includes("settled")
  ) {
    return "success";
  }

  if (normalized.includes("declined") || normalized.includes("failed")) {
    return "hard_failure";
  }

  if (input.pspClientSecret) {
    return "drive_action";
  }

  return "pending";
}
