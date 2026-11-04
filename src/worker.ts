import { TIERS, deliveryZat, draw, refundZat } from "./game.ts";
import type { Db } from "./db.ts";
import type { Bitrefill, Purchase, ReceivedNote, RefundReason, Wallet } from "./types.ts";

export interface WorkerDeps {
  db: Db;
  wallet: Wallet;
  bitrefill: Bitrefill;
  graceMin?: number; // QUOTE_GRACE_MIN (D8)
  minConfirmations?: number; // MIN_CONFIRMATIONS: 1 on testnet; use 3+ on mainnet (reorg double-spend)
  dustZat?: number; // notes below this are kept, not refunded: a refund would cost the till more in fees
  now?: () => Date;
  onDrawn?: (p: Purchase) => void; // feeds GET /api/feed
  log?: (msg: string) => void;
}

const MEMO_MAX = 512;

/** seen_notes key: the txid alone for output 0 (keeps rows written before output indexes existed). */
const noteKey = (n: ReceivedNote) => (n.outputIndex ? `${n.txid}:${n.outputIndex}` : n.txid);

/**
 * Only a definite rejection (4xx, unknown product) proves no Voucher was bought. A timeout or 5xx may have
 * created and paid the invoice, so refunding then could pay twice: park it for a human instead (D10).
 */
export const isDefiniteBuyRejection = (msg: string) => /HTTP 4\d\d|not in catalog|package gone/.test(msg);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** D9 delivery memo: drop Link first, then truncate to 512 bytes. */
export function deliveryMemo(p: Purchase): string {
  const r = p.redemption!;
  const fv = p.quote.faceValue;
  const tail = `You paid ${(p.finalBps! / 100).toFixed(2).replace(/\.?0+$/, "")}% of ${fv.amount} ${fv.currency}`;
  const lines = (link: boolean) =>
    [`Lucky Buy ${p.id}`, `Code: ${r.code}`, r.pin && `PIN: ${r.pin}`, link && r.link && `Link: ${r.link}`, tail]
      .filter(Boolean)
      .join("\n");
  let memo = lines(true);
  if (bytes(memo) > MEMO_MAX) memo = lines(false);
  while (bytes(memo) > MEMO_MAX) memo = memo.slice(0, -1);
  return memo;
}

export function makeWorker(deps: WorkerDeps) {
  const { db, wallet, bitrefill } = deps;
  const graceMs = (deps.graceMin ?? 10) * 60_000;
  const minConf = deps.minConfirmations ?? 1;
  const dustZat = deps.dustZat ?? 20_000;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(`[worker] ${m}`));

  // One step on one purchase; a failure is logged and doesn't stall the others.
  const each = async (ps: Purchase[], fn: (p: Purchase) => Promise<unknown>) => {
    for (const p of ps) {
      try {
        await fn(p);
      } catch (e) {
        log(`${p.id} ${p.status}: ${(e as Error).message}`);
      }
    }
  };

  /** A send is never retried: on any throw the purchase parks in NEEDS_ATTENTION (D10). */
  const sendOrPark = async (p: Purchase, pendingStatus: Purchase["status"], to: string, zat: number, memo: string) => {
    try {
      return await wallet.send("till", to, zat, memo);
    } catch (e) {
      db.transition(p.id, pendingStatus, "NEEDS_ATTENTION", { error: (e as Error).message }, "send threw");
      throw e;
    }
  };

  /** Confirmations of the latest note seen per pay address, so the UI can say "waiting for confirmation". */
  const paymentConfirmations = new Map<string, number>();

  async function scan() {
    for (const note of await wallet.received()) {
      if (db.isSeen(noteKey(note), note.address)) continue;
      const p = db.byPayAddress(note.address);
      if (!p) continue; // change, float splits, reserve top-ups: not a purchase payment
      paymentConfirmations.set(note.address, note.confirmations);
      if (note.confirmations < minConf) continue;
      // Dust (but never the exact quoted amount): refunding it would cost the till more in fees than it's worth.
      if (note.valueZat < dustZat && note.valueZat !== p.quote.maxPriceZat) {
        if (db.markSeen(noteKey(note), note.address, p.id, "dust_kept")) log(`${p.id} kept dust note ${note.txid} (${note.valueZat} zat)`);
        continue;
      }
      try {
        await classify(p, note);
      } catch (e) {
        log(`${p.id} note ${note.txid}: ${(e as Error).message}`);
      }
    }
  }

  async function classify(p: Purchase, note: ReceivedNote) {
    const key = noteKey(note);
    const seen = (outcome: string) => ({ txid: key, address: note.address, outcome });
    const late = now().getTime() > new Date(p.quote.expiresAt).getTime() + graceMs;
    if (p.status === "QUOTED" || p.status === "EXPIRED") {
      const reason: RefundReason | null =
        p.status === "EXPIRED" || late ? "late"
        : note.valueZat < p.quote.maxPriceZat ? "underpaid"
        : note.valueZat > p.quote.maxPriceZat ? "overpaid"
        : null;
      if (!reason) {
        db.transition(p.id, "QUOTED", "PAID", { paymentTxid: note.txid, paidZat: note.valueZat }, undefined, seen("paid"));
      } else {
        db.transition(p.id, p.status, "REFUNDING", { paymentTxid: note.txid, paidZat: note.valueZat, refundReason: reason }, reason, seen(reason));
      }
      return;
    }
    // A second note to an address whose purchase is already underway: refund that note on its own (D7).
    if (!db.markSeen(key, note.address, p.id, "stray_refund_pending")) return;
    let txid: string;
    try {
      ({ txid } = await wallet.send("till", p.quote.returnAddress, note.valueZat, `Lucky Buy ${p.id} refund: duplicate payment`));
    } catch (e) {
      db.setSeenOutcome(key, note.address, "stray_needs_attention"); // never resent automatically
      throw e;
    }
    db.setSeenOutcome(key, note.address, `stray_refunded ${txid}`);
    log(`${p.id} stray note ${note.txid} refunded in ${txid}`);
  }

  function expire() {
    const cutoff = now().getTime() - graceMs;
    for (const p of db.listByStatus("QUOTED")) {
      if (new Date(p.quote.expiresAt).getTime() < cutoff) db.transition(p.id, "QUOTED", "EXPIRED");
    }
  }

  const drawAll = () =>
    each(db.listByStatus("PAID"), async (p) => {
      const tier = TIERS[p.quote.tier];
      const { roll, finalBps } = draw(tier, Buffer.from(p.serverSeed, "hex"), p.id, p.paymentTxid!);
      const refund = refundZat(tier, p.paidZat!, finalBps);
      if (db.transition(p.id, "PAID", "DRAWN", { roll, finalBps, refundZat: refund })) deps.onDrawn?.(db.get(p.id)!);
    });

  const fulfill = () =>
    each(db.listByStatus("DRAWN"), async (p) => {
      if (!db.transition(p.id, "DRAWN", "FULFILL_PENDING")) return;
      try {
        const { invoiceId } = await bitrefill.buy(p.quote.productId, p.id);
        db.transition(p.id, "FULFILL_PENDING", "FULFILL_PENDING", { bitrefillInvoiceId: invoiceId }, `invoice ${invoiceId}`);
      } catch (e) {
        const error = (e as Error).message;
        if (isDefiniteBuyRejection(error)) {
          db.transition(p.id, "FULFILL_PENDING", "REFUNDING", { refundReason: "fulfillment_failed", error }, "buy rejected");
        } else {
          db.transition(p.id, "FULFILL_PENDING", "NEEDS_ATTENTION", { error }, "buy outcome unknown");
        }
      }
    });

  const poll = () =>
    each(db.listByStatus("FULFILL_PENDING").filter((p) => p.bitrefillInvoiceId), async (p) => {
      const inv = await bitrefill.invoice(p.bitrefillInvoiceId!);
      if (inv.status === "complete") db.transition(p.id, "FULFILL_PENDING", "FULFILLED", { redemption: inv.redemption });
      if (inv.status === "failed")
        db.transition(p.id, "FULFILL_PENDING", "REFUNDING", { refundReason: "fulfillment_failed", error: inv.error }, inv.error);
    });

  const deliver = () =>
    each(db.listByStatus("FULFILLED"), async (p) => {
      if (!db.transition(p.id, "FULFILLED", "DELIVER_PENDING")) return;
      const { txid } = await sendOrPark(p, "DELIVER_PENDING", p.quote.returnAddress, deliveryZat(p.refundZat!), deliveryMemo(p));
      db.transition(p.id, "DELIVER_PENDING", "DELIVERED", { sendTxid: txid, redemption: undefined });
    });

  const refund = () =>
    each(db.listByStatus("REFUNDING"), async (p) => {
      if (!db.transition(p.id, "REFUNDING", "REFUND_PENDING")) return;
      const memo = `Lucky Buy ${p.id} refund: ${p.refundReason}`;
      const { txid } = await sendOrPark(p, "REFUND_PENDING", p.quote.returnAddress, p.paidZat!, memo);
      db.transition(p.id, "REFUND_PENDING", "REFUNDED", { refundTxid: txid });
    });

  /** Run once at startup, before the first tick: anything mid-send or mid-buy from a dead process needs a human. */
  function recover() {
    for (const p of db.listByStatus("DELIVER_PENDING", "REFUND_PENDING"))
      db.transition(p.id, p.status, "NEEDS_ATTENTION", { error: "crashed during send" }, "recover");
    for (const p of db.listByStatus("FULFILL_PENDING").filter((p) => !p.bitrefillInvoiceId))
      db.transition(p.id, "FULFILL_PENDING", "NEEDS_ATTENTION", { error: "crashed during buy" }, "recover");
    for (const s of db.seenWithOutcome("stray_refund_pending")) {
      db.setSeenOutcome(s.txid, s.address, "stray_needs_attention");
      log(`stray note ${s.txid} for ${s.purchase_id} needs attention`);
    }
  }

  let running: Promise<void> | null = null;
  /** One full pass. Overlapping calls share the in-flight pass instead of starting a second one. */
  function tick(): Promise<void> {
    running ??= (async () => {
      try {
        await scan();
        expire();
        await drawAll();
        await fulfill();
        await poll();
        await deliver();
        await refund();
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function start(intervalMs = 10_000) {
    recover();
    let stopped = false;
    const loop = async () => {
      if (stopped) return;
      await tick().catch((e) => log(`tick: ${(e as Error).message}`));
      if (!stopped) timer = setTimeout(loop, intervalMs);
    };
    let timer = setTimeout(loop, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  return { tick, recover, start, paymentConfirmations };
}
