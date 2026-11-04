# Stadium submission — Lucky Buy

Paste-ready answers for [Stadium](https://stadium.joinwebzero.com/programs/free-society-hack-2026). Enter **both tracks**.

- **Repo:** https://github.com/hrsh22/lucky-buy-zec
- **Public URL:** https://luckybuy.hrsh.dev (Zcash testnet). Judges can quote, pay from any NU7 testnet wallet, and verify. The reserve and admission limits are at https://luckybuy.hrsh.dev/api/reserve.
- **Demo video:** 3 minutes max (script below).

## One-line pitch

**Buy gift cards with shielded ZEC: the Voucher is guaranteed, a provably fair Draw can cut the price (even to free), and the code comes back in an encrypted memo. An AI agent can do it all from its own capped wallet.** For people who want to spend ZEC privately, and for the agents that shop for them.

## Which parts are for which track

| Track | What to judge |
|---|---|
| **Privacy (Zcash)**, theme 1 "private payment rails" | **Noir Wallet** one-click connect and pay, then the shielded checkout: per-quote diversified addresses matched to orders by receiving address (zingo-cli patch), exact-amount rules with full refunds, Refund plus Voucher code delivered in an encrypted memo, proof of reserves by published UFVK, a provably fair Draw verified in the browser, and the Nym mixnet for the agent's payments |
| **Agentic Commerce (Bitrefill)**, lanes 1, 2 and 5 | The MCP server. `lucky_search` finds the product in Bitrefill's catalog, `lucky_buy` pays from the agent's own shielded wallet within hard caps, buys through the Bitrefill API, and reads the code back from the memo, so nothing is copied by hand. Above the caps, a human approves by paying a link |

## Privacy track fields

**One testnet transaction ID:** `ba81695ebee3483b863c99b17657d5a127f2114e0ff47bbfec63d9a77de306a3`. That's a shielded delivery note carrying a Refund and the Voucher code in its memo ([explorer](https://testnet.zcashexplorer.app/transactions/ba81695ebee3483b863c99b17657d5a127f2114e0ff47bbfec63d9a77de306a3)).

**Privacy and trust note:** see [README → Privacy and trust note](README.md#privacy-and-trust-note), which answers the four questions. In short:
- **Private:** payment, Refund and code are shielded; there's no account or email; codes are deleted after delivery.
- **Revealed:** the operator sees quotes and return addresses; the indexer sees the server's IP; Bitrefill sees only our account.
- **Trusted:** the operator (custody, and it could visibly void a Draw), Bitrefill, the light-wallet server, and the AI provider in agent mode.
- **Fix next:** Nym for wallet sync, and Voucher acquisition before the reveal.

**Next step (30 days):** see [README → Next 30 days](README.md#next-30-days):
- mainnet with real Indian vouchers;
- Nym for sync as well as broadcasts;
- an upstream PR to zingolib for the per-note receiving address;
- removing the operator's ability to void a Draw;
- a shop pilot in Mumbai.

**Friction notes:**
- **Wallet tooling (zingolib):**
  - v5 can't parse NU7 testnet transactions.
  - v6+ need the Nym mixnet to go online, so the server build uses `nakednet-test-mode`.
  - Stock zingo-cli doesn't say which diversified address a note arrived on, so we patched it.
- **Ironwood:** testnet payments to orchard receivers land in the ironwood pool, which we only found by inspecting notes.
- **Build:** the rust-lang and crates.io CDNs ran at about 24 KB/s at the venue; we built through the USTC mirror.
- **Nym:** the mixnet covers broadcasts only. Sync is still direct (ZIP-318).

## Agentic Commerce track fields

**Lane:** 1 (rails and guardrails), 2 (close the loop: the agent decrypts the code itself) and 5 (private by default with Zcash).

**Bitrefill touchpoints:**
- **What we use:** the Bitrefill REST API v2.
  - `GET /products/search` lets the agent (`lucky_search`) and the storefront find any in-stock Indian gift card.
  - `GET /products/{id}` prices what's being quoted.
  - `POST /invoices` with `payment_method: "balance"` and `auto_pay: true` buys.
  - `GET /invoices/{id}` is polled until the order is `delivered`, and the code is read from `redemption_info`.
  - `GET /accounts/balance` is shown on the reserve page.
- **What we reused:** all fulfilment (search, buy, pay, deliver).
- **What we built:**
  - the purchase state machine around it, which never re-buys after a timeout and refunds only on a definite rejection;
  - the shielded-ZEC payment and memo-delivery layer;
  - the agent wallet with spending caps.
- **Bridging the currency gap:** Bitrefill doesn't accept ZEC, so the house pays from its Bitrefill balance and the buyer, or the agent, pays the house in shielded ZEC.

**Invoice IDs of real purchases made by the project:**
- `07fa9491-58e7-44f8-9c3d-f2efa0b6135c` (Classic, delivered)
- `dfb27f52-50fc-4182-8f53-7cd8b42a3b1f` (Moonshot, delivered)
- `c40f094b-05c3-4118-b465-8150b18ee505` (Standard, delivered)

These are Bitrefill test products; see the note below.

**Agent-initiated purchase that delivered (MCP `lucky_buy`), on real testnet:** Bitrefill invoice **`49d03e20-4ce4-4db8-bddc-3fa1e3b8f9af`**.
1. Claude's agent paid 0.011 TAZ from its own shielded wallet, broadcast over the Nym mixnet: [`c20d7971…`](https://testnet.zcashexplorer.app/transactions/c20d79716b7e9e247b2dacf73edc63388ded9ce43cd5dde16025cecec6bfe73a).
2. The Draw landed on 100% of R.
3. Bitrefill delivered the card.
4. The till sent the Refund and the code in an encrypted memo: [`121d1522…`](https://testnet.zcashexplorer.app/transactions/121d15222ad65f4b2bcf44ce9e795d159c455a874f63fa829418bd677faf8704).
5. The agent decrypted the memo with its own wallet and returned the code in chat.

The whole run took 105 s, and verify passes all four checks.

**Earlier agent run, before we had a second key:** 
- **Payment:** Claude's agent paid 0.011 TAZ from its own shielded wallet, broadcast over the Nym mixnet: txid [`3e57d821…`](https://testnet.zcashexplorer.app/transactions/3e57d821e572d7a4000b0186e4c0fd6c39d1ab21532c7ec441b87d39619ad8f9).
- **Purchase:** the server drew and bought through Bitrefill (invoice `53924980-dae9-44d6-b098-2d634b8dc7b2`).
- **Outcome:** Bitrefill rejected the invoice because of the account's daily cap, so the agent wallet got its full payment back ([`41344adb…`](https://testnet.zcashexplorer.app/transactions/41344adb49f9315a8c0710da304c62fba4f58e122b6d9d847ad1565fea807dcc)).
- **Guardrail:** in the same session, a 0.0375 TAZ Moonshot over the 0.03 cap was refused and an approval link was returned.

**Bitrefill quota guard:** the house spreads purchases over several Bitrefill accounts (`BITREFILL_API_KEYS`).
- Each key is used only while its invoices in the last 24 h, counted from Bitrefill's own invoice list, stay under 12 (the cap is 15), so no account ever hits its cap.
- When every key is at its limit, quotes still work, but purchases are refused before any invoice is created and the buyer is refunded in full.

**Guardrails:**
- **Per purchase:** at most 0.03 TAZ (`AGENT_MAX_ZEC_PER_PURCHASE`).
- **Per 24 h:** at most 0.1 TAZ (`AGENT_MAX_ZEC_PER_DAY`), kept in a persistent ledger.
- **Per request:** an optional `maxZec` budget.
- **Hard ceiling:** whatever is in the agent wallet.
- **Above the caps:** the agent pays nothing and returns a ZIP-321 link. The human approves by paying it from their own wallet.

**FEEDBACK.md:** [FEEDBACK.md](FEEDBACK.md).

**Privacy threat model:** the Privacy track note in the README.

**Note on the Bitrefill daily cap:** our account reached Bitrefill's limit of 15 gift cards a day during testing, and after that every invoice ended `permanent_failure`. Our system refunded each buyer in full, which is correct behaviour. Purchases made after the cap reset or on a fresh account are listed above as they happen.

## Demo script (3 minutes; judges watch only the first 3)

1. **(0:00) Pitch.** One sentence, then the storefront: TESTNET banner, a Voucher, Buy vs Lucky Buy, the three tiers with their odds bars.
2. **(0:20) Human flow.**
   - Quote a Moonshot, then show the QR code, the exact amount and "seed committed before you pay".
   - Pay from a testnet wallet; the page shows "seen in mempool", then the reveal needle lands.
   - Show the buyer wallet's memo with the Refund and code. **Mask the code on screen.**
3. **(1:10) Verify.** Every check recomputes in the browser, including "matches the signed copy your browser saved".
4. **(1:30) Agent flow in Claude.**
   - "Buy me a $10 gift card, Lucky Buy Classic." Claude calls `lucky_buy`, pays from its own wallet over the Nym mixnet, and returns the code from the decrypted memo.
   - Then: "Buy the $30 Moonshot." It's refused as over the cap, and Claude hands over an approval link.
5. **(2:30) Proof of reserves and the trust note.** `/api/reserve` shows the UFVK and the Kelly limits. Close on the trust note: what's private, what's revealed, what you trust.
