import { PROCESSORS, type ProcessorId } from "./types";
import type {
  DescriptorRiskProfile,
  RiskMonthPoint,
  RiskStatus,
  RiskTierDefinition,
  Scheme,
} from "./risk-monitoring-types";

export const VAMP_MIN_MONTHLY_COUNT = 1500;

export const VAMP_EXCESSIVE_FEE_USD = 8;

export const MC_ECM_MIN_COUNT = 100;
export const MC_HECM_MIN_COUNT = 300;

export const RISK_TIERS: RiskTierDefinition[] = [
  {
    id: "vamp_standard",
    scheme: "visa_vamp",
    label: "Standard",
    minRatioPct: 0,
    tone: "success",
    description: "Below Visa's VAMP Excessive threshold (1.5% from Apr 1, 2026).",
  },
  {
    id: "vamp_above_standard",
    scheme: "visa_vamp",
    label: "Approaching threshold",
    minRatioPct: 1.05,
    tone: "warning",
    description: "Within 30% of Visa's VAMP Excessive threshold — act before the next reporting month.",
  },
  {
    id: "vamp_excessive",
    scheme: "visa_vamp",
    label: "Excessive",
    minRatioPct: 1.5,
    tone: "danger",
    description: "At or above Visa's VAMP Excessive threshold (1.5%) — $8 fee per fraud/dispute transaction.",
  },
  {
    id: "mc_standard",
    scheme: "mastercard_ecp",
    label: "Standard",
    minRatioPct: 0,
    tone: "success",
    description: "Below Mastercard's Excessive Chargeback Merchant (ECM) threshold.",
  },
  {
    id: "mc_ecm",
    scheme: "mastercard_ecp",
    label: "Excessive (ECM)",
    minRatioPct: 1.5,
    tone: "warning",
    description: "Mastercard ECM range: 1.5%–2.99% ratio with 100–299 chargebacks in the period.",
  },
  {
    id: "mc_hecm",
    scheme: "mastercard_ecp",
    label: "High Excessive (HECM)",
    minRatioPct: 3,
    tone: "danger",
    description: "Mastercard HECM range: >=3% ratio with >=300 chargebacks — fines scale toward $200,000+.",
  },
];

function tiersFor(scheme: Scheme): RiskTierDefinition[] {
  return RISK_TIERS.filter((t) => t.scheme === scheme).sort((a, b) => a.minRatioPct - b.minRatioPct);
}

export function classifyRisk(scheme: Scheme, ratioPct: number): RiskStatus {
  const tiers = tiersFor(scheme);
  let current = tiers[0]!;
  for (const tier of tiers) {
    if (ratioPct >= tier.minRatioPct) current = tier;
  }
  const currentIndex = tiers.findIndex((t) => t.id === current.id);
  const next = tiers[currentIndex + 1];
  const floor = current.minRatioPct;
  const ceiling = next ? next.minRatioPct : floor * 1.5 || 1;
  const span = ceiling - floor;
  const headroomFraction = span > 0 ? (ratioPct - floor) / span : 1;
  return { tier: current, ratioPct, headroomFraction };
}

function mulberry32(seed: number) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

const MONTH_LABELS_BACK = 6;

function lastNMonthsIso(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d);
    m.setMonth(m.getMonth() - i);
    out.push(m.toISOString().slice(0, 10));
  }
  return out;
}

function buildHistory(rng: () => number, endRatioPct: number, volatility: number): RiskMonthPoint[] {
  const months = lastNMonthsIso(MONTH_LABELS_BACK);
  const points: RiskMonthPoint[] = [];

  let ratio = Math.max(0.05, endRatioPct - (rng() - 0.3) * volatility * MONTH_LABELS_BACK);
  for (let i = 0; i < months.length; i++) {
    const isLast = i === months.length - 1;
    const target = isLast ? endRatioPct : ratio + (endRatioPct - ratio) * (i / months.length);
    const jitter = (rng() - 0.5) * volatility;
    const value = isLast ? endRatioPct : Math.max(0.02, target + jitter);
    points.push({ month: months[i]!, fraudDisputeRatioPct: Math.round(value * 100) / 100 });
    ratio = value;
  }
  return points;
}

interface DescriptorSeed {
  descriptor: string;
  processor: ProcessorId;
  merchantEntity: "US-LLC" | "EU-BV";
  settledTransactionCount: number;

  vampRatioPct: number;
  mastercardRatioPct: number;
}

const DESCRIPTOR_SEEDS: DescriptorSeed[] = [
  {
    descriptor: "ACME*DIGITALGOODS",
    processor: "solidgate",
    merchantEntity: "US-LLC",
    settledTransactionCount: 118_400,
    vampRatioPct: 1.62,
    mastercardRatioPct: 3.35,
  },
  {
    descriptor: "ACME* PRO SUB",
    processor: "stripe",
    merchantEntity: "US-LLC",
    settledTransactionCount: 86_200,
    vampRatioPct: 1.12,
    mastercardRatioPct: 1.85,
  },
  {
    descriptor: "ACMEDIGITAL EU",
    processor: "stripe",
    merchantEntity: "EU-BV",
    settledTransactionCount: 52_900,
    vampRatioPct: 0.58,
    mastercardRatioPct: 0.71,
  },
  {
    descriptor: "ACME GOODS CO",
    processor: "solidgate",
    merchantEntity: "EU-BV",
    settledTransactionCount: 34_150,
    vampRatioPct: 0.34,
    mastercardRatioPct: 0.42,
  },
];

function buildProfile(seed: DescriptorSeed): DescriptorRiskProfile {
  const rng = mulberry32(hashString(`${seed.processor}:${seed.descriptor}`));
  const vampHistory = buildHistory(rng, seed.vampRatioPct, 0.12);
  const mastercardHistory = buildHistory(rng, seed.mastercardRatioPct, 0.2);
  return {
    descriptor: seed.descriptor,
    processor: seed.processor,
    merchantEntity: seed.merchantEntity,
    settledTransactionCount: seed.settledTransactionCount,
    vampFraudDisputeCount: Math.round((seed.vampRatioPct / 100) * seed.settledTransactionCount),
    mastercardChargebackCount: Math.round((seed.mastercardRatioPct / 100) * seed.settledTransactionCount),
    vampHistory,
    mastercardHistory,
  };
}

let cachedProfiles: DescriptorRiskProfile[] | undefined;

export function getRiskProfiles(): DescriptorRiskProfile[] {
  cachedProfiles ??= DESCRIPTOR_SEEDS.map(buildProfile);
  return cachedProfiles;
}

export function getProcessorsWithRiskData(): ProcessorId[] {
  return PROCESSORS.filter((p) => getRiskProfiles().some((profile) => profile.processor === p));
}

export function getDescriptorsForProcessor(processor: ProcessorId): DescriptorRiskProfile[] {
  return getRiskProfiles().filter((p) => p.processor === processor);
}

export function getRiskProfile(
  processor: ProcessorId,
  descriptor: string,
): DescriptorRiskProfile | undefined {
  return getRiskProfiles().find((p) => p.processor === processor && p.descriptor === descriptor);
}
