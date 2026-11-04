// Real-wallet smoke test (testnet): the buyer wallet pays a fresh till address with a memo,
// and the till must see that note on exactly that address. Run: node --env-file=.env scripts/wallet-smoke.ts
import { ZingoWallet } from "../src/wallet.ts";
import type { ZcashNetwork } from "../src/types.ts";

const env = process.env;
const base = { bin: env.ZINGO_BIN ?? "zingo-cli", network: (env.ZCASH_NETWORK ?? "testnet") as ZcashNetwork, server: env.LIGHTWALLETD_URL ?? "https://testnet.zec.rocks:443" };
const house = new ZingoWallet({ ...base, dirs: { till: env.TILL_DIR!, reserve: env.RESERVE_DIR! } });
const buyer = new ZingoWallet({ ...base, syncBeforeSend: true, dirs: { till: env.BUYER_DIR!, reserve: env.BUYER_DIR! } });

const addr = await house.newAddress();
console.log("till address", addr);
console.log("till balance", await house.balance("till"), "height", await house.height());
const memo = `Lucky Buy smoke ${new Date().toISOString()}`;
const { txid } = await buyer.send("till", addr, 12_345, memo);
console.log("buyer sent", txid);
for (let i = 0; i < 40; i++) {
  const note = (await house.received()).find((n) => n.txid === txid);
  console.log(`poll ${i}:`, note ? { address: note.address === addr, conf: note.confirmations, memo: note.memo, value: note.valueZat } : "not seen");
  if (note && note.confirmations >= 1) {
    if (note.address !== addr || note.valueZat !== 12_345) throw new Error("note does not match");
    console.log("OK: payment matched to its diversified address");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
throw new Error("timed out waiting for confirmation");
