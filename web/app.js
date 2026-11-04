import { BPS, LUCKY_TIERS, TIERS, formatZec, outcomeBar, outcomeForRoll, pct, unitFor, usd } from "./fair.js";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
const TERMINAL = new Set(["EXPIRED", "DELIVERED", "REFUNDED", "NEEDS_ATTENTION"]);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get: (k) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const s = { products: [], reserve: null, network: null, productId: null, mode: "lucky", tier: "classic", blocked: new Set(), revealed: false, timers: [] };
const unit = () => unitFor(s.network);
const product = () => s.products.find((p) => p.id === s.productId);
const rate = () => s.reserve?.rateUsdCentsPerZec;
/** Approximate ZEC for a share of R at the current rate (exact amount comes with the quote). */
const zatFor = (R, bps) => (rate() ? Math.round((R * bps * 1e8) / (BPS * rate())) : null);
const amount = (zat) => (zat == null ? "" : `${formatZec(zat)} ${unit()}`);

function setNetwork(network) {
  s.network = network;
  $("#testnet").hidden = network !== "testnet";
  $("#addr").placeholder = network === "mainnet" ? "u1… or zs1…" : "utest1… or ztestsapling1…";
}

// ---------------------------------------------------------------- step 1: choose

function tierBlocked(id) {
  const p = product();
  const limit = s.reserve?.admissionLimitUsdCents?.[id];
  return s.blocked.has(id) || (p && limit != null && p.referenceUsdCents > limit);
}

function renderCatalog() {
  const box = $("#catalog");
  box.replaceChildren();
  for (const p of s.products) {
    const lab = el("label", "product");
    const input = Object.assign(el("input"), { type: "radio", name: "product", value: p.id, checked: p.id === s.productId });
    input.onchange = () => { s.productId = p.id; s.blocked.clear(); renderTiers(); };
    const body = el("span");
    body.append(el("strong", null, p.name), el("span", "face", `${p.faceValue.amount} ${p.faceValue.currency}`),
      el("span", "muted", `${usd(p.referenceUsdCents)}${rate() ? ` = ${amount(zatFor(p.referenceUsdCents, BPS))}` : ""}`));
    lab.append(input, body);
    box.append(lab);
  }
}

function renderTiers() {
  const box = $("#tiers");
  box.replaceChildren();
  box.hidden = s.mode !== "lucky";
  if (s.mode === "lucky") {
    if (tierBlocked(s.tier)) s.tier = LUCKY_TIERS.find((id) => !tierBlocked(id)) ?? s.tier;
    for (const id of LUCKY_TIERS) {
      const t = TIERS[id];
      const blocked = tierBlocked(id);
      const lab = el("label", `tier${blocked ? " off" : ""}`);
      const input = Object.assign(el("input"), { type: "radio", name: "tier", value: id, checked: id === s.tier, disabled: blocked });
      input.onchange = () => { s.tier = id; renderDetail(); };
      const body = el("span");
      body.append(el("strong", null, t.name), el("span", null, `Pay ${pct(t.maxBps)} up front`),
        el("span", "muted", blocked ? "Not available for this Voucher right now" : `Final Price from ${pct(t.outcomes[0].finalBps)}`),
        outcomeBar(t.outcomes, { labels: false }));
      lab.append(input, body);
      box.append(lab);
    }
  }
  renderDetail();
}

function renderDetail() {
  const box = $("#detail");
  box.replaceChildren();
  const p = product();
  if (!p) return;
  const R = p.referenceUsdCents;
  if (s.mode === "buy") {
    box.append(el("p", "plain", `Pay the Reference Price: ${usd(R)}${rate() ? `, ${amount(zatFor(R, BPS))}` : ""}. Your code arrives in an encrypted memo.`));
    return;
  }
  const t = TIERS[s.tier];
  const ev = t.outcomes.reduce((a, o) => a + o.finalBps * o.probBps, 0) / BPS;
  box.append(el("p", "plain", `${t.name}: pay ${pct(t.maxBps)} of the Reference Price (${usd(Math.ceil((R * t.maxBps) / BPS))}) up front. The Draw picks one row below and refunds the difference. Every tier averages ${pct(ev)}; tiers only change how spread out the Final Price is.`));
  const table = el("table", "odds");
  table.innerHTML = `<thead><tr><th>Final Price</th><th>${unit() || "ZEC"}</th><th>USD</th><th>Chance</th></tr></thead>`;
  const tb = el("tbody");
  for (const o of t.outcomes) {
    const tr = el("tr", o.finalBps < BPS ? "below" : o.finalBps === BPS ? "at" : "above");
    tr.append(el("td", null, o.finalBps === 0 ? "Free" : pct(o.finalBps)), el("td", null, zatFor(R, o.finalBps) == null ? "" : formatZec(zatFor(R, o.finalBps))),
      el("td", null, usd(Math.round((R * o.finalBps) / BPS))), el("td", null, pct(o.probBps)));
    tb.append(tr);
  }
  table.append(tb);
  box.append(table);
}

async function getQuote() {
  const err = $("#quoteErr");
  err.textContent = "";
  const returnAddress = $("#addr").value.trim();
  if (!s.productId) return (err.textContent = "Choose a Voucher first.");
  if (!returnAddress) return (err.textContent = "Enter a shielded return address so the Refund and code have somewhere to go.");
  store.set("luckybuy.addr", returnAddress);
  const tier = s.mode === "buy" ? "standard" : s.tier;
  $("#quoteBtn").disabled = true;
  try {
    const r = await fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: s.productId, tier, returnAddress }) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 409 && body.error === "tier_unavailable") {
      for (const id of LUCKY_TIERS) if (!body.availableTiers.includes(id)) s.blocked.add(id);
      renderTiers();
      err.textContent = `${TIERS[tier].name} isn't available for this Voucher right now: the reserve can't cover its deepest Refund. Pick another tier, or Buy at the Reference Price.`;
      return;
    }
    if (!r.ok) {
      err.textContent = body.error === "invalid_request" ? "That request was rejected. Check the return address." : body.error === "unknown_product" ? "That Voucher is no longer listed." : `Couldn't create a quote: ${body.error ?? r.status}.`;
      return;
    }
    history.replaceState(null, "", `?id=${body.quote.id}`);
    // Keep our own copy of the signed quote: verify.html checks the server's later answer against it.
    store.set(`lb:quote:${body.quote.id}`, JSON.stringify({ quote: body.quote, signature: body.signature, publicKey: body.publicKey }));
    showQuote(body.quote, body.zip321);
    $("#pay").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    poll(body.quote.id);
  } catch (e) {
    err.textContent = `Couldn't reach the server: ${e.message}`;
  } finally {
    $("#quoteBtn").disabled = false;
  }
}

// ---------------------------------------------------------------- step 2: pay

function showQuote(q, zip321) {
  setNetwork(q.network);
  $("#pick").classList.add("locked");
  for (const i of $("#pick").querySelectorAll("input, button")) i.disabled = true;
  $("#pay").hidden = false;
  $("#result").hidden = false;
  zip321 ??= `zcash:${q.payAddress}?amount=${formatZec(q.maxPriceZat)}&message=${encodeURIComponent(`Lucky Buy ${q.id}`)}`;
  const qr = qrcode(0, "M");
  qr.addData(zip321);
  qr.make();
  $("#qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  $("#qr").href = zip321;
  $("#uri").href = zip321;
  $("#uri").textContent = zip321;
  $("#amount").textContent = amount(q.maxPriceZat);
  const t = TIERS[q.tier];
  $("#amountNote").textContent = q.tier === "standard"
    ? `Exactly this amount: ${q.productName} at the Reference Price (${usd(q.referenceUsdCents)}).`
    : `Exactly this amount: the ${t.name} Maximum Price for ${q.productName} (${pct(q.maxBps)} of ${usd(q.referenceUsdCents)}). The Refund comes back to you after the Draw.`;
  $("#commit").textContent = `SHA-256(seed) = ${q.commit}`;
  $("#copyUri").onclick = async () => {
    try { await navigator.clipboard.writeText(zip321); $("#copyUri").textContent = "Copied"; } catch { $("#copyUri").textContent = "Copy failed, select the link"; }
  };
  $("#devPay").onclick = () => devPay(q.id);
  const tick = () => {
    const left = Math.max(0, new Date(q.expiresAt) - Date.now());
    $("#countdown").textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
  };
  tick();
  s.timers.push(setInterval(tick, 1000));
}

async function devPay(id) {
  const btn = $("#devPay");
  btn.disabled = true;
  $("#payErr").textContent = "";
  const r = await fetch(`/api/dev/pay/${id}`, { method: "POST" }).catch(() => null);
  if (r?.status === 404) {
    btn.hidden = true;
    $("#payErr").textContent = "Simulated payment is off: this server watches a real wallet. Pay the link above.";
  } else if (r?.ok) {
    render(await r.json());
  } else {
    btn.disabled = false;
    $("#payErr").textContent = r?.status === 409 ? "This quote is no longer waiting for payment." : "Simulated payment failed.";
  }
}

// ---------------------------------------------------------------- step 3: status + reveal

const FLOW = ["Waiting for payment", "Paid", "Drawn", "Buying Voucher", "Delivered"];
const RANK = { QUOTED: 0, PAID: 1, DRAWN: 2, FULFILL_PENDING: 3, FULFILLED: 3, DELIVER_PENDING: 4, DELIVERED: 5 };
const OFF_PATH = {
  EXPIRED: ["Expired", "No payment arrived before the quote expired. Get a new quote to try again."],
  REFUNDING: ["Refunding", ""],
  REFUND_PENDING: ["Refunding", ""],
  REFUNDED: ["Refunded", ""],
  NEEDS_ATTENTION: ["Needs attention", "Something went wrong while sending. Nothing will be resent automatically; the operator has been flagged. Keep this page's link."],
};
const REASON = {
  underpaid: "The payment was less than the exact amount, so all of it is going back to your return address.",
  overpaid: "The payment was more than the exact amount, so all of it is going back to your return address.",
  late: "The payment arrived after the quote expired, so all of it is going back to your return address.",
  fulfillment_failed: "The Voucher couldn't be bought, so your full payment is going back to your return address.",
};

let lastStatus = null;
function render(p) {
  if (!p?.status) return;
  const off = OFF_PATH[p.status];
  const rank = RANK[p.status] ?? (p.roll != null ? 3 : p.paymentTxid ? 1 : 0);
  const ol = $("#steps");
  ol.replaceChildren();
  FLOW.forEach((label, i) => {
    if (off && i >= rank) return;
    ol.append(el("li", i < rank ? "done" : i === rank ? "now" : "", label));
  });
  if (off) ol.append(el("li", p.status === "REFUNDED" ? "done off" : "now off", off[0]));
  if (p.status !== "QUOTED") $("#pay").classList.add("locked");
  $("#devPay").hidden ||= p.status !== "QUOTED";
  $("#statusNote").textContent = off
    ? off[1] || (p.roll != null ? "" : REASON[p.refundReason]) || "" // after a Draw the reveal shows the reason
    : p.status === "QUOTED" && p.confirmations === 0
      ? "Payment seen in the mempool, waiting for 1 confirmation (about 75 s)…"
      : "";
  if (p.finalBps != null && !s.revealed) {
    s.revealed = true;
    reveal(p);
  } else if (s.revealed && p.status !== lastStatus) {
    $("#verdictNote").textContent = deliveryNote(p);
  }
  lastStatus = p.status;
}

function deliveryNote(p) {
  const u = unitFor(p.quote.network);
  if (p.refundReason) return REASON[p.refundReason];
  const sent = p.status === "DELIVERED";
  if (p.refundZat > 0) {
    const what = `Refund of ${formatZec(p.refundZat)} ${u} + your code`;
    return sent ? `${what} were sent to your return address in an encrypted memo.` : `${what} are on their way in an encrypted memo.`;
  }
  return sent ? "Your code was sent to your return address in an encrypted memo." : "Your code is on its way in an encrypted memo.";
}

async function reveal(p) {
  const q = p.quote;
  const bar = outcomeBar(q.table);
  const needle = el("span", "needle");
  bar.append(needle);
  $("#revealBar").replaceChildren(bar);
  $("#reveal").hidden = false;
  $("#result").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  $("#verdict").textContent = "Drawing…";
  $("#verdictNote").textContent = "";
  const target = `${((p.roll + 0.5) / BPS) * 100}%`;
  needle.style.left = target;
  if (q.tier !== "standard" && !reduceMotion) {
    await needle.animate(
      [
        { left: "0%", easing: "ease-in-out" },
        { left: "100%", offset: 0.3, easing: "ease-in-out" },
        { left: "8%", offset: 0.55, easing: "cubic-bezier(.12,.85,.25,1)" },
        { left: target },
      ],
      { duration: 2800 },
    ).finished;
  }
  const hit = q.table.indexOf(outcomeForRoll(q.table, p.roll));
  bar.children[hit]?.classList.add("hit");
  const finalZat = q.maxPriceZat - (p.refundZat ?? 0);
  if (p.refundReason) {
    // The Voucher couldn't be bought after the Draw: everything goes back, so there is no Final Price to show.
    $("#verdict").textContent = "Refunded in full";
    $("#verdict").classList.add("at");
    $("#verdictNote").textContent = deliveryNote(p);
    $("#reveal").append(el("p", "muted", `The Draw landed on ${pct(p.finalBps)} (roll ${p.roll} of 10,000), but nothing is charged.`));
  } else {
    $("#verdict").textContent = `You paid ${pct(p.finalBps)} of the reference price`;
    $("#verdict").classList.add(p.finalBps < BPS ? "below" : p.finalBps === BPS ? "at" : "above");
    $("#verdictNote").textContent = deliveryNote(p);
    $("#reveal").append(el("p", "muted", `Final Price ${formatZec(finalZat)} ${unitFor(q.network)} (${usd(Math.round((q.referenceUsdCents * p.finalBps) / BPS))}). Roll ${p.roll} of 10,000.`));
  }
  const link = $("#verifyLink");
  link.href = `verify.html?id=${p.id}`;
  link.hidden = false;
}

async function poll(id) {
  try {
    const r = await fetch(`/api/purchase/${id}`);
    if (r.status === 404) return ($("#statusNote").textContent = "No purchase with this id.");
    const p = await r.json();
    render(p);
    if (TERMINAL.has(p.status)) return s.timers.forEach(clearInterval);
  } catch {}
  setTimeout(() => poll(id), 3000);
}

// ---------------------------------------------------------------- feed

function feed() {
  const ul = $("#feed");
  const es = new EventSource("/api/feed");
  es.addEventListener("purchase", (ev) => {
    const e = JSON.parse(ev.data);
    if (ul.querySelector(".muted")) ul.replaceChildren();
    const li = el("li", e.finalBps < BPS ? "below" : e.finalBps === BPS ? "at" : "above");
    li.append(el("strong", null, pct(e.finalBps)), ` ${TIERS[e.tier]?.name ?? e.tier} on ${e.productName}`);
    ul.prepend(li);
    while (ul.children.length > 8) ul.lastChild.remove();
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  $("#addr").value = store.get("luckybuy.addr");
  for (const r of document.querySelectorAll('input[name="mode"]')) r.onchange = () => { s.mode = r.value; renderTiers(); };
  $("#quoteBtn").onclick = getQuote;
  feed();
  const [products, reserve] = await Promise.all([
    fetch("/api/products").then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch("/api/reserve").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  s.products = products;
  s.reserve = reserve;
  if (reserve) setNetwork(reserve.network);
  s.productId = products[0]?.id ?? null;
  if (!products.length) $("#catalog").replaceChildren(el("p", "error", "The Voucher catalog didn't load. Reload the page to try again."));
  else renderCatalog();
  renderTiers();

  const id = new URLSearchParams(location.search).get("id");
  if (id) {
    const r = await fetch(`/api/purchase/${id}`).catch(() => null);
    if (r?.ok) {
      const p = await r.json();
      showQuote(p.quote, p.zip321);
      poll(id);
    }
  }
}
boot();
