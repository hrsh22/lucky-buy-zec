// Lucky Buy game maths: tiers, the provably fair Draw, money conversions and Kelly admission.
// Cross-checked against reference/lucky_buy.py through test/vectors.json.
import { createHash } from "node:crypto";

export const GAME_VERSION = "LUCKY_BUY_V1";
export const BPS = 10_000;
export const ZAT_PER_ZEC = 100_000_000;
/** Expected Final Price of every tier: 105% of R, the 5% target margin. */
export const TARGET_FINAL_BPS = 10_500;
/** Smallest note we send: the delivery memo still needs a note when the Refund is zero. */
export const MIN_NOTE_ZAT = 10_000;
/** Admission bets this fraction of full Kelly (half-Kelly). */
export const KELLY_FRACTION = 0.5;

export type TierId = "standard" | "safe" | "classic" | "moonshot";

export interface Outcome {
  finalBps: number; // Final Price, bps of the Reference Price
  probBps: number; // probability, bps; a tier's outcomes sum to 10,000
}

export interface Tier {
  id: TierId;
  name: string;
  maxBps: number; // Maximum Price paid up front, bps of R
  outcomes: readonly Outcome[]; // ascending finalBps: the Draw's bucket order
}

function makeTier(id: TierId, name: string, rows: Array<[finalBps: number, probBps: number]>): Tier {
  const outcomes = rows.map(([finalBps, probBps]) => ({ finalBps, probBps }));
  const t: Tier = { id, name, maxBps: outcomes.at(-1)!.finalBps, outcomes };
  checkTier(t);
  return t;
}

/** Throws unless the tier is a valid Game Version 1 table (README "Rules every tier must satisfy"). */
export function checkTier(t: Tier): void {
  const fail = (why: string) => {
    throw new Error(`tier ${t.id}: ${why}`);
  };
  let total = 0;
  let weighted = 0;
  t.outcomes.forEach((o, i) => {
    if (!Number.isInteger(o.finalBps) || !Number.isInteger(o.probBps) || o.probBps <= 0) fail("non-integer or empty outcome");
    if (i > 0 && o.finalBps <= t.outcomes[i - 1]!.finalBps) fail("outcomes not strictly ascending");
    total += o.probBps;
    weighted += o.finalBps * o.probBps;
  });
  if (total !== BPS) fail(`probabilities sum to ${total}`);
  if (t.id !== "standard" && weighted !== TARGET_FINAL_BPS * BPS) fail("expected Final Price isn't 105%");
  if (t.outcomes[0]!.finalBps < 0) fail("negative Final Price");
  if (t.maxBps !== t.outcomes.at(-1)!.finalBps) fail("Maximum Price isn't the worst outcome");
}

export const TIERS: Readonly<Record<TierId, Tier>> = {
  standard: makeTier("standard", "Standard", [[10_000, 10_000]]),
  safe: makeTier("safe", "Safe", [[8_000, 50], [9_000, 200], [9_500, 600], [10_000, 2_150], [10_800, 7_000]]),
  classic: makeTier("classic", "Classic", [
    [5_000, 100], [6_000, 100], [7_000, 100], [8_000, 100], [9_000, 200],
    [9_500, 300], [10_000, 1_300], [10_500, 2_100], [11_000, 5_700],
  ]),
  moonshot: makeTier("moonshot", "Moonshot", [
    [0, 25], [2_500, 25], [5_000, 100], [7_500, 200], [9_000, 400], [10_000, 6_515], [12_500, 2_735],
  ]),
};

// ---------------------------------------------------------------- the Draw

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TXID = /^[0-9a-f]{64}$/;

const sha256 = (...parts: Array<Uint8Array | string>) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** The commitment published in a quote before payment: hex SHA-256 of the 32 seed bytes. */
export function commitment(seed: Uint8Array): string {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  return sha256(seed).toString("hex");
}

/**
 * Roll in [0, 10000): first 8 bytes, big-endian, of SHA-256(seed ‖ quoteId ‖ paymentTxid ‖ "LUCKY_BUY_V1"),
 * mod 10,000. The operator commits to the seed before the buyer's txid exists, so neither side picks the roll.
 */
export function roll(seed: Uint8Array, quoteId: string, paymentTxid: string): number {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  if (!UUID.test(quoteId)) throw new Error("quoteId must be a lowercase UUID");
  if (!TXID.test(paymentTxid)) throw new Error("paymentTxid must be 64 lowercase hex chars");
  return Number(sha256(seed, quoteId, paymentTxid, GAME_VERSION).readBigUInt64BE(0) % BigInt(BPS));
}

/** Walks the cumulative buckets in ascending Final Price order. */
export function outcomeForRoll(t: Tier, r: number): Outcome {
  let upTo = 0;
  for (const o of t.outcomes) {
    upTo += o.probBps;
    if (r < upTo) return o;
  }
  throw new Error(`roll ${r} out of range`);
}

export interface DrawResult {
  roll: number;
  finalBps: number;
}

/** Standard has a single outcome, so its roll is fixed at 0. */
export function draw(t: Tier, seed: Uint8Array, quoteId: string, paymentTxid: string): DrawResult {
  const r = t.id === "standard" ? 0 : roll(seed, quoteId, paymentTxid);
  return { roll: r, finalBps: outcomeForRoll(t, r).finalBps };
}

// ---------------------------------------------------------------- money (integer zat throughout)

const positiveInt = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what} must be a positive integer`);
};

/** ZEC to pay up front: R × M at the locked rate, rounded up to the zat. */
export function maxPriceZat(t: Tier, referenceUsdCents: number, usdCentsPerZec: number): number {
  positiveInt(referenceUsdCents, "referenceUsdCents");
  positiveInt(usdCentsPerZec, "usdCentsPerZec");
  const numerator = BigInt(referenceUsdCents) * BigInt(t.maxBps) * BigInt(ZAT_PER_ZEC);
  const denominator = BigInt(BPS) * BigInt(usdCentsPerZec);
  return Number((numerator + denominator - 1n) / denominator);
}

/** Refund as a share of what was actually paid, (M − f)/M, rounded down (in the house's favour). */
export function refundZat(t: Tier, paidZat: number, finalBps: number): number {
  positiveInt(paidZat, "paidZat");
  if (finalBps < 0 || finalBps > t.maxBps) throw new Error("finalBps outside the tier");
  return Number((BigInt(paidZat) * BigInt(t.maxBps - finalBps)) / BigInt(t.maxBps));
}

/** The delivery note carries the Refund, or the minimum note when the Refund is zero. */
export const deliveryZat = (refund: number): number => Math.max(refund, refund > 0 ? 0 : MIN_NOTE_ZAT);

/** Decimal ZEC for URIs and the UI: no trailing zeros, no exponent. */
export function formatZec(zat: number): string {
  if (!Number.isSafeInteger(zat) || zat < 0) throw new Error("zat must be a non-negative integer");
  const whole = Math.trunc(zat / ZAT_PER_ZEC);
  const frac = (zat % ZAT_PER_ZEC).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ---------------------------------------------------------------- Kelly admission

/**
 * Full-Kelly stake R/B for the house, whose result per purchase is f − 1 (in units of R).
 * Grid search: x = i/10⁴ ÷ worst-case loss, i = 1…9999; the first maximum of E[ln(1 + x(f − 1))] wins.
 */
export function kellyRatio(t: Tier): number {
  const worstLoss = (BPS - t.outcomes[0]!.finalBps) / BPS;
  if (worstLoss <= 0) return Infinity; // the house can't lose: no limit
  let bestGrowth = -Infinity;
  let bestX = 0;
  for (let i = 1; i < BPS; i++) {
    const x = i / 1e4 / worstLoss;
    let growth = 0;
    for (const o of t.outcomes) growth += (o.probBps / 1e4) * Math.log(1 + x * (o.finalBps / 1e4 - 1));
    if (growth > bestGrowth) {
      bestGrowth = growth;
      bestX = x;
    }
  }
  return bestX;
}

export const KELLY: Readonly<Record<TierId, number>> = {
  standard: kellyRatio(TIERS.standard),
  safe: kellyRatio(TIERS.safe),
  classic: kellyRatio(TIERS.classic),
  moonshot: kellyRatio(TIERS.moonshot),
};

/** The house's worst case on one purchase, in USD cents: (1 − f_min) × R, rounded up. */
export const worstHouseLossUsdCents = (t: Tier, referenceUsdCents: number): number =>
  Math.ceil((referenceUsdCents * (BPS - t.outcomes[0]!.finalBps)) / BPS);

/** Largest R (USD cents) a tier admits: c × Kelly × (reserve − worst losses already in flight). */
export function admissionLimitUsdCents(t: Tier, reserveUsdCents: number, openLossUsdCents: number, c = KELLY_FRACTION): number {
  if (t.id === "standard") return Infinity;
  return Math.max(0, Math.floor(c * KELLY[t.id] * (reserveUsdCents - openLossUsdCents)));
}

/** Tiers that can be quoted for a Voucher of R right now (Standard always can). */
export const availableTiers = (referenceUsdCents: number, reserveUsdCents: number, openLossUsdCents: number, c = KELLY_FRACTION): TierId[] =>
  (Object.keys(TIERS) as TierId[]).filter(
    (id) => referenceUsdCents <= admissionLimitUsdCents(TIERS[id], reserveUsdCents, openLossUsdCents, c),
  );
