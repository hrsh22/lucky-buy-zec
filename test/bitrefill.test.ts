import { describe, expect, it } from "vitest";
import { MockBitrefill, parseInvoice } from "../src/bitrefill.ts";

describe("MockBitrefill", () => {
  it("completes after N polls with a redemption", async () => {
    const b = new MockBitrefill({ pollsToComplete: 3 });
    const [p] = await b.products();
    const { invoiceId } = await b.buy(p.id, "purchase-1");
    expect(await b.invoice(invoiceId)).toEqual({ status: "pending" });
    expect(await b.invoice(invoiceId)).toEqual({ status: "pending" });
    const done = await b.invoice(invoiceId);
    expect(done.status === "complete" && done.redemption.code).toBeTruthy();
  });

  it("searches by name, case-insensitively", async () => {
    const b = new MockBitrefill();
    expect((await b.search("GIFT CARD 5")).map((p) => p.faceValue.amount)).toEqual([5]);
    expect(await b.search("nothing like this")).toEqual([]);
  });

  it("failNext fails only the next invoice", async () => {
    const b = new MockBitrefill({ pollsToComplete: 1 });
    const [p] = await b.products();
    b.failNext();
    const bad = await b.buy(p.id, "a");
    const good = await b.buy(p.id, "b");
    expect((await b.invoice(bad.invoiceId)).status).toBe("failed");
    expect((await b.invoice(good.invoiceId)).status).toBe("complete");
  });

  it("buy is idempotent per purchaseId", async () => {
    const b = new MockBitrefill();
    const [p] = await b.products();
    const first = await b.buy(p.id, "same");
    expect(await b.buy(p.id, "same")).toEqual(first);
    expect(await b.buy(p.id, "other")).not.toEqual(first);
  });
});

describe("parseInvoice (shapes captured from the live API)", () => {
  const order = (status: string, redemption_info?: object) => ({ status: "all_delivered", orders: [{ status, redemption_info }] });

  it("code and link products", () => {
    expect(parseInvoice(order("delivered", { code: "C1", instructions: "x" }))).toEqual({
      status: "complete",
      redemption: { code: "C1" },
    });
    expect(parseInvoice(order("delivered", { link: "https://l", extra_fields: { code: "C2" } }))).toEqual({
      status: "complete",
      redemption: { code: "C2", link: "https://l" },
    });
  });

  it("pending and failed", () => {
    expect(parseInvoice({ status: "not_delivered", orders: [{ status: "created" }] }).status).toBe("pending");
    expect(parseInvoice({ status: "all_error", orders: [{ status: "permanent_failure" }] }).status).toBe("failed");
  });
});

import { lastJson } from "../src/wallet.ts";
describe("lastJson (zingo-cli output)", () => {
  it("parses one-line and pretty JSON after log lines", () => {
    expect(lastJson('Launching save task...\n{"status":"success","x":1}\nSave task shutdown successfully.\n')).toEqual({ status: "success", x: 1 });
    expect(lastJson('noise\n{\n  "a": {\n    "b": 2\n  }\n}\nZingo CLI quit successfully.\n')).toEqual({ a: { b: 2 } });
    expect(() => lastJson("Error: nope\n")).toThrow();
  });
});

import { KeyPool, keyFingerprint } from "../src/bitrefill.ts";
describe("KeyPool (several Bitrefill accounts, never at their daily cap)", () => {
  it("uses keys in order, skipping any at the safety limit, and counts each buy at once", async () => {
    const counts: Record<string, number> = { a: 12, b: 10, c: 0 };
    const pool = new KeyPool(["a", "b", " c ", "a"], 12, async (k) => counts[k]!);
    expect(pool.keys.map((k) => k.key)).toEqual(["a", "b", "c"]); // trimmed, de-duplicated
    let k = await pool.pick();
    expect(k.key).toBe("b");
    pool.record(k.fp);
    k = await pool.pick();
    expect(k.key).toBe("b"); // 11 < 12
    pool.record(k.fp);
    expect((await pool.pick()).key).toBe("c"); // b reached 12: move on
  });

  it("refuses with a definite 4xx when every key is at the limit, or can't be counted", async () => {
    const pool = new KeyPool(["a", "b"], 12, async (k) => (k === "a" ? 15 : Promise.reject(new Error("down"))));
    await expect(pool.pick()).rejects.toThrow(/HTTP 429/);
  });

  it("names keys by fingerprint, never by value", async () => {
    const pool = new KeyPool(["secret-key-1"], 12, async () => 3);
    const [u] = await pool.usage();
    expect(u).toEqual({ fp: keyFingerprint("secret-key-1"), last24h: 3, limit: 12 });
    expect(JSON.stringify(u)).not.toContain("secret");
  });
});
