// Prints a fresh shielded address of the demo buyer's wallet, to paste into the storefront's address field.
//   npm run buyer-address
import { execFileSync } from "node:child_process";
import { lastJson } from "../src/wallet.ts";

const env = process.env;
const out = execFileSync(env.ZINGO_BIN ?? "zingo-cli", [
  "--chain", env.ZCASH_NETWORK ?? "testnet", "--data-dir", env.BUYER_DIR!, "--offline", "new_address", "o",
], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
console.log(lastJson(out).encoded_address);
