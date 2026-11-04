import { describe, expect, it } from "vitest";
import { checkSpend, spentInLast24h, type Spend } from "../src/guardrails.ts";

const caps = { perPurchaseZat: 3_000_000, perDayZat: 10_000_000 };
const spend = (hoursAgo: number, zat: number): Spend => ({
  at: new Date(Date.parse("2026-11-04T12:00:00Z") - hoursAgo * 3600_000).toISOString(), quoteId: "q", zat, txid: "t",
});

describe("agent guardrails", () => {
  it("lets the agent pay within every cap", () => {
    expect(checkSpend(1_100_000, caps, 0)).toBeNull();
    expect(checkSpend(3_000_000, caps, 7_000_000)).toBeNull(); // exactly at both caps
  });

  it("names the limit a human has to approve past, budget first", () => {
    expect(checkSpend(1_100_000, caps, 0, 1_000_000)).toEqual({ limit: "budget", maxZat: 1_000_000 });
    expect(checkSpend(3_750_000, caps, 0)).toEqual({ limit: "perPurchase", maxZat: 3_000_000 });
    expect(checkSpend(1_100_000, caps, 9_000_000)).toEqual({ limit: "perDay", maxZat: 10_000_000, spentZat: 9_000_000 });
  });

  it("counts only the last rolling 24 h of payments", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(spentInLast24h([spend(1, 1_100_000), spend(23.9, 2_000_000), spend(24.1, 5_000_000)], now)).toBe(3_100_000);
    expect(spentInLast24h([], now)).toBe(0);
  });
});
