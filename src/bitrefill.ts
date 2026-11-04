// Bitrefill adapter: real API v2 client + in-memory mock. See types.ts `Bitrefill`.
import { randomUUID } from "node:crypto";
import type { Bitrefill, InvoiceState, Product, Redemption } from "./types.ts";

/** Product ids are Bitrefill package ids: `<product_id><&><package value>`. */
export const CATALOG = {
  // Free, return dummy codes. Fail variants exist for the refund path:
  // `test-gift-card-code-fail<&>10` / `test-gift-card-link-fail<&>…` (invoice ends `all_error`).
  test: ["test-gift-card-code<&>10", "test-gift-card-link<&>Dinner for One", "test-gift-card-code<&>30", "test-gift-card-code-fail<&>10"],
  main: ["swiggy-money-india<&>500", "phonepe-india<&>500", "blink-it-india<&>500"],
};

/**
 * Fixed conversion for non-USD face values (units of currency per USD). INR 95 derived on 2026-11-04 from
 * the account's own pricing: ₹500 Swiggy cost 7023 sats while $10 cost 13452 sats → ₹95.8/USD.
 */
const UNITS_PER_USD: Record<string, number> = { USD: 1, INR: 95 };

const usdCents = (amount: number, currency: string): number => {
  const rate = UNITS_PER_USD[currency];
  if (!rate) throw new Error(`no fixed USD rate for ${currency}`);
  return Math.round((amount * 100) / rate);
};

// ---------------------------------------------------------------- real client

/** Gift cards only: top-ups need a phone number and we deliberately never ask for one. */
const buyable = (p: any) => p?.in_stock !== false && (p?.recipient_type ?? "none") === "none";

function toProduct(p: any, pkg: any): Product {
  // `amount` is the numeric face value; `value` can be a label ("Dinner for One").
  const amount = Number(pkg.amount ?? pkg.value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`no numeric face value: ${pkg.id}`);
  return {
    id: pkg.id,
    name: `${p.name} ${pkg.value}`,
    isTest: String(p.id).startsWith("test-"),
    faceValue: { amount, currency: p.currency },
    referenceUsdCents: usdCents(amount, p.currency),
  };
}

type Json = any;

export class BitrefillClient implements Bitrefill {
  private apiKey: string;
  private baseUrl: string;
  private ids: string[];
  private test: boolean;
  // ponytail: the API has no idempotency key or invoice tag (unknown body fields are ignored), so dedupe is
  // in-process only. Across restarts the worker's stored bitrefillInvoiceId is the guard.
  private bought = new Map<string, string>();

  constructor(apiKey: string, opts: { test?: boolean; baseUrl?: string } = {}) {
    this.apiKey = apiKey;
    this.test = opts.test ?? false;
    this.ids = this.test ? CATALOG.test : CATALOG.main;
    this.baseUrl = opts.baseUrl ?? "https://api.bitrefill.com/v2";
  }

  private async req(path: string, body?: unknown): Promise<Json> {
    const res = await fetch(this.baseUrl + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json: Json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`bitrefill ${path}: HTTP ${res.status} ${json.error_code ?? ""} ${json.message ?? ""}`.trim());
    return json.data;
  }

  private qs(): string {
    return this.test ? "?include_test_products=true" : "";
  }

  private cache = new Map<string, { at: number; v: Promise<unknown> }>();
  private lastGood = new Map<string, unknown>();
  /**
   * 60 s memo for read-only calls, so page loads don't hit Bitrefill every time. If a refresh fails (Bitrefill
   * returns the odd 502), the last good answer is served instead, so one hiccup doesn't blank the catalog.
   */
  private memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.v as Promise<T>;
    const v = fn().then(
      (x) => (this.lastGood.set(key, x), x),
      (e) => {
        this.cache.delete(key);
        if (this.lastGood.has(key)) return this.lastGood.get(key) as T;
        throw e;
      },
    );
    this.cache.set(key, { at: Date.now(), v });
    return v;
  }

  /** Any Bitrefill package, not just the storefront catalog: the agent can buy what lucky_search finds. */
  product(id: string): Promise<Product> {
    return this.memo(`p:${id}`, () => this.fetchProduct(id));
  }

  private async fetchProduct(id: string): Promise<Product> {
    const [productId] = id.split("<&>");
    const p = await this.req(`/products/${encodeURIComponent(productId)}${this.qs()}`);
    const pkg = (p.packages ?? []).find((x: Json) => x.id === id);
    if (!pkg) throw new Error(`package gone: ${id}`);
    if (!buyable(p)) throw new Error(`not buyable here (needs a ${p.recipient_type ?? "recipient"} or out of stock): ${id}`);
    return toProduct(p, pkg);
  }

  /** In-stock gift cards (no phone number needed) matching `query`, one entry per package, cheapest first. */
  search(query: string, country = "IN"): Promise<Product[]> {
    const qs = new URLSearchParams({ q: query, country, limit: "20" });
    if (this.test) qs.set("include_test_products", "true");
    return this.memo(`s:${qs}`, async () => {
      const found: Json[] = await this.req(`/products/search?${qs}`);
      return found
        .filter(buyable)
        .flatMap((p) => (p.packages ?? []).flatMap((pkg: Json) => {
          try {
            return [toProduct(p, pkg)];
          } catch {
            return []; // a currency we can't price, or a non-numeric package
          }
        }))
        .sort((a, b) => a.referenceUsdCents - b.referenceUsdCents)
        .slice(0, 12);
    });
  }

  products(): Promise<Product[]> {
    return Promise.all(this.ids.map((id) => this.product(id)));
  }

  async buy(productId: string, purchaseId: string): Promise<{ invoiceId: string }> {
    const known = this.bought.get(purchaseId);
    if (known) return { invoiceId: known };
    await this.product(productId); // validates it exists, is in stock and needs no phone number
    const inv = await this.req("/invoices", {
      products: [{ product_id: productId.split("<&>")[0], package_id: productId, quantity: 1 }],
      payment_method: "balance",
      auto_pay: true,
    });
    this.bought.set(purchaseId, inv.id);
    return { invoiceId: inv.id };
  }

  async invoice(invoiceId: string): Promise<InvoiceState> {
    return parseInvoice(await this.req(`/invoices/${encodeURIComponent(invoiceId)}`));
  }

  /** Balance is in the account currency (BTC accounts: sats, same unit as invoice prices). Converted via the
   * account's own USD price_rate from a USD test product, so no external price feed is needed. */
  balanceUsdCents(): Promise<number> {
    return this.memo("balance", () => this.fetchBalanceUsdCents());
  }

  private async fetchBalanceUsdCents(): Promise<number> {
    const [{ balance }, p] = await Promise.all([
      this.req("/accounts/balance"),
      this.req("/products/test-gift-card-code?include_test_products=true"),
    ]);
    return Math.floor((Number(balance) / p.range.price_rate) * 100);
  }
}

const FAILED_INVOICE = new Set(["all_error", "denied", "payment_error", "blocked", "expired", "partial_error"]);
const FAILED_ORDER = new Set(["permanent_failure", "failed", "refunded"]);

/** Invoice JSON (GET /invoices/:id `data`) → InvoiceState. One product per invoice, so orders[0] decides. */
export function parseInvoice(inv: Json): InvoiceState {
  const order = inv.orders?.[0];
  if (order?.status === "delivered" && order.redemption_info) {
    return { status: "complete", redemption: parseRedemption(order.redemption_info) };
  }
  if (FAILED_ORDER.has(order?.status) || FAILED_INVOICE.has(inv.status)) {
    return { status: "failed", error: `invoice ${inv.status}, order ${order?.status ?? "missing"}` };
  }
  return { status: "pending" };
}

/** Code products put it in `code`; link products put the URL in `link` and the code in `extra_fields.code`. */
export function parseRedemption(r: Json): Redemption {
  const code = r.code ?? r.extra_fields?.code ?? r.link;
  if (!code) throw new Error("redemption_info has no code or link");
  const out: Redemption = { code: String(code) };
  if (r.pin ?? r.extra_fields?.pin) out.pin = String(r.pin ?? r.extra_fields.pin);
  if (r.link) out.link = String(r.link);
  return out;
}

// ---------------------------------------------------------------- mock

const MOCK_PRODUCTS: Product[] = [1, 5, 10].map((usd) => ({
  id: `mock-gift-card<&>${usd}`,
  name: `Mock Gift Card ${usd}`,
  isTest: true,
  faceValue: { amount: usd, currency: "USD" },
  referenceUsdCents: usd * 100,
}));

export class MockBitrefill implements Bitrefill {
  private invoices = new Map<string, { polls: number; fail: boolean }>();
  private byPurchase = new Map<string, string>();
  private failNextBuy = false;
  private pollsToComplete: number;

  constructor(opts: { pollsToComplete?: number } = {}) {
    this.pollsToComplete = opts.pollsToComplete ?? 2;
  }

  /** The next newly bought invoice ends `failed`. */
  failNext(): void {
    this.failNextBuy = true;
  }

  async products(): Promise<Product[]> {
    return MOCK_PRODUCTS;
  }

  async search(query: string): Promise<Product[]> {
    return MOCK_PRODUCTS.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  }

  async product(id: string): Promise<Product> {
    const p = MOCK_PRODUCTS.find((x) => x.id === id);
    if (!p) throw new Error(`not in catalog: ${id}`);
    return p;
  }

  async buy(productId: string, purchaseId: string): Promise<{ invoiceId: string }> {
    const known = this.byPurchase.get(purchaseId);
    if (known) return { invoiceId: known };
    await this.product(productId);
    const invoiceId = randomUUID();
    this.invoices.set(invoiceId, { polls: 0, fail: this.failNextBuy });
    this.failNextBuy = false;
    this.byPurchase.set(purchaseId, invoiceId);
    return { invoiceId };
  }

  async invoice(invoiceId: string): Promise<InvoiceState> {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error(`unknown invoice ${invoiceId}`);
    if (++inv.polls < this.pollsToComplete) return { status: "pending" };
    if (inv.fail) return { status: "failed", error: "mock failure" };
    return { status: "complete", redemption: { code: `MOCK-${invoiceId.slice(0, 8).toUpperCase()}`, pin: "1234" } };
  }

  async balanceUsdCents(): Promise<number> {
    return 100_000;
  }
}

export function makeBitrefill(env: NodeJS.ProcessEnv = process.env): Bitrefill {
  if (env.MOCK_BITREFILL === "1") return new MockBitrefill();
  if (!env.BITREFILL_API_KEY) throw new Error("BITREFILL_API_KEY missing (or set MOCK_BITREFILL=1)");
  return new BitrefillClient(env.BITREFILL_API_KEY, {
    test: env.BITREFILL_TEST_PRODUCTS === "1",
    baseUrl: env.BITREFILL_BASE_URL,
  });
}
