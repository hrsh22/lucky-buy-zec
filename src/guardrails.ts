// Spending guardrails for the MCP agent's own wallet (lucky_buy). Pure so they're tested on their own.

export interface Caps {
  perPurchaseZat: number;
  perDayZat: number;
}

/** One payment the agent made; kept in a ledger file so the daily cap survives restarts. */
export interface Spend {
  at: string;
  quoteId: string;
  zat: number;
  txid: string;
}

const DAY_MS = 24 * 3600_000;

/** What the agent paid in the rolling 24 h before `now`. Refunds don't reduce it: the cap limits outflow. */
export const spentInLast24h = (ledger: Spend[], now = Date.now()): number =>
  ledger.filter((s) => now - Date.parse(s.at) < DAY_MS).reduce((sum, s) => sum + s.zat, 0);

export type Refusal =
  | { limit: "budget"; maxZat: number }
  | { limit: "perPurchase"; maxZat: number }
  | { limit: "perDay"; maxZat: number; spentZat: number };

/** Null when the agent may pay `priceZat` itself; otherwise which limit a human has to approve past. */
export function checkSpend(priceZat: number, caps: Caps, spentZat: number, budgetZat?: number): Refusal | null {
  if (budgetZat !== undefined && priceZat > budgetZat) return { limit: "budget", maxZat: budgetZat };
  if (priceZat > caps.perPurchaseZat) return { limit: "perPurchase", maxZat: caps.perPurchaseZat };
  if (spentZat + priceZat > caps.perDayZat) return { limit: "perDay", maxZat: caps.perDayZat, spentZat };
  return null;
}
