import type { ProcessorId } from "./types";

/** Card network scheme-monitoring program we're tracking a ratio against. */
export type Scheme = "visa_vamp" | "mastercard_ecp";

export type RiskTierId =
  | "vamp_standard"
  | "vamp_above_standard"
  | "vamp_excessive"
  | "mc_standard"
  | "mc_ecm"
  | "mc_hecm";

export interface RiskTierDefinition {
  id: RiskTierId;
  scheme: Scheme;
  label: string;
  /** Ratio (percent, e.g. 1.5 = 1.5%) at/above which this tier applies. */
  minRatioPct: number;
  /** Badge tone used across the UI for this tier. */
  tone: "success" | "warning" | "danger";
  description: string;
}

export interface RiskMonthPoint {
  /** ISO yyyy-mm-01 for the calendar month this ratio applies to. */
  month: string;
  fraudDisputeRatioPct: number;
}

export interface DescriptorRiskProfile {
  descriptor: string;
  processor: ProcessorId;
  merchantEntity: "US-LLC" | "EU-BV";
  /** Trailing count of settled CNP transactions used as the ratio denominator. */
  settledTransactionCount: number;
  /** Count of fraud (TC40) + dispute (TC15) events in the current period — Visa VAMP numerator. */
  vampFraudDisputeCount: number;
  /** Count of chargebacks in the current period — Mastercard ECP numerator. */
  mastercardChargebackCount: number;
  /** Last 6 months of the combined VAMP ratio, oldest first, current month last. */
  vampHistory: RiskMonthPoint[];
  /** Last 6 months of the Mastercard chargeback ratio, oldest first, current month last. */
  mastercardHistory: RiskMonthPoint[];
}

export interface RiskStatus {
  tier: RiskTierDefinition;
  ratioPct: number;
  /** 0..1 (can exceed 1 in the worst tier) — how far into the *next* tier's
   *  range the ratio sits, for progress-bar rendering against threshold. */
  headroomFraction: number;
}
