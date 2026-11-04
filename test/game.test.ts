// game.ts against the independent Python reference (reference/lucky_buy.py → test/vectors.json).
import { describe, expect, it } from "vitest";
import vectors from "./vectors.json" with { type: "json" };
import {
  KELLY, MIN_NOTE_ZAT, TIERS, admissionLimitUsdCents, availableTiers, checkTier, commitment, deliveryZat, draw,
  formatZec, maxPriceZat, outcomeForRoll, refundZat, roll, worstHouseLossUsdCents, type TierId,
} from "../src/game.ts";

const LUCKY = ["safe", "classic", "moonshot"] as const;
const seed = (hex: string) => Buffer.from(hex, "hex");

describe("tiers", () => {
  it.each(LUCKY)("%s matches the reference table and Kelly ratio", (id) => {
    expect(TIERS[id].outcomes.map((o) => [o.finalBps, o.probBps])).toEqual(vectors.tables[id]);
    expect(KELLY[id]).toBe(vectors.kelly[id]);
  });

  it("every tier averages exactly 105% (Standard is exactly 100%)", () => {
    for (const id of LUCKY) {
      const t = TIERS[id];
      expect(t.outcomes.reduce((s, o) => s + o.finalBps * o.probBps, 0)).toBe(10_500 * 10_000);
    }
    expect(TIERS.standard.outcomes).toEqual([{ finalBps: 10_000, probBps: 10_000 }]);
  });

  it("rejects invalid tables", () => {
    const base = { id: "safe" as TierId, name: "x", maxBps: 11_000 };
    expect(() => checkTier({ ...base, outcomes: [{ finalBps: 11_000, probBps: 9_999 }] })).toThrow(/sum/);
    expect(() => checkTier({ ...base, maxBps: 12_000, outcomes: [{ finalBps: 10_000, probBps: 5_000 }, { finalBps: 12_000, probBps: 5_000 }] })).toThrow(/105/);
    expect(() => checkTier({ ...base, outcomes: [{ finalBps: 11_000, probBps: 5_000 }, { finalBps: 10_000, probBps: 5_000 }] })).toThrow(/ascending/);
  });
});

describe("the Draw", () => {
  it.each(vectors.draws.map((d, i) => [i, d] as const))("vector %i: commitment, roll and outcome", (_, d) => {
    expect(commitment(seed(d.serverSeed))).toBe(d.commit);
    expect(roll(seed(d.serverSeed), d.quoteId, d.paymentTxid)).toBe(d.roll);
    for (const id of LUCKY) expect(draw(TIERS[id], seed(d.serverSeed), d.quoteId, d.paymentTxid).finalBps).toBe(d.finalBps[id]);
  });

  it("Standard never rolls", () => {
    const d = vectors.draws[0]!;
    expect(draw(TIERS.standard, seed(d.serverSeed), d.quoteId, d.paymentTxid)).toEqual({ roll: 0, finalBps: 10_000 });
  });

  it("maps every roll onto the cumulative buckets", () => {
    const counts = new Map<number, number>();
    for (let r = 0; r < 10_000; r++) {
      const f = outcomeForRoll(TIERS.moonshot, r).finalBps;
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    expect([...counts]).toEqual(TIERS.moonshot.outcomes.map((o) => [o.finalBps, o.probBps]));
    expect(() => outcomeForRoll(TIERS.moonshot, 10_000)).toThrow();
  });

  it("validates its inputs", () => {
    const d = vectors.draws[0]!;
    expect(() => roll(seed("00"), d.quoteId, d.paymentTxid)).toThrow(/32 bytes/);
    expect(() => roll(seed(d.serverSeed), "ABCDEF00-0000-4000-8000-000000000000", d.paymentTxid)).toThrow(/UUID/);
    expect(() => roll(seed(d.serverSeed), d.quoteId, "ab")).toThrow(/hex/);
  });
});

describe("money", () => {
  it("prices up front, rounding up to the zat", () => {
    // $10 Classic at $1,000/ZEC: 110% of $10 = $11 = 0.011 ZEC
    expect(maxPriceZat(TIERS.classic, 1_000, 100_000)).toBe(1_100_000);
    // $1 Safe at $333.33/ZEC = 0.00324003… ZEC → rounds up
    expect(maxPriceZat(TIERS.safe, 100, 33_333)).toBe(324_004);
  });

  it("refunds (M − f)/M of what was paid, rounding down", () => {
    expect(refundZat(TIERS.classic, 1_100_000, 11_000)).toBe(0);
    expect(refundZat(TIERS.classic, 1_100_000, 5_000)).toBe(600_000);
    expect(refundZat(TIERS.moonshot, 1_250_000, 0)).toBe(1_250_000);
    expect(refundZat(TIERS.safe, 324_004, 8_000)).toBe(84_001); // floor(324004 × 2800 / 10800 = 84001.03)
    expect(() => refundZat(TIERS.safe, 100, 11_000)).toThrow();
  });

  it("sends at least the minimum note so the memo can travel", () => {
    expect(deliveryZat(0)).toBe(MIN_NOTE_ZAT);
    expect(deliveryZat(5)).toBe(5);
    expect(deliveryZat(250_000)).toBe(250_000);
  });

  it("formats ZEC without trailing zeros", () => {
    expect(formatZec(0)).toBe("0");
    expect(formatZec(100_000_000)).toBe("1");
    expect(formatZec(1_100_000)).toBe("0.011");
    expect(formatZec(123_456_789)).toBe("1.23456789");
    expect(() => formatZec(1.5)).toThrow();
  });
});

describe("Kelly admission", () => {
  it("limits R by half-Kelly over the reserve left after open worst losses", () => {
    // $100 reserve, nothing open
    expect(admissionLimitUsdCents(TIERS.moonshot, 10_000, 0)).toBe(Math.floor(0.5 * KELLY.moonshot * 10_000));
    expect(admissionLimitUsdCents(TIERS.standard, 0, 0)).toBe(Infinity);
    expect(admissionLimitUsdCents(TIERS.safe, 10_000, 20_000)).toBe(0);
  });

  it("worst house loss is (1 − f_min) × R", () => {
    expect(worstHouseLossUsdCents(TIERS.moonshot, 1_000)).toBe(1_000);
    expect(worstHouseLossUsdCents(TIERS.classic, 1_000)).toBe(500);
    expect(worstHouseLossUsdCents(TIERS.safe, 1_001)).toBe(201);
  });

  it("offers only the tiers the reserve can back", () => {
    expect(availableTiers(1_000, 10_000, 0)).toEqual(["standard", "safe", "classic", "moonshot"]);
    expect(availableTiers(5_000, 10_000, 0)).toEqual(["standard", "safe", "classic"]);
    expect(availableTiers(1_000, 0, 0)).toEqual(["standard"]);
  });
});
