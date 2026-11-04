// Buys the cheapest catalog item through the real BitrefillClient, polls to completion, prints the redemption.
// Defaults to the free test products; never run with BITREFILL_TEST_PRODUCTS=0 unless you mean to spend balance.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BitrefillClient } from "../src/bitrefill.ts";

for (const f of [".env", "../.env"]) if (existsSync(f)) process.loadEnvFile(f);
const key = process.env.BITREFILL_API_KEY;
if (!key) throw new Error("BITREFILL_API_KEY missing");
const test = process.env.BITREFILL_TEST_PRODUCTS !== "0";

const client = new BitrefillClient(key, { test, baseUrl: process.env.BITREFILL_BASE_URL });
console.log("balance (USD cents):", await client.balanceUsdCents());
const products = await client.products();
console.table(products.map(({ faceValue, ...p }) => ({ ...p, face: `${faceValue.amount} ${faceValue.currency}` })));

const cheapest = products.reduce((a, b) => (b.referenceUsdCents < a.referenceUsdCents ? b : a));
if (!cheapest.isTest) throw new Error(`refusing to buy real product ${cheapest.id} from the smoke test`);

const purchaseId = randomUUID();
const { invoiceId } = await client.buy(cheapest.id, purchaseId);
const again = await client.buy(cheapest.id, purchaseId);
if (again.invoiceId !== invoiceId) throw new Error("buy is not idempotent per purchaseId");
console.log("invoice:", invoiceId);

for (let i = 0; i < 30; i++) {
  const state = await client.invoice(invoiceId);
  console.log(`poll ${i}:`, state.status);
  if (state.status === "complete") {
    console.log("redemption:", state.redemption);
    process.exit(0);
  }
  if (state.status === "failed") throw new Error(state.error);
  await new Promise((r) => setTimeout(r, 2_000));
}
throw new Error("invoice still pending after 60 s");
