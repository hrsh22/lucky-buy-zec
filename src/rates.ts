// ZEC/USD rate in integer cents. Testnet: fixed play-money rate (D14). Mainnet: CoinGecko → Kraken, 60 s cache.
import type { Rates, ReserveView } from "./types.ts";

export type RateSource = ReserveView["rateSource"];

export const rateSource = (env: NodeJS.ProcessEnv = process.env): RateSource =>
  env.ZCASH_NETWORK === "mainnet" ? "live" : "testnet_fixed";

const getJson = async (url: string): Promise<any> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

const toCents = (usd: unknown): number => {
  const cents = Math.round(Number(usd) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error(`bad rate ${usd}`);
  return cents;
};

const coingecko = async () =>
  toCents((await getJson("https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd")).zcash?.usd);

const kraken = async () => {
  const j = await getJson("https://api.kraken.com/0/public/Ticker?pair=ZECUSD");
  return toCents((Object.values(j.result ?? {})[0] as any)?.c?.[0]); // c = last trade [price, volume]
};

export function makeRates(env: NodeJS.ProcessEnv = process.env): Rates & { source: RateSource } {
  const source = rateSource(env);
  if (source === "testnet_fixed") {
    const fixed = Number(env.TESTNET_USD_CENTS_PER_ZEC ?? 100_000);
    if (!Number.isSafeInteger(fixed) || fixed <= 0) throw new Error("TESTNET_USD_CENTS_PER_ZEC must be a positive integer");
    return { source, usdCentsPerZec: async () => fixed };
  }
  let cache: { cents: number; at: number } | undefined;
  return {
    source,
    async usdCentsPerZec() {
      if (cache && Date.now() - cache.at < 60_000) return cache.cents;
      const cents = await coingecko().catch(() => kraken()); // both failing throws; server refuses to quote
      cache = { cents, at: Date.now() };
      return cents;
    },
  };
}
