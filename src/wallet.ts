import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { ReceivedNote, Wallet, WalletAccount, ZcashNetwork } from "./types.ts";

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** In-memory wallet for tests and MOCK_WALLET=1. Deterministic txids. */
export class MockWallet implements Wallet {
  notes: ReceivedNote[] = [];
  sent: { from: WalletAccount; to: string; valueZat: number; memo: string; txid: string }[] = [];
  balances: Record<WalletAccount, number>;
  tip = 1000;
  private n = 0;
  private prefix: string;
  private salt = Math.random().toString(36); // a restart against a kept database mustn't reuse addresses

  constructor(opts: { network?: ZcashNetwork; reserveZat?: number; tillZat?: number } = {}) {
    this.prefix = opts.network === "mainnet" ? "u1mock" : "utest1mock";
    this.balances = { reserve: opts.reserveZat ?? 10_000_000, till: opts.tillZat ?? 10_000_000 };
  }

  async newAddress() {
    return `${this.prefix}${hex(`${this.salt}addr${this.n++}`).slice(0, 40)}`;
  }

  async received() {
    return this.notes.map((n) => ({ ...n, confirmations: n.minedHeight === null ? 0 : this.tip - n.minedHeight + 1 }));
  }

  async send(from: WalletAccount, to: string, valueZat: number, memo: string) {
    if (Buffer.byteLength(memo, "utf8") > 512) throw new Error("memo over 512 bytes");
    if (this.balances[from] < valueZat) throw new Error(`insufficient ${from} balance`);
    this.balances[from] -= valueZat;
    const txid = hex(`send${this.n++}`);
    this.sent.push({ from, to, valueZat, memo, txid });
    return { txid };
  }

  async balance(account: WalletAccount) {
    return { spendableZat: this.balances[account], totalZat: this.balances[account] };
  }

  async reserveViewingKey() {
    return "uviewtest1mockreserveviewingkey";
  }

  async height() {
    return this.tip;
  }

  /** Test/dev helper: a buyer pays `address`. `confirmations = 0` leaves it unmined. */
  simulatePayment(address: string, valueZat: number, confirmations = 1, txid = hex(`pay${this.n++}`)): string {
    this.notes.push({ txid, outputIndex: 0, address, valueZat, memo: null, confirmations: 0, minedHeight: confirmations > 0 ? this.tip - confirmations + 1 : null });
    this.balances.till += valueZat;
    return txid;
  }
}

const exec = promisify(execFile);
const LOCAL_COMMANDS = new Set(["new_address", "export_ufvk", "height", "recovery_info"]);

/** Pulls the last top-level JSON object out of zingo-cli's chatty stdout. */
export function lastJson(stdout: string): any {
  // Either one line (`{"status":…}`) or pretty-printed with the top-level braces alone at column 0.
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.startsWith("{")) continue;
    if (lines[i]!.trimEnd().endsWith("}")) return JSON.parse(lines[i]!);
    const end = lines.findIndex((l, j) => j > i && /^\}\s*$/.test(l));
    if (end > i) return JSON.parse(lines.slice(i, end + 1).join("\n"));
  }
  throw new Error(`zingo-cli: no JSON in output: ${stdout.slice(-300)}`);
}

/**
 * zingo-cli (patched v8, see README) driven one command per process. One wallet dir per account,
 * one in-flight command per dir (D10). Payment addresses are orchard-only UAs so the patched
 * `notes` output can say which diversified address each note arrived on.
 */
export class ZingoWallet implements Wallet {
  private locks = new Map<WalletAccount, Promise<unknown>>();
  private o: { bin: string; network: ZcashNetwork; server: string; dirs: Record<WalletAccount, string> };
  /** Sync before each send. Off for the server (the worker syncs the till at the start of every tick). */
  private syncBeforeSend: boolean;
  constructor(o: ZingoWallet["o"] & { syncBeforeSend?: boolean }) {
    this.o = o;
    this.syncBeforeSend = o.syncBeforeSend ?? false;
  }

  private run(account: WalletAccount, args: string[], sync: boolean): Promise<any> {
    const prev = this.locks.get(account) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      // Local commands run --offline: no network, and a Nym build doesn't boot its mixnet proxy for them.
      const conn = LOCAL_COMMANDS.has(args[0]!) ? ["--offline"] : ["--server", this.o.server, sync ? "--waitsync" : "--nosync"];
      const argv = ["--chain", this.o.network, "--data-dir", this.o.dirs[account], ...conn, ...args];
      let stdout: string;
      try {
        ({ stdout } = await exec(this.o.bin, argv, { timeout: 300_000, maxBuffer: 64 << 20 }));
      } catch (e) {
        // Never surface argv: a quicksend's memo carries the Voucher code.
        const err = e as { stderr?: string; killed?: boolean; code?: unknown };
        const why = String(err.stderr ?? "").split("\n").filter((l) => /error|caused by/i.test(l)).join(" ").slice(0, 300);
        throw new Error(`zingo-cli ${args[0]} failed (${err.killed ? "timeout" : `exit ${err.code}`}): ${why || "no stderr"}`);
      }
      const out = lastJson(stdout);
      if (out?.error) throw new Error(`zingo-cli ${args[0]}: ${out.error}`);
      return out;
    });
    this.locks.set(account, next);
    return next;
  }

  // A few addresses made ahead of time, so a quote never queues behind a sync or send on the till lock.
  private pool: string[] = [];
  private filling?: Promise<void>;
  private fresh = async () => (await this.run("till", ["new_address", "o"], false)).encoded_address as string;
  /** Tops the pool up in the background. Called after each pop and once at startup. */
  warm(size = 5) {
    this.filling ??= (async () => {
      while (this.pool.length < size) this.pool.push(await this.fresh());
    })()
      .catch(() => {})
      .finally(() => (this.filling = undefined));
  }

  async newAddress() {
    const a = this.pool.pop();
    this.warm();
    return a ?? this.fresh();
  }

  private parsing: Promise<unknown> = Promise.resolve();
  /** Checksum, network and receivers via zingo's offline parser (~20 ms). Serialized: the CLI saves a file in its dir. */
  isValidReturnAddress(addr: string): Promise<boolean> {
    const next = this.parsing.then(() => this.parseAddress(addr));
    this.parsing = next;
    return next;
  }

  private async parseAddress(addr: string) {
    try {
      const dir = `${this.o.dirs.till}/../address-parser`;
      const { stdout } = await exec(this.o.bin, ["--chain", this.o.network, "--data-dir", dir, "--offline", "parse_address", addr], { timeout: 10_000 });
      const r = lastJson(stdout);
      const chain = this.o.network === "mainnet" ? "main" : "test";
      const shielded = r.address_kind === "sapling" || (r.receivers_available ?? []).some((x: string) => x === "orchard" || x === "sapling");
      return r.status === "success" && r.chain_name === chain && shielded;
    } catch {
      return false;
    }
  }

  async received(): Promise<ReceivedNote[]> {
    const out = await this.run("till", ["notes", "all"], true);
    const tip: number = out.height;
    const to = new Map<string, string>(
      out.orchard_recipients.map((r: any) => [`${r.txid}:${r.output_index}`, r.recipient]),
    );
    // Testnet's ironwood pool reuses orchard receivers, so a payment can land in either pool.
    return [...out.orchard_notes.note_summaries, ...(out.ironwood_notes?.note_summaries ?? [])]
      .filter((n: any) => n.scope === "external" && to.get(`${n.txid}:${n.output_index}`))
      .map((n: any): ReceivedNote => {
        // status: "<status> at block height <h>"
        const h = Number(/block height (\d+)/.exec(n.status)?.[1] ?? NaN);
        const mined = /^confirmed/i.test(n.status) && Number.isFinite(h);
        return {
          txid: String(n.txid).toLowerCase(), outputIndex: n.output_index, address: to.get(`${n.txid}:${n.output_index}`)!, valueZat: n.value,
          memo: n.memo ?? null, minedHeight: mined ? h : null, confirmations: mined ? Math.max(0, tip - h + 1) : 0,
        };
      });
  }

  async send(from: WalletAccount, to: string, valueZat: number, memo: string) {
    const out = await this.run(from, ["quicksend", JSON.stringify([{ address: to, amount: valueZat, memo }])], this.syncBeforeSend);
    const txid = out.txids?.[0];
    if (!txid) throw new Error(`zingo-cli quicksend: no txid in ${JSON.stringify(out)}`);
    // zingo reports per broadcast whether it went over the Nym mixnet (only true for a Nym build)
    return { txid: String(txid).toLowerCase(), overMixnet: out.transmissions?.[0]?.over_mixnet === true };
  }

  private balances = new Map<WalletAccount, { at: number; zat: number | null; refreshing: Promise<number> | null }>();
  /**
   * Stale-while-revalidate: returns the last synced balance at once and refreshes in the background
   * when it's over 60 s old, so page loads never wait on a wallet sync. Only the very first call blocks.
   */
  async balance(account: WalletAccount) {
    let e = this.balances.get(account);
    if (!e) this.balances.set(account, (e = { at: 0, zat: null, refreshing: null }));
    if (Date.now() - e.at > 60_000 && !e.refreshing) {
      const entry = e;
      entry.refreshing = this.run(account, ["spendable_balance"], true)
        .then((o) => Object.assign(entry, { at: Date.now(), zat: Number(o.spendable_balance) }).zat!)
        .finally(() => (entry.refreshing = null));
      entry.refreshing.catch(() => {});
    }
    const spendableZat = e.zat ?? (await e.refreshing!);
    return { spendableZat, totalZat: spendableZat }; // ponytail: total = spendable; parse `balance` if unconfirmed matters
  }

  private ufvk?: Promise<string>;
  reserveViewingKey() {
    this.ufvk ??= this.run("reserve", ["export_ufvk"], false).then((o) => o.ufvk as string);
    this.ufvk.catch(() => (this.ufvk = undefined));
    return this.ufvk;
  }

  async height() {
    return (await this.run("till", ["height"], false)).height as number;
  }
}

export function makeWallet(env = process.env): Wallet {
  const network = (env.ZCASH_NETWORK ?? "testnet") as ZcashNetwork;
  if (env.MOCK_WALLET === "1") return new MockWallet({ network });
  return new ZingoWallet({
    bin: env.ZINGO_BIN ?? "zingo-cli",
    network,
    server: env.LIGHTWALLETD_URL ?? "https://testnet.zec.rocks:443",
    dirs: { till: env.TILL_DIR ?? `./wallets/${network}/till`, reserve: env.RESERVE_DIR ?? `./wallets/${network}/reserve` },
  });
}
