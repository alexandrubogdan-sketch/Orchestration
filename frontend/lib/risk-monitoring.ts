import { PROCESSORS, type ProcessorId } from "./types";
import type {
  DescriptorRiskProfile,
  RiskMonthPoint,
  RiskStatus,
  RiskTierDefinition,
  Scheme,
} from "./risk-monitoring-types";

/* ------------------------------------------------------------------ *
 * Real, current scheme-monitoring thresholds.
 *
 * VISA — Acquirer Monitoring Program (VAMP)
 * VAMP replaced Visa's five legacy fraud/dispute programs (incl. VFMP
 * and VDMP) on April 1, 2025. It combines fraud (TC40) and dispute
 * (TC15) counts on card-not-present VisaNet transactions into one
 * ratio: VAMP Ratio = (TC40 fraud count + TC15 dispute count) /
 * settled (TC05) transaction count. Enumeration (card-testing) is
 * tracked separately and is not modeled here.
 *
 * Merchant-level "Excessive" ratio threshold:
 *   - 2.2% at initial June 2025 rollout / Oct 1, 2025 fee start.
 *   - Tightens to 1.5% globally (ex. MENA) from April 1, 2026.
 * A merchant must also clear a minimum volume floor of 1,500
 * combined fraud+dispute transactions/month to be in scope at all.
 * "Excessive" merchants are fined $8 per fraudulent/disputed
 * transaction by their acquirer, who passes the cost down.
 * Below the Excessive floor we treat everything as "Standard" (Visa
 * does not publish a separate merchant-level "Above Standard" warning
 * tier the way it does for acquirers, so we use a single split here).
 *
 * Sources (fetched July 2026, values current as of Visa's April 2026
 * global rule change):
 *   - https://www.checkout.com/blog/visa-acquirer-monitoring-program-explained
 *     ("From April 1, 2026 ... lower thresholds ... 1.5%"; "$8 per
 *     fraudulent or disputed transaction" excessive merchant fee;
 *     1,500/month minimum count)
 *   - https://corporate.visa.com/content/dam/VCOM/corporate/visa-perspectives/security-and-trust/documents/visa-acquirer-monitoring-program-fact-sheet-2025.pdf
 *     (Visa's own VAMP fact sheet — program mechanics, TC40/TC15/TC05)
 *   - https://chargebacks911.com/visa-acquirer-monitoring-program/
 *     (2025 -> 2026 threshold step-down timeline)
 *
 * MASTERCARD — Excessive Chargeback Program (ECP)
 * ECP has two escalating merchant tiers, both requiring the merchant
 * to clear a minimum chargeback count AND ratio in the same month
 * (ratio = current-month chargebacks / prior-month sales transactions,
 * x100):
 *   - Excessive Chargeback Merchant (ECM):      100–299 chargebacks
 *     AND a 1.5%–2.99% ratio.
 *   - High Excessive Chargeback Merchant (HECM): >=300 chargebacks
 *     AND >=3% ratio.
 * Exiting either tier requires 3 consecutive months back under
 * threshold. Fines escalate from ~$1,000/month up past $200,000+ for
 * sustained HECM status, plus possible Issuer Recovery Assessment /
 * MATCH listing. (Mastercard's separate Excessive Fraud Merchant (EFM)
 * program for pure CNP-fraud TC40s is not modeled here — this
 * dashboard tracks the chargeback/dispute side.)
 *
 * Sources (fetched July 2026):
 *   - https://www.chargeflow.io/blog/avoid-mastercard-chargeback-monitoring-programs
 *     ("ECM ... 100-299 chargebacks AND a 1.5%-2.99% ratio"; "HECM ...
 *     >=300 chargebacks AND >=3%"; both measured over two months)
 *   - https://www.chargebackstop.com/blog/2026-mastercard-ecp-remediation-guide-get-back-under-the-thresholds-in-30-days
 *     (2026 remediation guide corroborating the same tier cutoffs and
 *     fine escalation from $1,000 to $200,000+)
 *
 * These are the same public figures multiple independent industry
 * sources (Checkout.com, Chargebacks911, Chargeflow, ChargebackStop)
 * converge on as of this app's build date; revisit if either network
 * republishes updated fact sheets.
 * ------------------------------------------------------------------ */

/** Visa VAMP — minimum monthly combined fraud+dispute count to be in scope. */
export const VAMP_MIN_MONTHLY_COUNT = 1500;
/** Visa VAMP — per-transaction fee levied on merchants in the Excessive tier. */
export const VAMP_EXCESSIVE_FEE_USD = 8;

/** Mastercard ECP — minimum chargeback counts backing each tier (paired with the ratio floor). */
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

/** Pure classification: given a scheme and a ratio (percent), return the
 *  matching tier plus how far the ratio sits toward the *next* tier up
 *  (0..1, can exceed 1 once already in the worst tier). */
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

/* ------------------------------------------------------------------ *
 * Mock dataset — plausible, clearly-a-demo fraud/dispute ratios per
 * PSP + billing descriptor, following the same deterministic-PRNG
 * convention as lib/mock-data.ts (mulberry32 seeded per descriptor so
 * re-renders and server/client don't drift).
 * ------------------------------------------------------------------ */

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
  // Walk backward from the current (last) known ratio so the series
  // trends toward endRatioPct rather than looking like pure noise.
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
  /** Target current-month ratios, chosen to cover the interesting states. */
  vampRatioPct: number;
  mastercardRatioPct: number;
}

/** Seed catalog — one deliberately-over-threshold descriptor
 *  ("ACME*DIGITALGOODS" on Solidgate) so the dashboard has something
 *  to flag out of the box, plus several comfortably-under-threshold
 *  ones across both PSPs this backend supports. */
const DESCRIPTOR_SEEDS: DescriptorSeed[] = [
  {
    descriptor: "ACME*DIGITALGOODS",
    processor: "solidgate",
    merchantEntity: "US-LLC",
    settledTransactionCount: 118_400,
    vampRatioPct: 1.62, // over Visa's 1.5% Excessive floor
    mastercardRatioPct: 3.35, // over Mastercard's 3% HECM floor
  },
  {
    descriptor: "ACME* PRO SUB",
    processor: "stripe",
    merchantEntity: "US-LLC",
    settledTransactionCount: 86_200,
    vampRatioPct: 1.12, // approaching-threshold band
    mastercardRatioPct: 1.85, // ECM band
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
