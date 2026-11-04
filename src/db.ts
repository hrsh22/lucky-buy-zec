import { DatabaseSync } from "node:sqlite";
import { TIERS, worstHouseLossUsdCents } from "./game.ts";
import type { Purchase, PurchaseStatus } from "./types.ts";

// Statuses whose worst-case loss still counts against the reserve (D6).
const OPEN: PurchaseStatus[] = ["QUOTED", "PAID", "DRAWN", "FULFILL_PENDING", "FULFILLED", "DELIVER_PENDING"];

export type Db = ReturnType<typeof openDb>;

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, pay_address TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS purchases_status ON purchases(status);
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id TEXT NOT NULL, at TEXT NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, detail TEXT);
    CREATE TABLE IF NOT EXISTS seen_notes (
      txid TEXT NOT NULL, address TEXT NOT NULL, purchase_id TEXT, outcome TEXT NOT NULL,
      PRIMARY KEY (txid, address));
  `);

  const row = (r: unknown): Purchase | undefined => (r ? (JSON.parse((r as { data: string }).data) as Purchase) : undefined);
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const insertSeen = (txid: string, address: string, purchaseId: string | null, outcome: string): boolean =>
    db.prepare("INSERT OR IGNORE INTO seen_notes (txid, address, purchase_id, outcome) VALUES (?, ?, ?, ?)")
      .run(txid, address, purchaseId, outcome).changes === 1;
  const event = db.prepare("INSERT INTO events (purchase_id, at, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?)");

  return {
    insertQuoted(p: Purchase): void {
      if (p.status !== "QUOTED") throw new Error("insertQuoted needs status QUOTED");
      tx(() => {
        db.prepare("INSERT INTO purchases (id, status, pay_address, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(p.id, p.status, p.quote.payAddress, JSON.stringify(p), p.createdAt, p.updatedAt);
        event.run(p.id, p.createdAt, null, "QUOTED", null);
      });
    },

    get: (id: string): Purchase | undefined => row(db.prepare("SELECT data FROM purchases WHERE id = ?").get(id)),

    byPayAddress: (addr: string): Purchase | undefined =>
      row(db.prepare("SELECT data FROM purchases WHERE pay_address = ?").get(addr)),

    listByStatus(...statuses: PurchaseStatus[]): Purchase[] {
      const q = `SELECT data FROM purchases WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`;
      return db.prepare(q).all(...statuses).map((r) => row(r)!);
    },

    /** Compare-and-set: applies only if the row is still in `from`. Returns whether it applied. */
    transition(
      id: string, from: PurchaseStatus, to: PurchaseStatus, patch: Partial<Purchase> = {}, detail?: string,
      seen?: { txid: string; address: string; outcome: string },
    ): boolean {
      return tx(() => {
        const cur = row(db.prepare("SELECT data FROM purchases WHERE id = ? AND status = ?").get(id, from));
        if (!cur) return false;
        // Atomically claim the note with the transition, so a note can't drive two transitions.
        if (seen && !insertSeen(seen.txid, seen.address, id, seen.outcome)) return false;
        const now = new Date().toISOString();
        const next: Purchase = { ...cur, ...patch, id, status: to, updatedAt: now };
        // `redemption: undefined` in a patch purges it; JSON.stringify drops undefined keys.
        db.prepare("UPDATE purchases SET status = ?, data = ?, updated_at = ? WHERE id = ? AND status = ?")
          .run(to, JSON.stringify(next), now, id, from);
        event.run(id, now, from, to, detail ?? null);
        return true;
      });
    },

    /** Records a note as handled. False if it was already seen (so it's processed exactly once). */
    markSeen: insertSeen,

    setSeenOutcome(txid: string, address: string, outcome: string): void {
      db.prepare("UPDATE seen_notes SET outcome = ? WHERE txid = ? AND address = ?").run(outcome, txid, address);
    },

    seenWithOutcome: (outcome: string) =>
      db.prepare("SELECT txid, address, purchase_id FROM seen_notes WHERE outcome = ?").all(outcome) as
        { txid: string; address: string; purchase_id: string }[],

    isSeen: (txid: string, address: string): boolean =>
      !!db.prepare("SELECT 1 FROM seen_notes WHERE txid = ? AND address = ?").get(txid, address),

    /**
     * Σ worst-case house loss over in-flight purchases (QUOTED … DELIVER_PENDING). A QUOTED purchase counts
     * until expiry + grace, because the worker still accepts its payment during the grace window.
     */
    openWorstLossUsdCents(now = new Date(), graceMs = 10 * 60_000): number {
      let sum = 0;
      for (const p of this.listByStatus(...OPEN)) {
        if (p.status === "QUOTED" && new Date(p.quote.expiresAt).getTime() + graceMs < now.getTime()) continue;
        sum += worstHouseLossUsdCents(TIERS[p.quote.tier], p.quote.referenceUsdCents);
      }
      return sum;
    },

    /**
     * USD cents of real (non-test) Vouchers committed in the last 24 h: every quote that isn't expired or
     * refunded, so open quotes count too. Feeds the house's daily Bitrefill budget.
     */
    realSpendUsdCents(now = new Date()): number {
      const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
      const r = db.prepare(
        `SELECT COALESCE(SUM(json_extract(data, '$.quote.referenceUsdCents')), 0) AS c FROM purchases
         WHERE created_at >= ? AND json_extract(data, '$.quote.isTestProduct') = 0 AND status NOT IN ('EXPIRED', 'REFUNDED')`,
      ).get(since) as { c: number };
      return r.c;
    },

    /** The latest drawn purchases, newest first, for the "recent spins" feed. */
    recentDraws(n = 8): Purchase[] {
      return db.prepare("SELECT data FROM purchases WHERE json_extract(data, '$.finalBps') IS NOT NULL ORDER BY updated_at DESC LIMIT ?")
        .all(n).map((r) => row(r)!);
    },

    events: (id: string) => db.prepare("SELECT * FROM events WHERE purchase_id = ? ORDER BY seq").all(id),

    close: () => db.close(),
  };
}
