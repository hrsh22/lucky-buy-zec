// Contracts shared by the server, worker, adapters, MCP server and tests.
import type { Outcome, TierId } from "./game.ts";

export type ZcashNetwork = "testnet" | "mainnet";

// ---------------------------------------------------------------- purchase lifecycle

/**
 * QUOTED → PAID → DRAWN → FULFILL_PENDING → FULFILLED → DELIVER_PENDING → DELIVERED
 * Side paths: QUOTED → EXPIRED; any bad payment or failed buy → REFUNDING → REFUND_PENDING → REFUNDED;
 * a send or buy whose outcome is unknown → NEEDS_ATTENTION (never retried automatically).
 */
export type PurchaseStatus =
  | "QUOTED"
  | "EXPIRED"
  | "PAID"
  | "DRAWN"
  | "FULFILL_PENDING"
  | "FULFILLED"
  | "DELIVER_PENDING"
  | "DELIVERED"
  | "REFUNDING"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "NEEDS_ATTENTION";

export const TERMINAL: ReadonlySet<PurchaseStatus> = new Set(["EXPIRED", "DELIVERED", "REFUNDED", "NEEDS_ATTENTION"]);

export type RefundReason = "underpaid" | "overpaid" | "late" | "fulfillment_failed";

/** What the buyer is shown and signs off on before paying. Signed by the server; never changes afterwards. */
export interface Quote {
  v: "LUCKY_BUY_V1";
  network: ZcashNetwork;
  id: string; // lowercase UUID v4
  productId: string;
  productName: string;
  isTestProduct: boolean;
  faceValue: { amount: number; currency: string }; // display only
  referenceUsdCents: number; // R
  tier: TierId;
  maxBps: number; // M, bps of R
  table: Outcome[]; // the exact outcome table the Draw will use
  rateUsdCentsPerZec: number; // locked for the quote's lifetime
  maxPriceZat: number; // the exact amount to pay
  payAddress: string; // fresh diversified address of the till
  returnAddress: string; // buyer's shielded address: Refund, code memo and any refund go here
  commit: string; // hex SHA-256 of the server seed
  createdAt: string;
  expiresAt: string;
}

export interface SignedQuote {
  quote: Quote;
  signature: string; // hex Ed25519 over canonicalJson(quote)
  publicKey: string; // hex raw 32-byte Ed25519 key, also on /api/reserve
  zip321: string; // zcash: payment URI
}

/** Database row. Holds secrets (seed before the Draw, redemption until delivery): never sent as-is. */
export interface Purchase {
  id: string;
  status: PurchaseStatus;
  quote: Quote;
  signature: string;
  serverSeed: string;
  paymentTxid?: string;
  paidZat?: number;
  roll?: number;
  finalBps?: number;
  refundZat?: number;
  bitrefillInvoiceId?: string;
  redemption?: Redemption; // purged on delivery
  sendTxid?: string;
  refundReason?: RefundReason;
  refundTxid?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- Zcash wallet

export type WalletAccount = "till" | "reserve";

export interface ReceivedNote {
  txid: string; // lowercase hex, display order
  outputIndex: number; // one tx can pay the same address twice
  address: string; // the receiving address: matched against quote.payAddress
  valueZat: number;
  memo: string | null;
  confirmations: number; // 0 while in the mempool
  minedHeight: number | null;
}

export interface Wallet {
  newAddress(): Promise<string>; // fresh diversified address on the till
  received(): Promise<ReceivedNote[]>; // every note the till has received
  send(from: WalletAccount, to: string, valueZat: number, memo: string): Promise<{ txid: string }>;
  balance(account: WalletAccount): Promise<{ spendableZat: number; totalZat: number }>;
  reserveViewingKey(): Promise<string>; // published for proof of reserves
  height(): Promise<number>;
  /** Full address check (checksum, network, shielded receiver). Optional: the server falls back to a prefix check. */
  isValidReturnAddress?(addr: string): Promise<boolean>;
}

// ---------------------------------------------------------------- Bitrefill

export interface Product {
  id: string; // `<product><&><package>` as Bitrefill names packages
  name: string;
  isTest: boolean;
  faceValue: { amount: number; currency: string };
  referenceUsdCents: number; // R
}

export interface Redemption {
  code: string;
  pin?: string;
  link?: string;
}

export type InvoiceState =
  | { status: "pending" }
  | { status: "complete"; redemption: Redemption }
  | { status: "failed"; error: string };

export interface Bitrefill {
  products(): Promise<Product[]>;
  product(id: string): Promise<Product>;
  buy(productId: string, purchaseId: string): Promise<{ invoiceId: string }>;
  invoice(invoiceId: string): Promise<InvoiceState>;
  balanceUsdCents(): Promise<number>;
}

export interface Rates {
  usdCentsPerZec(): Promise<number>;
}

// ---------------------------------------------------------------- HTTP API

export interface QuoteRequest {
  productId: string;
  tier: TierId;
  returnAddress: string;
}

export type QuoteResponse = SignedQuote | { error: "tier_unavailable"; availableTiers: TierId[] } | { error: string };

/** GET /api/purchase/:id. No redemption, and no seed until the Draw. */
export interface PurchaseView {
  id: string;
  status: PurchaseStatus;
  quote: Quote;
  zip321: string;
  confirmations?: number; // of a payment seen while QUOTED
  paymentTxid?: string;
  roll?: number;
  finalBps?: number;
  refundZat?: number;
  serverSeed?: string;
  sendTxid?: string;
  refundReason?: RefundReason;
  refundTxid?: string;
}

/** GET /api/verify/:id: everything needed to recompute the Draw independently. */
export interface VerifyView {
  quote: Quote;
  signature: string;
  publicKey: string;
  serverSeed: string;
  paymentTxid: string;
  roll: number;
  finalBps: number;
  checks: { commitMatches: boolean; signatureValid: boolean; rollMatches: boolean; outcomeMatches: boolean };
}

/** GET /api/reserve: proof of reserves and the live admission limits. */
export interface ReserveView {
  network: ZcashNetwork;
  ufvk: string;
  reserveZat: number;
  tillZat: number;
  bitrefillBalanceUsdCents: number;
  rateUsdCentsPerZec: number;
  rateSource: "live" | "testnet_fixed";
  openWorstLossUsdCents: number;
  kellyFraction: number;
  admissionLimitUsdCents: Record<TierId, number | null>; // null = no limit
  quotePublicKey: string;
}

/** GET /api/feed SSE event "purchase": outcome only, never addresses, txids or codes. */
export interface FeedEvent {
  at: string;
  productName: string;
  tier: TierId;
  finalBps: number;
  maxBps: number;
}
