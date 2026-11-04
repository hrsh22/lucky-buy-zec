import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { deliveryZat } from "../src/game.ts";
import { makeApp } from "../src/server.ts";
import { MockWallet } from "../src/wallet.ts";
import { makeWorker } from "../src/worker.ts";
import type { Bitrefill, InvoiceState, SignedQuote, VerifyView } from "../src/types.ts";

const BUYER = "utest1buyer000000000000000000000000000000";

class FakeBitrefill implements Bitrefill {
  invoices = new Map<string, { polls: number; fail: boolean }>();
  failNext = false;
  throwNext: string | false = false;
  async products() {
    return [await this.product("test-5")];
  }
  async product(id: string) {
    return { id, name: "Test Card", isTest: !id.startsWith("real-"), faceValue: { amount: 5, currency: "USD" }, referenceUsdCents: 500 };
  }
  async buy(_productId: string, purchaseId: string) {
    if (this.throwNext) {
      const msg = this.throwNext;
      this.throwNext = false;
      throw new Error(msg);
    }
    const invoiceId = `inv-${purchaseId}`;
    if (!this.invoices.has(invoiceId)) this.invoices.set(invoiceId, { polls: 0, fail: this.failNext });
    this.failNext = false;
    return { invoiceId };
  }
  async invoice(id: string): Promise<InvoiceState> {
    const inv = this.invoices.get(id)!;
    if (++inv.polls < 2) return { status: "pending" };
    return inv.fail ? { status: "failed", error: "out of stock" } : { status: "complete", redemption: { code: "CODE-123", pin: "42" } };
  }
  async balanceUsdCents() {
    return 10_000;
  }
}

function setup(opts: { quotesPerIpPer10Min?: number; realBudgetUsdCentsPerDay?: number } = {}) {
  const db = openDb();
  const wallet = new MockWallet({ reserveZat: 100_000_000 }); // 1 TAZ = $1,000 at the test rate
  const bitrefill = new FakeBitrefill();
  let now = new Date();
  const worker = makeWorker({ db, wallet, bitrefill, now: () => now, log: () => {} });
  const app = makeApp({
    db, wallet, bitrefill, network: "testnet", seedHex: "11".repeat(32), rates: { usdCentsPerZec: async () => 100_000 }, ...opts,
  });
  const quote = async (tier = "classic", returnAddress = BUYER, productId = "test-5") => {
    const res = await app.request("/api/quote", { method: "POST", body: JSON.stringify({ productId, tier, returnAddress }) });
    return { status: res.status, body: (await res.json()) as SignedQuote & { error?: string } };
  };
  const ticks = async (n = 4) => {
    for (let i = 0; i < n; i++) await worker.tick();
  };
  return { db, wallet, bitrefill, worker, app, quote, ticks, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("worker", () => {
  for (const tier of ["standard", "safe", "classic", "moonshot"]) {
    it(`delivers a ${tier} purchase and verifies`, async () => {
      const s = setup();
      const { body } = await s.quote(tier);
      expect(body.zip321).toMatch(/^zcash:utest1/);
      s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
      await s.ticks();
      const p = s.db.get(body.quote.id)!;
      expect(p.status).toBe("DELIVERED");
      expect(p.redemption).toBeUndefined();
      const [sent] = s.wallet.sent;
      expect(s.wallet.sent).toHaveLength(1);
      expect(sent!.to).toBe(BUYER);
      expect(sent!.valueZat).toBe(deliveryZat(p.refundZat!));
      expect(sent!.memo).toContain("Code: CODE-123");
      const v = (await (await s.app.request(`/api/verify/${p.id}`)).json()) as VerifyView;
      expect(Object.values(v.checks).every(Boolean)).toBe(true);
    });
  }

  it.each([
    ["underpaid", -1],
    ["overpaid", 1],
  ])("refunds %s payments in full", async (reason, delta) => {
    const s = setup();
    const { body } = await s.quote();
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat + delta);
    await s.ticks();
    const p = s.db.get(body.quote.id)!;
    expect([p.status, p.refundReason]).toEqual(["REFUNDED", reason]);
    expect(s.wallet.sent.map((x) => x.valueZat)).toEqual([body.quote.maxPriceZat + delta]);
  });

  it("refunds a late payment after expiry", async () => {
    const s = setup();
    const { body } = await s.quote();
    s.advance(26 * 60_000);
    await s.ticks(1);
    expect(s.db.get(body.quote.id)!.status).toBe("EXPIRED");
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
    await s.ticks();
    expect(s.db.get(body.quote.id)!).toMatchObject({ status: "REFUNDED", refundReason: "late" });
  });

  it("ignores unconfirmed notes until confirmed", async () => {
    const s = setup();
    const { body } = await s.quote();
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat, 0);
    await s.ticks();
    expect(s.db.get(body.quote.id)!.status).toBe("QUOTED");
  });

  it("refunds a second note to the same address once, separately", async () => {
    const s = setup();
    const { body } = await s.quote();
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
    await s.ticks();
    s.wallet.simulatePayment(body.quote.payAddress, 50_000);
    await s.ticks();
    expect(s.db.get(body.quote.id)!.status).toBe("DELIVERED");
    expect(s.wallet.sent.filter((x) => x.memo.includes("duplicate")).map((x) => x.valueZat)).toEqual([50_000]);
  });

  it("refunds when the Bitrefill invoice fails or the buy is rejected", async () => {
    for (const mode of ["failNext", "throwNext"] as const) {
      const s = setup();
      if (mode === "failNext") s.bitrefill.failNext = true;
      else s.bitrefill.throwNext = "bitrefill /invoices: HTTP 400 balance_too_low";
      const { body } = await s.quote();
      s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
      await s.ticks(5);
      expect(s.db.get(body.quote.id)!).toMatchObject({ status: "REFUNDED", refundReason: "fulfillment_failed" });
      expect(s.wallet.sent.map((x) => x.valueZat)).toEqual([body.quote.maxPriceZat]);
    }
  });

  it("parks a buy whose outcome is unknown (timeout/5xx) instead of refunding", async () => {
    const s = setup();
    s.bitrefill.throwNext = "The operation was aborted due to timeout";
    const { body } = await s.quote();
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
    await s.ticks();
    expect(s.db.get(body.quote.id)!.status).toBe("NEEDS_ATTENTION");
    expect(s.wallet.sent).toHaveLength(0);
  });

  it("keeps dust instead of refunding it, and the quote stays payable", async () => {
    const s = setup();
    const { body } = await s.quote();
    s.wallet.simulatePayment(body.quote.payAddress, 1);
    await s.ticks();
    expect(s.db.get(body.quote.id)!.status).toBe("QUOTED");
    expect(s.wallet.sent).toHaveLength(0);
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
    await s.ticks();
    expect(s.db.get(body.quote.id)!.status).toBe("DELIVERED");
  });

  it("handles two outputs of one tx to the same address separately", async () => {
    const s = setup();
    const { body } = await s.quote();
    const txid = s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
    s.wallet.notes.push({ ...s.wallet.notes.at(-1)!, outputIndex: 1, valueZat: 60_000 });
    await s.ticks();
    expect(s.db.get(body.quote.id)!).toMatchObject({ status: "DELIVERED", paymentTxid: txid });
    expect(s.wallet.sent.filter((x) => x.memo.includes("duplicate")).map((x) => x.valueZat)).toEqual([60_000]);
  });

  it("parks a send that crashed mid-flight instead of resending", async () => {
    const s = setup();
    const { body } = await s.quote();
    const id = body.quote.id;
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
    await s.ticks(1); // → FULFILL_PENDING with an invoice
    s.db.transition(id, "FULFILL_PENDING", "FULFILLED", { redemption: { code: "C" } });
    s.db.transition(id, "FULFILLED", "DELIVER_PENDING"); // the process died right after this write
    makeWorker({ db: s.db, wallet: s.wallet, bitrefill: s.bitrefill, log: () => {} }).recover();
    await s.ticks();
    expect(s.db.get(id)!.status).toBe("NEEDS_ATTENTION");
    expect(s.wallet.sent).toHaveLength(0);
  });

  it("resumes polling a stored invoice after restart without a second buy", async () => {
    const s = setup();
    const { body } = await s.quote();
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
    await s.ticks(1); // PAID → DRAWN → FULFILL_PENDING with invoice, first poll pending
    expect(s.db.get(body.quote.id)!).toMatchObject({ status: "FULFILL_PENDING", bitrefillInvoiceId: `inv-${body.quote.id}` });
    const w2 = makeWorker({ db: s.db, wallet: s.wallet, bitrefill: s.bitrefill, log: () => {} });
    w2.recover();
    for (let i = 0; i < 3; i++) await w2.tick();
    expect(s.db.get(body.quote.id)!.status).toBe("DELIVERED");
    expect(s.bitrefill.invoices.size).toBe(1);
  });

  it("never sends twice from concurrent ticks", async () => {
    const s = setup();
    const { body } = await s.quote();
    s.wallet.simulatePayment(body.quote.payAddress, body.quote.maxPriceZat);
    await Promise.all(Array.from({ length: 8 }, () => s.ticks()));
    expect(s.wallet.sent).toHaveLength(1);
  });
});

describe("server", () => {
  it("rejects a mainnet return address on testnet", async () => {
    const s = setup();
    expect((await s.quote("classic", "u1mainnetaddress")).status).toBe(400);
    expect((await s.quote("classic", "tmTransparent")).status).toBe(400);
  });

  it("refuses a tier over capacity and lists the available ones", async () => {
    const s = setup();
    s.wallet.balances.reserve = 1_000; // ~$0.01 of reserve
    const r = await s.quote("moonshot");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "tier_unavailable", availableTiers: ["standard"] });
  });

  it("never overbooks capacity with simultaneous quotes", async () => {
    const s = setup();
    s.wallet.balances.reserve = 2_000_000; // $20 reserve: only a few moonshot quotes fit
    const rs = await Promise.all(Array.from({ length: 20 }, () => s.quote("moonshot")));
    const ok = rs.filter((r) => r.status === 200).length;
    const s2 = setup();
    s2.wallet.balances.reserve = 2_000_000;
    let sequential = 0;
    for (let i = 0; i < 20; i++) if ((await s2.quote("moonshot")).status === 200) sequential++;
    expect(ok).toBe(sequential);
  });

  it("caps real (non-test) Vouchers per day; refunded and test purchases don't count", async () => {
    const s = setup({ realBudgetUsdCentsPerDay: 1_000 }); // two $5 real cards
    const a = await s.quote("standard", BUYER, "real-5");
    expect(a.status).toBe(200);
    expect((await s.quote("standard", BUYER, "real-5")).status).toBe(200);
    const third = await s.quote("standard", BUYER, "real-5");
    expect([third.status, third.body.error]).toEqual([409, "daily_budget_reached"]);
    expect((await s.quote("standard", BUYER, "test-5")).status).toBe(200); // test cards cost the house nothing
    // an underpaid (refunded) real purchase frees its share of the budget
    s.wallet.simulatePayment(a.body.quote.payAddress, a.body.quote.maxPriceZat - 1);
    await s.ticks();
    expect(s.db.get(a.body.quote.id)!.status).toBe("REFUNDED");
    expect((await s.quote("standard", BUYER, "real-5")).status).toBe(200);
  });

  it("rate-limits quotes per client IP", async () => {
    const s = setup({ quotesPerIpPer10Min: 2 });
    const q = (ip: string) =>
      s.app.request("/api/quote", {
        method: "POST", headers: { "cf-connecting-ip": ip },
        body: JSON.stringify({ productId: "test-5", tier: "standard", returnAddress: BUYER }),
      });
    expect([(await q("1.1.1.1")).status, (await q("1.1.1.1")).status, (await q("1.1.1.1")).status]).toEqual([200, 200, 429]);
    expect((await q("2.2.2.2")).status).toBe(200);
  });

  it("hides the seed until drawn", async () => {
    const s = setup();
    const { body } = await s.quote();
    const v = (await (await s.app.request(`/api/purchase/${body.quote.id}`)).json()) as { serverSeed?: string };
    expect(v.serverSeed).toBeUndefined();
    expect((await s.app.request(`/api/verify/${body.quote.id}`)).status).toBe(409);
  });
});
