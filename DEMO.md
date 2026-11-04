# Recording the demo (3 minutes, testnet)

Everything below is real: Zcash testnet (NU7) payments, the Draw, Bitrefill test gift cards that really deliver, and memos decrypted by real wallets. Nothing is simulated.

## Before you hit record (5 minutes)

1. **Site:** open https://luckybuy.hrsh.dev and hard-refresh it (Cmd+Shift+R).
2. **Health check:** `curl -s https://luckybuy.hrsh.dev/api/reserve`.
   - Every `bitrefillKeys` entry should show `last24h` below `limit`.
   - `admissionLimitUsdCents.moonshot` should be above 1000.
3. **Terminal A** (customer wallet), in this folder:
   - `npm run -s buyer-address` prints an address to paste into the site.
   - Keep `npm run pay -- "` typed and ready, so you only paste the link.
4. **Terminal B** (agent): run `claude` in this folder. Approve the `lucky-buy` MCP server the first time, then ask "what Lucky Buy tools do you have?" to warm it up.
5. **Funds:** the buyer and agent share one wallet with about 0.08 TAZ, enough for 4–5 purchases. The agent may spend 0.1 TAZ per 24 h and has about 0.06 left today.
6. **Codes:** test-card codes are dummies, but mask them anyway. `npm run pay` masks codes by default; Claude's reply shows the code, so blur it in the edit.

A full purchase takes 60–110 s while blocks confirm (about 25 s each). Record it straight, then speed up or cut the waits in the edit.

## Shot list

| Time | Show | Say (roughly) |
|---|---|---|
| 0:00 | The marquee sign | "Lucky Buy: gift cards for shielded Zcash. You always get the card, you might pay half or nothing, and the code arrives in an encrypted memo only your wallet can read. No account, no email." |
| 0:15 | Pick **Test Gift Card Code 10**, then the **Moonshot** machine, and scroll the paytable | "Every wheel averages 105%; bigger wheels just swing harder. The slices are the real odds." |
| 0:30 | Paste the buyer address, then **Get my payment ticket** | "A fresh shielded address for this order. The ticket is signed and locks the wheel before I pay. Here's the seed fingerprint." |
| 0:45 | **Copy payment link**, then in terminal A run `npm run pay -- "<link>"` | "The customer's wallet pays the exact amount, and the payment is broadcast over the Nym mixnet." |
| 1:00 | Back to the browser: "Payment spotted…", then the wheel spins and lands | Cut the wait. "Where it stops comes from the seed and my transaction id." |
| 1:25 | Terminal A: the decrypted memo with the Refund and code | "Only the buyer's wallet can read this. The code is gone from our server once it's sent." |
| 1:40 | **Check the spin was fair**: all checks green | "My browser recomputes the spin from the revealed seed, against the ticket it saved before paying." |
| 1:55 | Terminal B: "Find a test gift card and buy me the $10 one with Lucky Buy Classic." | "Now an agent does it all: search, pay from its own capped shielded wallet over Nym, and read the code back." Cut the wait. |
| 2:30 | Terminal B: "Now get me the $30 one on Moonshot." | "That's over its cap, so it pays nothing and hands me a link to approve." |
| 2:45 | https://luckybuy.hrsh.dev/api/reserve | "Proof of reserves by viewing key, Kelly-sized limits, and Bitrefill quota headroom. Privacy note and trust model are in the README." |

## Spare takes

- **Refund path:** pick **Test Gift Card Code (Fail) 10**. Bitrefill fails it, and the whole payment comes back with the memo `refund: fulfillment_failed`.
- **Noir Wallet:** with the testnet extension installed and funded, **Connect Noir Wallet** fills the address and **Pay with Noir Wallet** pays in one approval. It's been tested only with a stand-in provider, so try it before relying on it.
- **Underpay:** send less than the ticket asks, and the full amount is refunded with `refund: underpaid`.

## If something goes wrong

- **Site down:** the supervisor restarts it within about 5 s. If not, run `nohup scripts/keepalive.sh > logs/keepalive.log 2>&1 &` in this folder.
- **"Sold out" on a wheel:** the reserve can't cover that wheel's biggest Refund for that card. Pick a cheaper card or another wheel.
- **Bitrefill keys at their limit:** append another key to `BITREFILL_API_KEYS` in `.env`, then run `pkill -f src/server.ts`. The supervisor restarts it with the new key.
