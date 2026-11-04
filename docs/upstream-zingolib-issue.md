# Draft issue for zingolabs/zingolib (not filed yet)

> **Before filing:** zingolib's [AI_POLICY.md](https://github.com/zingolabs/zingolib/blob/dev/AI_POLICY.md) requires that you disclose AI use, review and edit the text yourself, and fully understand the change. Open an **issue first** (they close PRs that have no linked issue), and offer the patch only once a maintainer responds. The patch is in [`patches/zingo-cli-v8-note-recipients.patch`](../patches/zingo-cli-v8-note-recipients.patch).

---

**Title:** zingo-cli: expose the receiving address of each note so merchants can match payments to orders

**What we're trying to do**

We built a shielded checkout on zingo-cli (Free Society Hackathon, Mumbai). Each order gets a fresh diversified address from `new_address o`, and a payment has to be matched to its order. Many payer wallets don't carry a memo reliably, so matching by memo isn't enough. Matching by **receiving address** is the robust way to do it.

**The gap**

`notes` (and `value_transfers`) don't say which of the wallet's diversified addresses a received note was sent to. The decrypted note already holds its recipient (`orchard::Note::recipient()`); the CLI just never prints it.

**What we did locally (v8.0.0, about 25 lines in `zingo-cli/src/commands.rs`)**

- `notes` now also prints `orchard_recipients`: for each Orchard and Ironwood note, its `txid`, `output_index`, and the recipient encoded as an orchard-only unified address. That's the same string `new_address o` returned, so it can be compared directly.
- Ironwood is included because, on NU7 testnet, payments to orchard receivers land in the Ironwood pool.
- We've used it on testnet all day, matching about 15 real payments to their orders.

**Questions for maintainers**

1. Is there an existing or preferred way to get this, such as an address index on note summaries?
2. If not, would you take a PR? Options:
   - a `recipient` (or `address_index`) field on `NoteSummary`;
   - a separate command;
   - a flag on `notes`.
3. Sapling notes: should we also report the Sapling recipient, encoded the same way?

**AI disclosure:** written with Claude Code (Anthropic), reviewed and edited by <your name>.
