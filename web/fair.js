// Browser port of the fair Draw (src/game.ts) and quote signing (canonicalJson in src/server.ts).
// Shared by app.js (tier tables) and verify.html (independent recomputation).

export const GAME_VERSION = "LUCKY_BUY_V1";
export const BPS = 10_000;

// Mirror of TIERS in src/game.ts. Keep identical; verify.html?selftest checks it against test/vectors.json.
const tier = (id, name, maxBps, table) => ({
  id,
  name,
  maxBps,
  outcomes: table.map(([finalBps, probBps]) => ({ finalBps, probBps })).sort((a, b) => a.finalBps - b.finalBps),
});

export const TIERS = {
  standard: tier("standard", "Standard", 10_000, [[10_000, 10_000]]),
  safe: tier("safe", "Safe", 10_800, [[8_000, 50], [9_000, 200], [9_500, 600], [10_000, 2_150], [10_800, 7_000]]),
  classic: tier("classic", "Classic", 11_000, [
    [5_000, 100], [6_000, 100], [7_000, 100], [8_000, 100], [9_000, 200],
    [9_500, 300], [10_000, 1_300], [10_500, 2_100], [11_000, 5_700],
  ]),
  moonshot: tier("moonshot", "Moonshot", 12_500, [
    [0, 25], [2_500, 25], [5_000, 100], [7_500, 200], [9_000, 400], [10_000, 6_515], [12_500, 2_735],
  ]),
};

export const LUCKY_TIERS = ["safe", "classic", "moonshot"];

const enc = new TextEncoder();
export const hexToBytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
export const bytesToHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

/** roll = u64be(SHA256(seed32 ‖ ascii(quoteId) ‖ ascii(txid) ‖ ascii("LUCKY_BUY_V1"))[0..8]) mod 10000 */
export async function roll(seedHex, quoteId, paymentTxid) {
  const seed = hexToBytes(seedHex);
  if (seed.length !== 32) throw new Error("server seed must be 32 bytes");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(quoteId)) throw new Error("quoteId must be a lowercase UUID");
  if (!/^[0-9a-f]{64}$/.test(paymentTxid)) throw new Error("paymentTxid must be 64 lowercase hex chars");
  const parts = [seed, enc.encode(quoteId), enc.encode(paymentTxid), enc.encode(GAME_VERSION)];
  const msg = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((off, p) => (msg.set(p, off), off + p.length), 0);
  const d = await sha256(msg);
  return Number(new DataView(d.buffer).getBigUint64(0, false) % BigInt(BPS));
}

/** Cumulative buckets over a table sorted by ascending finalBps (game.ts outcomeForRoll). */
export function outcomeForRoll(table, r) {
  if (!Number.isInteger(r) || r < 0 || r >= BPS) throw new Error(`roll out of range: ${r}`);
  let cum = 0;
  for (const o of table) {
    cum += o.probBps;
    if (r < cum) return o;
  }
  throw new Error("probabilities do not sum to 10000");
}

/** Same as src/server.ts: keys sorted recursively, no whitespace. */
export const canonicalJson = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x,
  );

export async function verifySignature(quote, sigHex, pubHex) {
  const key = await crypto.subtle.importKey("raw", hexToBytes(pubHex), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(sigHex), enc.encode(canonicalJson(quote)));
}

// ---------------------------------------------------------------- display helpers

/** "1.23456789" style, like formatZec in game.ts. */
export function formatZec(zat) {
  const whole = Math.floor(zat / 1e8);
  const frac = String(zat % 1e8).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
export const unitFor = (network) => (network === "mainnet" ? "ZEC" : "TAZ");
export const pct = (bps) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
export const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

/** Horizontal strip of the roll's buckets: widths are probabilities, in Draw order. */
export function outcomeBar(table, { labels = true } = {}) {
  const bar = document.createElement("div");
  bar.className = "bar";
  for (const o of table) {
    const seg = document.createElement("span");
    seg.className = "seg " + (o.finalBps < BPS ? "below" : o.finalBps === BPS ? "at" : "above");
    seg.style.flex = `${o.probBps} 0 0`; // basis 0 so widths are exactly proportional (the needle relies on it)
    // Deeper discount = stronger tint.
    seg.style.setProperty("--depth", o.finalBps < BPS ? (BPS - o.finalBps) / BPS : 0);
    seg.title = `Final Price ${pct(o.finalBps)} · chance ${pct(o.probBps)}`;
    if (labels && o.probBps >= 900) seg.textContent = pct(o.finalBps);
    bar.append(seg);
  }
  return bar;
}
