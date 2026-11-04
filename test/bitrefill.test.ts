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
