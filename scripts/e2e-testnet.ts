// Real testnet end to end: quote → buyer wallet pays → Draw → Bitrefill test product → code memo
// back in the buyer wallet. Needs `npm start` running with MOCK_WALLET=0.
// Run: node --env-file=.env scripts/e2e-testnet.ts [tier] [productId] [deltaZat]
import { ZingoWallet } from "../src/wallet.ts";
import type { PurchaseView, SignedQuote, ZcashNetwork } from "../src/types.ts";

const env = process.env;
const API = env.LUCKY_API_URL ?? `http://localhost:${env.PORT ?? 8787}`;
const [tier = "classic", productId = "test-gift-card-code<&>10", delta = "0"] = process.argv.slice(2);
const buyer = new ZingoWallet({
  bin: env.ZINGO_BIN ?? "zingo-cli", network: (env.ZCASH_NETWORK ?? "testnet") as ZcashNetwork,
  server: env.LIGHTWALLETD_URL ?? "https://testnet.zec.rocks:443", syncBeforeSend: true, dirs: { till: env.BUYER_DIR!, reserve: env.BUYER_DIR! },
});

const returnAddress = await buyer.newAddress();
const res = await fetch(`${API}/api/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId, tier, returnAddress }) });
const sq = (await res.json()) as SignedQuote;
if (!res.ok) throw new Error(JSON.stringify(sq));
const { quote: q } = sq;
console.log(`quote ${q.id} ${q.tier}: pay ${q.maxPriceZat} zat → ${q.payAddress.slice(0, 20)}…`);
const { txid } = await buyer.send("till", q.payAddress, q.maxPriceZat + Number(delta), `Lucky Buy ${q.id}`);
console.log(`paid in ${txid}`);

let last = "";
for (let i = 0; i < 80; i++) {
  const p = (await (await fetch(`${API}/api/purchase/${q.id}`)).json()) as PurchaseView;
  if (p.status !== last) console.log(new Date().toISOString().slice(11, 19), p.status, p.finalBps ?? "", p.refundReason ?? "");
  last = p.status;
  if (["DELIVERED", "REFUNDED", "NEEDS_ATTENTION", "EXPIRED"].includes(p.status)) {
    const back = p.sendTxid ?? p.refundTxid;
    console.log(`verify: ${API}/verify.html?id=${q.id}`);
    for (let j = 0; back && j < 30; j++) {
      const n = (await buyer.received()).find((x) => x.txid === back);
      if (n) {
        console.log(`buyer got ${n.valueZat} zat, ${n.confirmations} conf, memo:\n${n.memo}`);
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    process.exit(p.status === "NEEDS_ATTENTION" ? 1 : 0);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
throw new Error("timed out");
