// Pays a Lucky Buy ticket from the buyer wallet (the demo's "customer"), then follows the purchase and prints
// the delivery memo the customer's wallet decrypts. Paste the link from the ticket ("Copy payment link"):
//   npm run pay -- "zcash:utest1…?amount=0.011&message=Lucky%20Buy%20<id>"
// Codes are masked unless you add --show (Bitrefill: "codes are cash, mask them on screen").
import { ZingoWallet } from "../src/wallet.ts";
import type { PurchaseView, ZcashNetwork } from "../src/types.ts";

const env = process.env;
const args = process.argv.slice(2);
const show = args.includes("--show");
const uri = args.find((a) => a.startsWith("zcash:"));
if (!uri) throw new Error('usage: npm run pay -- "zcash:<address>?amount=<ZEC>&message=Lucky%20Buy%20<id>" [--show]');

const url = new URL(uri.replace(/^zcash:/, "zcash://pay/"));
const address = uri.slice("zcash:".length).split("?")[0]!;
const amount = url.searchParams.get("amount") ?? "";
const id = /Lucky Buy ([0-9a-f-]{36})/.exec(url.searchParams.get("message") ?? "")?.[1];
if (!/^\d+(\.\d{1,8})?$/.test(amount) || !id) throw new Error("that doesn't look like a Lucky Buy payment link");
const [whole, frac = ""] = amount.split(".");
const zat = Number(whole) * 100_000_000 + Number(frac.padEnd(8, "0")); // exact: no floating point

const API = (env.LUCKY_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const unit = (env.ZCASH_NETWORK ?? "testnet") === "mainnet" ? "ZEC" : "TAZ";
const buyer = new ZingoWallet({
  bin: env.AGENT_ZINGO_BIN || env.ZINGO_BIN || "zingo-cli", // the Nym build when configured
  network: (env.ZCASH_NETWORK ?? "testnet") as ZcashNetwork,
  server: env.LIGHTWALLETD_URL ?? "https://testnet.zec.rocks:443",
  syncBeforeSend: true,
  dirs: { till: env.BUYER_DIR!, reserve: env.BUYER_DIR! },
});
const time = () => new Date().toTimeString().slice(0, 8);
const mask = (memo: string) => (show ? memo : memo.replace(/^(Code|PIN): (\S{0,4})\S*/gm, (_, k, head) => `${k}: ${head}••••••••`));

console.log(`${time()} paying ${amount} ${unit} for ticket ${id} from the buyer's shielded wallet…`);
const { txid, overMixnet } = await buyer.send("till", address, zat, `Lucky Buy ${id}`);
console.log(`${time()} sent ${txid}${overMixnet ? " (broadcast over the Nym mixnet)" : ""}`);

let last = "";
for (;;) {
  const p = (await (await fetch(`${API}/api/purchase/${id}`)).json()) as PurchaseView;
  if (p.status !== last) {
    const extra = p.finalBps !== undefined ? ` (wheel stopped on ${p.finalBps / 100}%)` : "";
    console.log(`${time()} ${p.status}${extra}`);
    last = p.status;
  }
  const back = p.sendTxid ?? p.refundTxid;
  if (back) {
    console.log(`${time()} waiting for the memo to reach the buyer's wallet…`);
    for (;;) {
      const note = (await buyer.received()).find((n) => n.txid === back);
      if (note) {
        console.log(`${time()} the buyer's wallet decrypted (${note.valueZat / 1e8} ${unit}):\n\n${mask(note.memo ?? "")}\n`);
        process.exit(0);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (p.status === "EXPIRED" || p.status === "NEEDS_ATTENTION") process.exit(1);
  await new Promise((r) => setTimeout(r, 4_000));
}
