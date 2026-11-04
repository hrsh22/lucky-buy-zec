// MCP stdio server: lets an agent shop with Lucky Buy.
// - lucky_quote returns a ZIP-321 URI for the user's own wallet to pay (the agent holds no keys).
// - lucky_buy pays from the agent's own capped shielded wallet (AGENT_DIR) and reads the Voucher code
//   back from the delivery memo. Anything above the caps comes back as a URI for the human to approve.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TIERS, ZAT_PER_ZEC, formatZec, type TierId } from "./game.ts";
import { ZingoWallet } from "./wallet.ts";
import { checkSpend, spentInLast24h, type Spend } from "./guardrails.ts";
import type { Product, PurchaseView, QuoteResponse, SignedQuote, VerifyView, ZcashNetwork } from "./types.ts";

const API = (process.env.LUCKY_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json" } });
  return (await res.json()) as T;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

const server = new McpServer({ name: "lucky-buy", version: "0.2.0" });

// ---------------------------------------------------------------- agent wallet + guardrails

const env = process.env;
const network = (env.ZCASH_NETWORK ?? "testnet") as ZcashNetwork;
const unit = network === "testnet" ? "TAZ" : "ZEC";
const zat = (zec: number) => Math.round(zec * ZAT_PER_ZEC);
const CAPS = {
  perPurchaseZat: zat(Number(env.AGENT_MAX_ZEC_PER_PURCHASE ?? 0.03)),
  perDayZat: zat(Number(env.AGENT_MAX_ZEC_PER_DAY ?? 0.1)),
};
const agent = env.AGENT_DIR
  ? new ZingoWallet({
      // AGENT_ZINGO_BIN: a Nym build, so the agent's payments are broadcast over the mixnet (sync is still direct)
      bin: env.AGENT_ZINGO_BIN ?? env.ZINGO_BIN ?? "zingo-cli", network, server: env.LIGHTWALLETD_URL ?? "https://testnet.zec.rocks:443",
      syncBeforeSend: true, dirs: { till: env.AGENT_DIR, reserve: env.AGENT_DIR },
    })
  : null;

/** Spend ledger: every payment the agent made, so the daily cap survives restarts. */
const LEDGER = env.AGENT_LEDGER ?? `${env.AGENT_DIR ?? "."}/../agent-ledger.json`;
const ledger = (): Spend[] => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : []);
const spentTodayZat = () => spentInLast24h(ledger());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The delivery memo the till sent to the agent's wallet for this purchase, once it has arrived. */
async function codeFromMemo(p: PurchaseView): Promise<string | null> {
  if (!agent || !p.sendTxid) return null;
  const note = (await agent.received()).find((n) => n.txid === p.sendTxid && n.memo?.includes(p.id));
  return note?.memo ?? null;
}


server.registerTool(
  "lucky_products",
  { description: "The storefront's featured gift cards, with their Reference Price R in USD. Use lucky_search to find anything else." },
  async () => {
    const ps = await api<Product[]>("/api/products");
    return text(ps.map((p) => `${p.id} — ${p.name}${p.isTest ? " (test)" : ""}: R = $${(p.referenceUsdCents / 100).toFixed(2)}`).join("\n"));
  },
);

server.registerTool(
  "lucky_search",
  {
    description:
      "Search Bitrefill's whole catalog for gift cards (e.g. 'flipkart', 'swiggy', 'amazon') in a country (ISO code, default IN). " +
      "Returns package ids with their Reference Price R in USD, cheapest first; pass an id to lucky_buy or lucky_quote. " +
      "Phone top-ups are left out because they'd need a phone number.",
    inputSchema: { query: z.string().min(2), country: z.string().length(2).optional() },
  },
  async ({ query, country }) => {
    const qs = new URLSearchParams({ q: query, country: (country ?? "IN").toUpperCase() });
    const ps = await api<Product[]>(`/api/search?${qs}`);
    if (!ps.length) return text(`Nothing found for "${query}". Try a brand name, or another country code.`);
    return text(ps.map((p) => `${p.id}: ${p.name}, ${p.faceValue.amount} ${p.faceValue.currency} = R $${(p.referenceUsdCents / 100).toFixed(2)}`).join("\n"));
  },
);

server.registerTool(
  "lucky_quote",
  {
    description:
      "Quote a Voucher purchase. tier 'standard' pays exactly R; 'safe' / 'classic' / 'moonshot' pay a Maximum Price up front and a provably fair Draw " +
      "refunds part of it (every tier has the same expected Final Price, 105% of R; higher tiers only add variance). The Voucher is always delivered, " +
      "with its code in an encrypted memo to returnAddress. Returns a ZIP-321 payment URI for the user's wallet to pay; the agent never pays. " +
      "Pass maxZec as the user's budget: the quote is refused if the Maximum Price exceeds it.",
    inputSchema: {
      productId: z.string(),
      tier: z.enum(Object.keys(TIERS) as [TierId, ...TierId[]]),
      returnAddress: z.string().describe("The user's shielded unified address (u1… / utest1…); Refund and code go here"),
      maxZec: z.number().positive().optional(),
    },
  },
  async ({ productId, tier, returnAddress, maxZec }) => {
    const r = await api<QuoteResponse>("/api/quote", { method: "POST", body: JSON.stringify({ productId, tier, returnAddress }) });
    if ("error" in r) {
      const avail = "availableTiers" in r ? ` Available tiers: ${r.availableTiers.join(", ")}.` : "";
      return text(`Quote refused: ${r.error}.${avail}`);
    }
    const { quote: q, zip321 } = r as SignedQuote;
    const unit = q.network === "testnet" ? "TAZ" : "ZEC";
    if (maxZec !== undefined && q.maxPriceZat > Math.floor(maxZec * ZAT_PER_ZEC))
      return text(`Over budget: the Maximum Price is ${formatZec(q.maxPriceZat)} ${unit}, above the ${maxZec} ${unit} limit. Nothing to pay; the quote will expire.`);
    const odds = q.table
      .map((o) => `  pay ${pct(o.finalBps).padStart(7)} of R (${formatZec(Math.floor((q.maxPriceZat * o.finalBps) / q.maxBps))} ${unit}) — chance ${pct(o.probBps)}`)
      .join("\n");
    return text(
      [
        `Quote ${q.id} (${q.network}) — ${q.productName}, tier ${q.tier}`,
        `Pay exactly ${formatZec(q.maxPriceZat)} ${unit} (Maximum Price ${pct(q.maxBps)} of R) before ${q.expiresAt}.`,
        `Final Price outcomes:\n${odds}`,
        `Seed commitment: ${q.commit}`,
        `Payment URI (open in the user's Zcash wallet): ${zip321}`,
        `Then check lucky_status with id ${q.id}.`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "lucky_status",
  { description: "Status of a Lucky Buy purchase: payment, Draw outcome, delivery or refund.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const p = await api<PurchaseView & { error?: string }>(`/api/purchase/${id}`);
    if (p.error) return text(`Not found: ${id}`);
    const lines = [`${p.id}: ${p.status}`];
    if (p.finalBps !== undefined) lines.push(`Final Price: ${pct(p.finalBps)} of R (roll ${p.roll}); Refund ${formatZec(p.refundZat ?? 0)}`);
    if (p.sendTxid) lines.push(`Code delivered in an encrypted memo, txid ${p.sendTxid}`);
    if (p.refundReason) lines.push(`Refunded in full (${p.refundReason})${p.refundTxid ? `, txid ${p.refundTxid}` : ""}`);
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "lucky_verify",
  { description: "Verify a drawn purchase was fair: seed commitment, quote signature, roll and outcome.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const v = await api<VerifyView & { error?: string }>(`/api/verify/${id}`);
    if (v.error) return text(`Can't verify yet: ${v.error}`);
    const c = v.checks;
    const ok = Object.values(c).every(Boolean);
    return text(
      [
        `${ok ? "✅ Fair" : "❌ Verification FAILED"} — roll ${v.roll}, Final Price ${pct(v.finalBps)} of R`,
        ...Object.entries(c).map(([k, x]) => `  ${x ? "✓" : "✗"} ${k}`),
        `Revealed seed: ${v.serverSeed} (commit ${v.quote.commit})`,
        `Recheck in a browser: ${API}/verify.html?id=${id}`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "lucky_agent_wallet",
  { description: "The agent's own shielded wallet: address, spendable balance, spending caps and what it spent in the last 24 h." },
  async () => {
    if (!agent) return text("No agent wallet configured (set AGENT_DIR). The agent can still quote; the user's wallet pays.");
    const { spendableZat } = await agent.balance("till");
    return text(
      [
        `Network: ${network}`,
        `Spendable: ${formatZec(spendableZat)} ${unit}`,
        `Caps: ${formatZec(CAPS.perPurchaseZat)} ${unit} per purchase, ${formatZec(CAPS.perDayZat)} ${unit} per 24 h`,
        `Spent in the last 24 h: ${formatZec(spentTodayZat())} ${unit}`,
        "Anything above the caps needs the human: lucky_buy returns a payment link for them to approve and pay.",
      ].join("\n"),
    );
  },
);

server.registerTool(
  "lucky_buy",
  {
    description:
      "Buy a Voucher end to end, paying from the agent's own shielded Zcash wallet, and return the Voucher code read from the encrypted delivery memo. " +
      "Guardrails: the Maximum Price must fit the per-purchase cap, the 24 h cap and the optional maxZec budget; otherwise nothing is paid and a ZIP-321 link " +
      "is returned for the human to approve. Takes ~1-3 minutes (payment confirmation, Draw, Bitrefill purchase, memo delivery). " +
      "tier: standard pays exactly R; safe/classic/moonshot pay a Maximum Price and get a Refund from a provably fair Draw.",
    inputSchema: {
      productId: z.string(),
      tier: z.enum(Object.keys(TIERS) as [TierId, ...TierId[]]),
      maxZec: z.number().positive().optional(),
    },
  },
  async ({ productId, tier, maxZec }) => {
    if (!agent) return text("No agent wallet configured (set AGENT_DIR). Use lucky_quote and let the user's wallet pay.");
    const returnAddress = await agent.newAddress(); // the code comes back to the agent's own wallet
    const r = await api<QuoteResponse>("/api/quote", { method: "POST", body: JSON.stringify({ productId, tier, returnAddress }) });
    if ("error" in r) return text(`Quote refused: ${r.error}${"availableTiers" in r ? `. Available tiers: ${r.availableTiers.join(", ")}` : ""}.`);
    const { quote: q, zip321 } = r as SignedQuote;
    const price = q.maxPriceZat;
    const refusal = checkSpend(price, CAPS, spentTodayZat(), maxZec === undefined ? undefined : zat(maxZec));
    const over =
      refusal?.limit === "budget" ? `the ${maxZec} ${unit} budget`
      : refusal?.limit === "perPurchase" ? `the per-purchase cap of ${formatZec(refusal.maxZat)} ${unit}`
      : refusal?.limit === "perDay" ? `the 24 h cap of ${formatZec(refusal.maxZat)} ${unit} (spent ${formatZec(refusal.spentZat)})`
      : null;
    if (over)
      return text(
        `Needs human approval: ${formatZec(price)} ${unit} is over ${over}. Nothing was paid. ` +
          `If the user approves, they pay this link from their own wallet within 15 minutes: ${zip321} (quote ${q.id}; track it with lucky_status).`,
      );

    const { txid, overMixnet } = await agent.send("till", q.payAddress, price, `Lucky Buy ${q.id}`);
    writeFileSync(LEDGER, JSON.stringify([...ledger(), { at: new Date().toISOString(), quoteId: q.id, zat: price, txid }], null, 2));

    const deadline = Date.now() + 4 * 60_000; // MCP clients time out; lucky_code picks up later
    let p: PurchaseView | undefined;
    while (Date.now() < deadline) {
      await sleep(10_000);
      p = await api<PurchaseView>(`/api/purchase/${q.id}`);
      if (p.status === "DELIVERED" || p.status === "REFUNDED" || p.status === "NEEDS_ATTENTION") break;
    }
    const head = `Paid ${formatZec(price)} ${unit} for ${q.productName} (${q.tier}) from the agent wallet, txid ${txid}` +
      `${overMixnet ? ", broadcast over the Nym mixnet" : ""}.`;
    if (!p || !["DELIVERED", "REFUNDED", "NEEDS_ATTENTION"].includes(p.status))
      return text(`${head} Still processing (${p?.status ?? "QUOTED"}). Call lucky_code with id ${q.id} in a minute.`);
    if (p.status !== "DELIVERED") return text(`${head} Ended ${p.status}${p.refundReason ? ` (${p.refundReason}): the full amount was refunded to the agent wallet` : ""}.`);
    const memo = await codeFromMemo(p);
    return text(
      [
        head,
        `Final Price ${pct(p.finalBps!)} of R; Refund ${formatZec(p.refundZat ?? 0)} ${unit} back to the agent wallet.`,
        memo ? `Delivery memo (encrypted on chain, decrypted by the agent wallet):\n${memo}` : `Delivered in ${p.sendTxid}; the memo hasn't synced yet. Call lucky_code with id ${q.id} shortly.`,
        `Verify the Draw with lucky_verify id ${q.id}.`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "lucky_code",
  { description: "Read the Voucher code for a delivered lucky_buy purchase from the agent wallet's encrypted memo.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const p = await api<PurchaseView & { error?: string }>(`/api/purchase/${id}`);
    if (p.error) return text(`Not found: ${id}`);
    if (p.status !== "DELIVERED") return text(`${id} is ${p.status}; the code arrives once it's DELIVERED.`);
    const memo = await codeFromMemo(p);
    return text(memo ?? `Delivered in ${p.sendTxid}, but that memo isn't in the agent wallet (paid by another wallet, or not synced yet).`);
  },
);

await server.connect(new StdioServerTransport());
