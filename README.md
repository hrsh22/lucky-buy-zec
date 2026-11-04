# Lucky Buy — gift cards for shielded Zcash

> **Buy a gift card with shielded ZEC: you always get the card, you might pay half, and the code arrives in an encrypted memo only your wallet can read. No account, no email. An AI agent can do the whole thing for you from its own capped wallet.**

Built at the Free Society Hackathon, Mumbai, 4 Nov 2026, for both tracks:

- **Privacy (Zcash), theme 1 "private payment rails":**
  - a shielded checkout that matches payments to orders;
  - code delivery by encrypted memo;
  - proof of reserves by viewing key;
  - a provably fair Draw.
- **Agentic Commerce (Bitrefill), lanes 1, 2 and 5:**
  - an MCP agent that finds, buys and pays from its own shielded wallet, within hard spending caps;
  - it gets the code back with no copy-paste.

## What it does

1. **Pick a Voucher** (Bitrefill catalog) and pay its Reference Price R (Standard), or choose a **Lucky Buy** tier:

   | | Pay up front | Final Price range | Chance to pay ≤ R |
   |---|---|---|---|
   | Safe | 108% of R | 80%–108% | 30% |
   | Classic | 110% | 50%–110% | 22% |
   | Moonshot | 125% | **free**–125% | 72.65% |

   Every tier averages exactly 105% of R, so a tier only changes the variance. **The Voucher is always delivered.** The Draw only decides the Refund.
2. **Pay** the exact amount to a fresh shielded address (ZIP-321 QR). The quote is Ed25519-signed and commits to `SHA-256(seed)` before you pay.
3. After one confirmation, the server runs the **Draw** (`roll = SHA-256(seed ‖ quote id ‖ your txid ‖ "LUCKY_BUY_V1")`), buys the Voucher through the **Bitrefill API**, and sends your **Refund plus the code in an encrypted memo** to your return address.
4. **Verify** in your browser: the seed matches the commitment, the signature is valid, and the roll and outcome recompute. The check runs against the signed quote your browser saved when you bought.
5. **Agent mode:** Claude calls `lucky_buy`.
   - The agent pays from its own shielded wallet, within its caps. Its broadcasts go over the **Nym mixnet**.
   - It decrypts the delivery memo and replies with the code.
   - Above the caps, it hands you a payment link to approve instead.

## Run it in under 15 minutes

**Path A: everything simulated (2 minutes)**

```sh
git clone https://github.com/hrsh22/lucky-buy-zec && cd lucky-buy-zec
npm install
cp .env.example .env            # MOCK_WALLET=1, MOCK_BITREFILL=1
npm start                       # open http://localhost:8787 → quote → "Simulate payment" → reveal → verify
npm test
```

**Path B: real Zcash testnet + Bitrefill**

1. Build the wallet tool (about 5 minutes on a fast connection). zingolib v8 with our one-function patch:

   ```sh
   git clone -b zingolib_v8.0.0 https://github.com/zingolabs/zingolib && cd zingolib
   git apply ../lucky-buy-zec/patches/zingo-cli-v8-note-recipients.patch
   # server wallets
   cargo build --release -p zingo-cli --no-default-features --features nakednet-test-mode
   # agent wallet, with the Nym mixnet
   cargo build --release -p zingo-cli --target-dir target-nym
   cargo build --release -p zingo-netutils --features nym --bin nym-proxy --target-dir target-nym
   ```

2. Create the wallets. Each command makes a new wallet the first time:

   ```sh
   zingo-cli --chain testnet --server https://testnet.zec.rocks:443 --data-dir $PWD/wallets/testnet/<till|reserve|buyer> new_address o
   ```

   Fund them with TAZ from [Fauzec](https://fauzec.com/), the [Valar faucet](https://faucet.testnet.valargroup.dev/) or a mentor.
3. In `.env`, set:
   - `MOCK_WALLET=0` and `ZINGO_BIN`;
   - `MOCK_BITREFILL=0` and `BITREFILL_API_KEY`;
   - `AGENT_DIR` and `AGENT_ZINGO_BIN`.

   Then run `npm start`, and `npm run tunnel` if you want a public URL.
4. Pay a quote from the buyer wallet with `npm run e2e -- classic`, or let Claude do it (below).

**Claude (MCP).** Add this to `claude_desktop_config.json`, or run `claude mcp add` in Claude Code:

```json
{ "mcpServers": { "lucky-buy": { "command": "node", "args": ["--env-file=/abs/path/lucky-buy-zec/.env", "/abs/path/lucky-buy-zec/src/mcp.ts"] } } }
```

> *"Buy me a $10 gift card with Lucky Buy Classic."* Claude then calls `lucky_products`, then `lucky_buy`. It pays from its own wallet, waits for the Draw and delivery, and replies with the code from the memo.

## Guardrails: what an agent can spend

| Limit | Default (`.env`) | Above it |
|---|---|---|
| Per purchase | `AGENT_MAX_ZEC_PER_PURCHASE=0.03` TAZ | Nothing is paid. The agent returns a ZIP-321 link, and **the human approves by paying it from their own wallet** |
| Per rolling 24 h | `AGENT_MAX_ZEC_PER_DAY=0.1` TAZ, kept in a ledger file so it survives restarts | Same |
| Per request | optional `maxZec` budget from the user's prompt | Same |
| Hard ceiling | whatever sits in the agent wallet: fund it like a prepaid card | — |

The agent never holds the house's keys, only its own wallet's. `lucky_quote` lets an agent with no wallet at all quote and hand over the link.

## Bitrefill touchpoints

We use the **Bitrefill REST API v2** (`src/bitrefill.ts`):
- **Product lookup:** `GET /products/{id}` reads package values and prices for the catalog.
- **Buying:** `POST /invoices` with `payment_method: "balance"` and `auto_pay: true` buys from the house balance.
- **Delivery:** `GET /invoices/{id}` is polled until the order is `delivered`, then `redemption_info` is parsed into a code, PIN and link.
- **Balance:** `GET /accounts/balance` is shown on `/api/reserve`.

**What we built:**
- the whole game layer: quotes, the Draw, refunds;
- the Zcash payment and delivery layer;
- the agent wallet and its guardrails;
- the purchase state machine around Bitrefill, including treating "paid ≠ delivered" and "timeout ≠ failed" correctly.

**What we reused:** Bitrefill's fulfilment, so search, buy, pay and deliver all go through their API. We didn't rebuild a store.

Bitrefill doesn't accept ZEC, so the house pays Bitrefill from its balance and the buyer pays the house in shielded ZEC (lane 5). Feedback from building on the API is in [FEEDBACK.md](FEEDBACK.md).

## Privacy and trust note

**1. What stays private**
- **On chain:** the buyer's payment, the Refund and the delivery are all shielded, so sender, receiver, amounts and memos are encrypted. Payments go to a fresh diversified address per quote, so two purchases can't be linked by address.
- **The code:** the Voucher code exists only in the encrypted memo and the buyer's wallet. We delete it from our database the moment the delivery is sent, and never log it. Errors are scrubbed, because the send command carries the memo.
- **No account, email or phone:** the only identifier we keep is the return address the buyer gives us.
- **Agent payments:** broadcast over the **Nym mixnet**, so the light-wallet server doesn't learn the agent's IP when it pays.

**2. What the app reveals, and to whom**
- **Our server (the operator)** sees each quote: product, tier, amount, the buyer's return address, and the fact that a payment arrived. It also sees the code until delivery.
- **Bitrefill** sees that *our* account bought a product. It never sees the buyer.
- **The light-wallet server (`testnet.zec.rocks`)** sees our server's IP and when it syncs. The server wallets use a direct connection (no Nym). The agent wallet sends over Nym, but its **sync is still direct** (a zingo-cli limitation, see ZIP-318), so the indexer sees its IP during sync.
- **Cloudflare (the tunnel)** sees web visitors' IPs.
- **The public** sees only shielded transactions, plus the reserve wallet's balance through its published viewing key. The reserve only ever transacts with the till, so the key reveals no customer.
- **Anyone shown a verify link** sees that purchase's revealed seed and outcome.

**3. What users must trust**
- **The operator, with custody:** we hold the funds between payment and Refund. The buyer keeps a signed quote and the revealed seed, which publicly prove what they're owed.
- **The operator, with the Draw:** we can't bias a roll, because the seed is committed before the buyer's txid exists. We do see the outcome as soon as the payment lands, and could void a bad one by refunding in full ("Bitrefill failed"). A void is visible (the seed is still revealed and the refund memo says why) but not prevented.
- **Bitrefill:** that it delivers a valid code.
- **The Bitrefill balance:** it isn't covered by the viewing key, so `/api/reserve` reports it on trust.
- **The light-wallet server:** that it serves correct chain data.
- **The AI provider:** in agent mode, the model sees the conversation, and therefore the Voucher code it returns.

**4. What we'd fix next**
- Route **wallet sync** through NymVPN or a Nym SOCKS path, not just broadcasts, for the server wallets too.
- Put **Voucher acquisition before the reveal**, or into a contract, so the operator can't void a Draw.
- Show the Bitrefill balance with an attested receipt.

## Design decisions

- **Matching payments to orders by receiving address, not memo.** Payers' wallets often drop memos. Each quote gets a fresh diversified address, and we patched zingo-cli to report which address a note arrived on: stock zingo doesn't (`patches/`). On NU7 testnet, payments to orchard receivers land in the ironwood pool, so we read both pools.
- **Exact amount or a full refund.** Underpaid, overpaid, late and second payments are each refunded in full. Dust under 0.0002 is kept, because refunding it would cost more in fees than it's worth.
- **The till delivers, the reserve only backs it.** The reserve's viewing key is public (proof of reserves). A viewing key also reveals outgoing memos, so the reserve never pays customers. Otherwise anyone could read the codes.
- **Kelly-sized admission.** A tier is offered only if `R ≤ ½ · Kelly · (reserve − worst loss of open quotes)`. Capacity is checked and taken in one atomic step, so simultaneous quotes can't overbook it.
- **Never send twice.** A compare-and-set state machine in SQLite writes a `*_PENDING` state before every send or buy. Anything ambiguous (a crash mid-send, a Bitrefill timeout) parks in `NEEDS_ATTENTION` instead of being retried, because a retry could pay twice.
- **Two independent implementations of the maths.** `src/game.ts` (TypeScript), `web/fair.js` (browser) and `reference/lucky_buy.py` (Python) must all reproduce `test/vectors.json`.
- **Testnet economics.** TAZ has no price, so 1 TAZ is fixed at $1,000 (`TESTNET_USD_CENTS_PER_ZEC`). Mainnet uses CoinGecko with Kraken as a fallback.

## Technologies used

- **Zcash:**
  - testnet with NU7, unified addresses, the Orchard/Ironwood pools, ZIP-321 payment URIs and encrypted memos;
  - [zingolib / zingo-cli](https://github.com/zingolabs/zingolib) v8, patched, against `testnet.zec.rocks`;
  - unified full viewing keys for proof of reserves.
- **Nym:** zingo-cli's built-in Nym mixnet transport (`nym-proxy`) for the agent wallet's broadcasts.
- **Bitrefill:** REST API v2 (products, invoices with `auto_pay` from balance, redemption info).
- **AI:** Model Context Protocol, using the official TypeScript SDK, as a stdio server for Claude and other MCP clients.
- **Server:** Node.js 24 running TypeScript directly, Hono, `node:sqlite`, zod, and Ed25519 / SHA-256 from `node:crypto`.
- **Web:** plain HTML, CSS and JS; WebCrypto (Ed25519, SHA-256) for in-browser verification; qrcode-generator.
- **Tests:** vitest, plus a Python reference model (`reference/`).
- **Hosting:** a cloudflared quick tunnel.

## Evidence (real testnet)

Explorer links for every transaction are in [SUBMISSION.md](SUBMISSION.md).

| What | Zcash txids | Bitrefill invoice |
|---|---|---|
| Classic: delivered, code in memo | pay `f43e585e…`, deliver `ba81695e…` | `07fa9491-58e7-44f8-9c3d-f2efa0b6135c` |
| Moonshot: delivered with a Refund | pay `f3894662…`, deliver `317961f8…` | `dfb27f52-50fc-4182-8f53-7cd8b42a3b1f` |
| Standard: delivered | pay `04c74db0…`, deliver `5d8330bb…` | `c40f094b-05c3-4118-b465-8150b18ee505` |
| Underpaid: full refund | pay `bdbe8903…`, refund `d5cbb729…` | — |
| Bitrefill failed: full refund | pay `e445ef0f…`, refund `87264ebc…` | `e4825477-e205-4832-a538-b7219e058215` |

## Next 30 days

1. **Real product delivery on mainnet** with a funded Bitrefill balance: Indian gift cards and talktime top-ups, priced in INR.
2. **Nym for sync as well** (NymVPN or the Nym Zcash SDK), so neither the house nor the agent leaks its IP to the indexer.
3. **Upstream the zingo-cli patch** (receiving address per note) as a PR to zingolib. Payment processors need it to match orders without memos.
4. **Remove operator voiding:** buy the Voucher before revealing the seed, and publish signed receipts linking payment, invoice and outcome.
5. **A pilot with a Mumbai shop or creator** who wants private payments plus a "lucky" checkout option.

## Repository map

| Path | What |
|---|---|
| `src/server.ts` | HTTP API: quotes (signing, admission, limits), verify, reserve, SSE feed |
| `src/worker.ts` | Purchase state machine: payment scan → Draw → Bitrefill → memo delivery / refunds |
| `src/game.ts` | Tiers, Draw, money maths, Kelly admission |
| `src/wallet.ts` | zingo-cli adapter: address pool, notes per address, sends, address validation. Also MockWallet |
| `src/bitrefill.ts`, `src/rates.ts` | Bitrefill REST client (plus mock); ZEC/USD rate |
| `src/mcp.ts` | MCP tools: `lucky_products`, `lucky_quote`, `lucky_buy`, `lucky_code`, `lucky_status`, `lucky_verify`, `lucky_agent_wallet` |
| `web/` | Storefront, reveal and verify pages (browser re-implementation in `fair.js`) |
| `reference/` | Independent Python model that generates `test/vectors.json` |
| `scripts/` | Testnet end-to-end run, wallet and Bitrefill smoke tests |
| `patches/` | The zingo-cli patch |

All code in this repo was written during the hackathon (4 Nov 2026, from 11:00 IST). The game's design (tier tables, fairness scheme) was sketched beforehand as research notes, as the rules allow.
