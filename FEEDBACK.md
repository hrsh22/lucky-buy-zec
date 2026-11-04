# Feedback for Bitrefill

Notes from building Lucky Buy on the Bitrefill REST API v2 on 4 Nov 2026, ordered by how much time each one cost us.

## 1. The daily cap fails silently, and looks like an outage

- **What happened:** after about 15 purchases on one account (all free test products), every new invoice for `test-gift-card-code` came back in this state:
  ```json
  { "status": "all_error", "payment": { "status": "complete" }, "orders": [{ "status": "permanent_failure" }] }
  ```
- **What was missing:** no error code, no message, and `payment.status` still said `complete`.
- **What it cost us:** we spent a long time suspecting our own code: package ids, auth, balance. Then we read in the event's resource page that accounts are capped at 15 gift cards a day. It looks like test products count towards that cap too.
- **What would have helped:**
  - **A 429 or 4xx at `POST /invoices`** with `error_code: "daily_limit_reached"` and when it resets, instead of an invoice that fails later.
  - **A failure reason** on `orders[].status = permanent_failure`, such as `reason: "daily_cap"`.
  - **Docs:** say whether test products count towards caps, and expose the remaining quota, for example `GET /accounts/limits`.

## 2. No idempotency on `POST /invoices`

- **What happened:** an agent that times out after `POST /invoices` can't tell whether the invoice exists. Extra fields like `reference` or `client_id` are silently dropped, so there's nothing to look it up by.
- **Why it matters:** with `auto_pay: true`, retrying can buy twice. Refunding the customer can also mean paying for a Voucher that was in fact delivered. We ended up parking every ambiguous case for a human.
- **What would help:** an `Idempotency-Key` header, or a client `reference` that the API echoes back and lets you filter `GET /invoices` by. That would make agent purchasing safe to retry. It's the single biggest gap for agentic commerce.

## 3. Statuses that aren't in the docs

Invoices returned `not_delivered`, `all_delivered` and `all_error`, which the docs don't list. We had to find the complete set of terminal states by trial and error. A table of every invoice and order status, marking which are final and which mean "money moved", would help.

## 4. Amounts in BTC with no fiat figure

- **What happened:** our account's balance and `payment.price` came back in satoshis.
- **What we had to do:** to show a USD balance we read `range.price_rate` from a USD product and divided.
- **What would help:** a `usd` (or account-currency) figure next to every amount, because agents budget in fiat.

## 5. The redemption payload changes shape by product

- **What happened:** code products put the code in `redemption_info.code`. The test link product put it in `redemption_info.extra_fields.code`, with the URL in `redemption_info.link`.
- **What would help:** a normalised `{ code, pin, link, instructions }` on every delivered order, so agents can deliver without a parser for each product.

## 6. Smaller things

- **Package ids:** the `<product><&><value>` form (`test-gift-card-code<&>10`) isn't obvious from the product listing. A worked `POST /invoices` example with `package_id` would save a guess.
- **502s:** `GET /products/{id}` returned the odd HTTP 502, which blanked our catalog until we cached the last good answer. A `Retry-After` header, or a note on expected availability, would help clients behave well.
- **Test products are hidden:** test products don't appear until they're enabled on an account. That wasn't clear at first, and we couldn't tell whether `include_test_products=true` was being ignored.
- **What worked well:**
  - `auto_pay: true` on a balance invoice is perfect for a backend.
  - Delivery was instant on test products.
  - Bearer auth with a personal API key is very easy to start with.
