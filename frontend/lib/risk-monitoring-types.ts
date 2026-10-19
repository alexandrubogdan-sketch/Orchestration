import type { ProcessorId } from "./types";

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

  minRatioPct: number;

  tone: "success" | "warning" | "danger";
  description: string;
}

export interface RiskMonthPoint {
  month: string;
  fraudDisputeRatioPct: number;
}

export interface DescriptorRiskProfile {
  descriptor: string;
  processor: ProcessorId;
  merchantEntity: "US-LLC" | "EU-BV";

  settledTransactionCount: number;

  vampFraudDisputeCount: number;

  mastercardChargebackCount: number;

  vampHistory: RiskMonthPoint[];

  mastercardHistory: RiskMonthPoint[];
}

export interface RiskStatus {
  tier: RiskTierDefinition;
  ratioPct: number;

  headroomFraction: number;
}
