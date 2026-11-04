import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  KELLY_FRACTION, TIERS, admissionLimitUsdCents, availableTiers, commitment, draw, formatZec, maxPriceZat, type TierId,
} from "./game.ts";
import { openDb, type Db } from "./db.ts";
import { makeWorker } from "./worker.ts";
import type {
  Bitrefill, FeedEvent, Purchase, PurchaseView, Quote, Rates, ReserveView, SignedQuote, VerifyView, Wallet, ZcashNetwork,
} from "./types.ts";

// ---------------------------------------------------------------- signing (D11)

export const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function signingKey(seedHex: string) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { privateKey, publicKey, publicKeyHex };
}

export const signQuote = (q: Quote, key: KeyObject) => sign(null, Buffer.from(canonicalJson(q)), key).toString("hex");
export const verifyQuote = (q: Quote, sigHex: string, key: KeyObject) =>
  verify(null, Buffer.from(canonicalJson(q)), key, Buffer.from(sigHex, "hex"));

// ---------------------------------------------------------------- addresses (D12)

const ADDRESS_PREFIXES: Record<ZcashNetwork, string[]> = { mainnet: ["u1", "zs1"], testnet: ["utest1", "ztestsapling1"] };
export const isShieldedOn = (addr: string, network: ZcashNetwork) =>
  /^[a-z0-9]+$/.test(addr) && ADDRESS_PREFIXES[network].some((p) => addr.startsWith(p));

// ---------------------------------------------------------------- app

export interface AppDeps {
  db: Db;
  wallet: Wallet;
  bitrefill: Bitrefill;
  rates: Rates;
  network: ZcashNetwork;
  seedHex: string;
  quoteTtlMin?: number;
  quoteGraceMin?: number;
  kellyFraction?: number;
  /** Max quotes per client IP per 10 minutes; unset = unlimited (tests). Each open quote holds reserve capacity. */
  quotesPerIpPer10Min?: number;
  feed?: EventEmitter;
  devPay?: (p: Purchase) => Promise<void>; // only with MOCK_WALLET=1
  confirmations?: (payAddress: string) => number | undefined;
}

const QuoteRequest = z.object({
  productId: z.string().min(1),
  tier: z.enum(Object.keys(TIERS) as [TierId, ...TierId[]]),
  returnAddress: z.string().min(1).max(512),
});

// The roll is only written by the PAID → DRAWN transition, so its presence means the seed may be revealed.
const isDrawn = (p: Purchase) => p.roll !== undefined;

export const zip321 = (q: Quote) =>
  `zcash:${q.payAddress}?amount=${formatZec(q.maxPriceZat)}&message=${encodeURIComponent(`Lucky Buy ${q.id}`)}`;

export const toView = (p: Purchase, confirmations?: number): PurchaseView => ({
  id: p.id, status: p.status, quote: p.quote, zip321: zip321(p.quote), confirmations, paymentTxid: p.paymentTxid, roll: p.roll, finalBps: p.finalBps,
  refundZat: p.refundZat, serverSeed: isDrawn(p) ? p.serverSeed : undefined, sendTxid: p.sendTxid,
  refundReason: p.refundReason, refundTxid: p.refundTxid,
});

export function makeApp(d: AppDeps) {
  const { db, wallet, bitrefill, rates, network } = d;
  const key = signingKey(d.seedHex);
  const ttlMs = (d.quoteTtlMin ?? 15) * 60_000;
  const graceMs = (d.quoteGraceMin ?? 10) * 60_000;
  const openLoss = () => db.openWorstLossUsdCents(new Date(), graceMs);
  const c = d.kellyFraction ?? KELLY_FRACTION;
  const feed = d.feed ?? new EventEmitter();
  const app = new Hono();

  const reserveUsdCents = async (rate: number) =>
    Math.floor(((await wallet.balance("reserve")).spendableZat * rate) / 1e8);

  app.use("/api/*", bodyLimit({ maxSize: 4096, onError: (ctx) => ctx.json({ error: "body_too_large" }, 413) }));

  app.get("/api/products", async (ctx) => ctx.json(await bitrefill.products()));

  // ponytail: in-memory sliding window per IP; resets on restart, fine for one process.
  const quoteTimes = new Map<string, number[]>();
  const overQuoteLimit = (ip: string) => {
    if (!d.quotesPerIpPer10Min) return false;
    const now = Date.now();
    const recent = (quoteTimes.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
    quoteTimes.set(ip, recent);
    if (recent.length >= d.quotesPerIpPer10Min) return true;
    recent.push(now);
    return false;
  };

  app.post("/api/quote", async (ctx) => {
    const parsed = QuoteRequest.safeParse(await ctx.req.json().catch(() => null));
    if (!parsed.success) return ctx.json({ error: "invalid_request" }, 400);
    const { productId, tier, returnAddress } = parsed.data;
    const badAddress = { error: `return address must be a valid shielded ${network} address` };
    if (!isShieldedOn(returnAddress, network)) return ctx.json(badAddress, 400);
    if (wallet.isValidReturnAddress && !(await wallet.isValidReturnAddress(returnAddress))) return ctx.json(badAddress, 400);
    const ip = ctx.req.header("cf-connecting-ip") ?? ctx.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
    if (overQuoteLimit(ip)) return ctx.json({ error: "too_many_quotes, try again in a few minutes" }, 429);

    const product = await bitrefill.product(productId).catch(() => null);
    if (!product) return ctx.json({ error: "unknown_product" }, 404);
    const rate = await rates.usdCentsPerZec();
    const R = product.referenceUsdCents;
    const B = await reserveUsdCents(rate);
    const tierAvailable = () => availableTiers(R, B, openLoss(), c);
    if (!tierAvailable().includes(tier)) return ctx.json({ error: "tier_unavailable", availableTiers: tierAvailable() }, 409);
    const payAddress = await wallet.newAddress(); // the last await: capacity is re-checked and taken atomically below

    const seed = randomBytes(32);
    const t = TIERS[tier];
    const now = new Date();
    const quote: Quote = {
      v: "LUCKY_BUY_V1", network, id: randomUUID(), productId, productName: product.name, isTestProduct: product.isTest,
      faceValue: product.faceValue, referenceUsdCents: R, tier, maxBps: t.maxBps, table: [...t.outcomes],
      rateUsdCentsPerZec: rate, maxPriceZat: maxPriceZat(t, R, rate), payAddress,
      returnAddress, commit: commitment(seed), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    // No await from here to the insert, so concurrent quotes can't all pass the same capacity check.
    const available = tierAvailable();
    if (!available.includes(tier)) return ctx.json({ error: "tier_unavailable", availableTiers: available }, 409);
    const signature = signQuote(quote, key.privateKey);
    db.insertQuoted({
      id: quote.id, status: "QUOTED", quote, signature, serverSeed: seed.toString("hex"),
      createdAt: quote.createdAt, updatedAt: quote.createdAt,
    });
    return ctx.json({ quote, signature, publicKey: key.publicKeyHex, zip321: zip321(quote) } satisfies SignedQuote);
  });

  app.get("/api/purchase/:id", (ctx) => {
    const p = db.get(ctx.req.param("id"));
    return p ? ctx.json(toView(p, d.confirmations?.(p.quote.payAddress))) : ctx.json({ error: "not_found" }, 404);
  });

  app.get("/api/verify/:id", (ctx) => {
    const p = db.get(ctx.req.param("id"));
    if (!p) return ctx.json({ error: "not_found" }, 404);
    if (!isDrawn(p) || !p.paymentTxid) return ctx.json({ error: "not_drawn_yet", status: p.status }, 409);
    const seed = Buffer.from(p.serverSeed, "hex");
    const re = draw(TIERS[p.quote.tier], seed, p.id, p.paymentTxid);
    const view: VerifyView = {
      quote: p.quote, signature: p.signature, publicKey: key.publicKeyHex, serverSeed: p.serverSeed,
      paymentTxid: p.paymentTxid, roll: p.roll!, finalBps: p.finalBps!,
      checks: {
        commitMatches: commitment(seed) === p.quote.commit,
        signatureValid: verifyQuote(p.quote, p.signature, key.publicKey),
        rollMatches: re.roll === p.roll,
        outcomeMatches: re.finalBps === p.finalBps,
      },
    };
    return ctx.json(view);
  });

  app.get("/api/reserve", async (ctx) => {
    const rate = await rates.usdCentsPerZec();
    const B = await reserveUsdCents(rate);
    const open = openLoss();
    const limits = Object.fromEntries(
      (Object.keys(TIERS) as TierId[]).map((id) => {
        const l = admissionLimitUsdCents(TIERS[id], B, open, c);
        return [id, Number.isFinite(l) ? l : null];
      }),
    ) as ReserveView["admissionLimitUsdCents"];
    const view: ReserveView = {
      network, ufvk: await wallet.reserveViewingKey(), reserveZat: (await wallet.balance("reserve")).totalZat,
      tillZat: (await wallet.balance("till")).totalZat,
      bitrefillBalanceUsdCents: await bitrefill.balanceUsdCents().catch(() => -1),
      rateUsdCentsPerZec: rate, rateSource: network === "mainnet" ? "live" : "testnet_fixed",
      openWorstLossUsdCents: open, kellyFraction: c, admissionLimitUsdCents: limits, quotePublicKey: key.publicKeyHex,
    };
    return ctx.json(view);
  });

  app.get("/api/feed", (ctx) =>
    streamSSE(ctx, async (stream) => {
      const send = (e: FeedEvent) => void stream.writeSSE({ event: "purchase", data: JSON.stringify(e) });
      // replay the latest spins (oldest first) so a new visitor sees some history
      for (const p of db.recentDraws(8).reverse())
        send({ at: p.updatedAt, productName: p.quote.productName, tier: p.quote.tier, finalBps: p.finalBps!, maxBps: p.quote.maxBps });
      feed.on("purchase", send);
      stream.onAbort(() => void feed.off("purchase", send));
      while (!stream.aborted) await stream.sleep(25_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  if (d.devPay) {
    app.post("/api/dev/pay/:id", async (ctx) => {
      const p = db.get(ctx.req.param("id"));
      if (!p || p.status !== "QUOTED") return ctx.json({ error: "not_payable" }, 409);
      await d.devPay!(p);
      return ctx.json(toView(db.get(p.id)!));
    });
  }

  app.use("/*", serveStatic({ root: "./web" }));
  return app;
}

// ---------------------------------------------------------------- main

function loadSeed(env: NodeJS.ProcessEnv, dbPath: string): string {
  if (env.QUOTE_SIGNING_KEY) return env.QUOTE_SIGNING_KEY;
  const file = `${dbPath}-signing-key`; // gitignored via *.sqlite-*
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const seed = randomBytes(32).toString("hex");
  writeFileSync(file, seed, { mode: 0o600 });
  console.log(`Generated QUOTE_SIGNING_KEY, saved to ${file}`);
  return seed;
}

if (import.meta.main) {
  const { MockWallet, makeWallet } = await import("./wallet.ts");
  const { makeBitrefill } = await import("./bitrefill.ts");
  const { makeRates } = await import("./rates.ts");
  const env = process.env;
  const network = (env.ZCASH_NETWORK ?? "testnet") as ZcashNetwork;
  const dbPath = env.DB_PATH ?? "./db.sqlite";
  const db = openDb(dbPath);
  const wallet = makeWallet(env);
  const bitrefill = makeBitrefill(env);
  const feed = new EventEmitter();
  const worker = makeWorker({
    db, wallet, bitrefill, graceMin: Number(env.QUOTE_GRACE_MIN ?? 10),
    minConfirmations: Number(env.MIN_CONFIRMATIONS ?? (network === "mainnet" ? 3 : 1)),
    onDrawn: (p) => feed.emit("purchase", {
      at: p.updatedAt, productName: p.quote.productName, tier: p.quote.tier, finalBps: p.finalBps!, maxBps: p.quote.maxBps,
    } satisfies FeedEvent),
  });
  const app = makeApp({
    db, wallet, bitrefill, rates: makeRates(env), network, seedHex: loadSeed(env, dbPath), feed,
    confirmations: (addr) => worker.paymentConfirmations.get(addr),
    quoteTtlMin: Number(env.QUOTE_TTL_MIN ?? 15), quoteGraceMin: Number(env.QUOTE_GRACE_MIN ?? 10),
    quotesPerIpPer10Min: Number(env.QUOTES_PER_IP_PER_10MIN ?? 10), kellyFraction: Number(env.KELLY_FRACTION ?? KELLY_FRACTION),
    devPay: wallet instanceof MockWallet
      ? async (p) => {
          wallet.simulatePayment(p.quote.payAddress, p.quote.maxPriceZat);
          await worker.tick();
        }
      : undefined,
  });
  worker.start(Number(env.WORKER_INTERVAL_MS ?? 10_000));
  (wallet as { warm?: () => void }).warm?.(); // pre-make payment addresses so the first quotes are instant
  void Promise.all([wallet.balance("reserve"), wallet.balance("till"), wallet.reserveViewingKey()]).catch(() => {}); // warm caches
  const port = Number(env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, () => console.log(`Lucky Buy (${network}) on http://localhost:${port}`));
}
