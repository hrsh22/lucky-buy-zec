import { BPS, LUCKY_TIERS, TIERS, formatZec, outcomeForRoll, pct, unitFor, usd } from "./fair.js";

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

// ---------------------------------------------------------------- the wheel and the marquee bulbs

const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const kind = (bps) => (bps < BPS ? "below" : bps === BPS ? "at" : "above");
/** Slice colour: deeper discounts glow brighter pink; paying R is violet; paying more is dark velvet. */
function sliceFill(o, i) {
  if (o.finalBps < BPS) return `hsl(${335 - (1 - o.finalBps / BPS) * 12} 100% ${48 + (1 - o.finalBps / BPS) * 14}%)`;
  if (o.finalBps === BPS) return "#6a4fa0";
  return i % 2 ? "#3a2366" : "#2c1850";
}

/**
 * A wheel whose slices are exactly the outcome probabilities, laid clockwise from 12 o'clock in the
 * Draw's bucket order. A roll r sits at angle (r + 0.5) / 10000 × 360°, so the spin shows the real Draw.
 */
function wheelSvg(table, { labels = true } = {}) {
  const svg = svgEl("svg", { viewBox: "-100 -100 200 200", class: "wheel", role: "img", "aria-label": "Wheel of Final Prices" });
  const g = svgEl("g", {});
  svg.append(g);
  let start = 0;
  table.forEach((o, i) => {
    const span = (o.probBps / BPS) * 360;
    const a0 = ((start - 90) * Math.PI) / 180;
    const a1 = ((start + span - 90) * Math.PI) / 180;
    const R = 96;
    const piece = span >= 359.99
      ? svgEl("circle", { r: R, cx: 0, cy: 0 })
      : svgEl("path", {
          d: `M0 0 L${R * Math.cos(a0)} ${R * Math.sin(a0)} A${R} ${R} 0 ${span > 180 ? 1 : 0} 1 ${R * Math.cos(a1)} ${R * Math.sin(a1)} Z`,
        });
    piece.setAttribute("fill", sliceFill(o, i));
    piece.setAttribute("stroke", "#12061f");
    piece.setAttribute("stroke-width", "1.2");
    piece.dataset.i = i;
    const t = svgEl("title", {});
    t.textContent = `${o.finalBps === 0 ? "Free" : pct(o.finalBps)} with a ${pct(o.probBps)} chance`;
    piece.append(t);
    g.append(piece);
    if (labels && span >= 14) {
      const mid = start + span / 2;
      const text = svgEl("text", { x: 0, y: -64, "text-anchor": "middle", "dominant-baseline": "middle", "font-size": span >= 40 ? 15 : 11, transform: `rotate(${mid})` });
      text.textContent = o.finalBps === 0 ? "FREE" : pct(o.finalBps);
      g.append(text);
    }
    start += span;
  });
  return svg;
}

/** Marquee bulbs along a rectangle (the sign) or a circle (the wheel), positioned in % so they scale. */
function bulbs(box, n, shape) {
  box.replaceChildren();
  for (let i = 0; i < n; i++) {
    const b = el("span", "bulb");
    b.style.setProperty("--i", i);
    if (shape === "circle") {
      const a = (i / n) * 2 * Math.PI;
      b.style.left = `${50 + 48.5 * Math.sin(a)}%`;
      b.style.top = `${50 - 48.5 * Math.cos(a)}%`;
    } else {
      // walk the perimeter by real length so the long edges get more bulbs
      const { width: w, height: h } = box.getBoundingClientRect();
      let d = (i / n) * 2 * (w + h);
      const [x, y] = d < w ? [d, 0] : (d -= w) < h ? [w, d] : (d -= h) < w ? [w - d, h] : [0, h - (d - w)];
      b.style.left = `${(x / w) * 100}%`;
      b.style.top = `${(y / h) * 100}%`;
    }
    box.append(b);
  }
}

let wheel = null; // { wrap, svg, hub, lights }
function showWheel(q) {
  const wrap = $("#wheel");
  const lights = el("span", "bulbs chase");
  lights.setAttribute("aria-hidden", "true");
  bulbs(lights, 28, "circle");
  const svg = wheelSvg(q.table);
  const hub = el("div", "hub", q.tier === "standard" ? "Full price" : "Spin");
  wrap.replaceChildren(el("div", "rim"), lights, svg, el("div", "pointer"), hub);
  wheel = { wrap, svg, hub, lights };
}

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
    const lab = el("label", "card-ticket");
    const input = Object.assign(el("input"), { type: "radio", name: "product", value: p.id, checked: p.id === s.productId });
    input.onchange = () => { s.productId = p.id; s.blocked.clear(); renderTiers(); };
    const body = el("span");
    body.append(el("strong", null, p.name), el("span", "face", `${p.faceValue.amount} ${p.faceValue.currency}`),
      el("span", "muted", `${usd(p.referenceUsdCents)}${rate() ? `, ${amount(zatFor(p.referenceUsdCents, BPS))}` : ""}`));
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
      const lab = el("label", `machine${blocked ? " off" : ""}`);
      const input = Object.assign(el("input"), { type: "radio", name: "tier", value: id, checked: id === s.tier, disabled: blocked });
      input.onchange = () => { s.tier = id; renderDetail(); };
      const body = el("span");
      const low = t.outcomes[0].finalBps;
      body.append(wheelSvg(t.outcomes, { labels: false }), el("strong", null, t.name), el("span", "stake", `Pay ${pct(t.maxBps)} now`),
        el("span", "range", blocked ? "Sold out for this card right now" : `You end up paying ${low === 0 ? "nothing" : pct(low)} to ${pct(t.maxBps)}`));
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
    box.append(el("p", "plain", `Pay the card's price, ${usd(R)}${rate() ? ` (${amount(zatFor(R, BPS))})` : ""}. No spin. Your code arrives in an encrypted memo.`));
    return;
  }
  const t = TIERS[s.tier];
  const ev = t.outcomes.reduce((a, o) => a + o.finalBps * o.probBps, 0) / BPS;
  box.append(el("p", "plain", `${t.name}: pay ${pct(t.maxBps)} (${usd(Math.ceil((R * t.maxBps) / BPS))}) now. The wheel picks your final price and refunds the difference. Every wheel averages ${pct(ev)}; bigger wheels just swing harder.`));
  const table = el("table", "paytable");
  table.innerHTML = `<thead><tr><th>You pay</th><th>${unit() || "ZEC"}</th><th>USD</th><th>Chance</th></tr></thead>`;
  const tb = el("tbody");
  for (const o of t.outcomes) {
    const tr = el("tr", `${kind(o.finalBps)}${o === t.outcomes[0] && o.finalBps < BPS ? " jackpot" : ""}`);
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
  if (!s.productId) return (err.textContent = "Pick a gift card first.");
  if (!returnAddress) return (err.textContent = "Enter your shielded Zcash address so the Refund and code have somewhere to go.");
  store.set("luckybuy.addr", returnAddress);
  const tier = s.mode === "buy" ? "standard" : s.tier;
  $("#quoteBtn").disabled = true;
  try {
    const r = await fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: s.productId, tier, returnAddress }) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 409 && body.error === "tier_unavailable") {
      for (const id of LUCKY_TIERS) if (!body.availableTiers.includes(id)) s.blocked.add(id);
      renderTiers();
      err.textContent = `${TIERS[tier].name} is sold out for this card right now: the house can't cover its biggest Refund. Pick another wheel, or pay full price.`;
      return;
    }
    if (!r.ok) {
      err.textContent = r.status === 400 ? `That address doesn't look right. Paste a shielded address that starts with ${s.network === "mainnet" ? "u1" : "utest1"}.` : r.status === 429 ? "Too many tickets from your connection. Try again in a few minutes." : body.error === "unknown_product" ? "That gift card is no longer listed." : `Couldn't create a ticket: ${body.error ?? r.status}.`;
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
  if (!wheel) showWheel(q);
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
    ? `Send exactly this for ${q.productName} (${usd(q.referenceUsdCents)}).`
    : `Send exactly this: ${pct(q.maxBps)} of ${usd(q.referenceUsdCents)} for ${q.productName} on the ${t.name} wheel. Whatever the wheel takes off comes back to you.`;
  $("#commit").textContent = `Seed fingerprint (SHA-256): ${q.commit}`;
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
    $("#payErr").textContent = "Simulated payment is off: this server watches a real wallet. Pay with the QR code or link.";
  } else if (r?.ok) {
    render(await r.json());
  } else {
    btn.disabled = false;
    $("#payErr").textContent = r?.status === 409 ? "This quote is no longer waiting for payment." : "Simulated payment failed.";
  }
}

// ---------------------------------------------------------------- step 3: status + reveal

const FLOW = ["Waiting for payment", "Paid", "Spun", "Buying your card", "Code sent"];
const RANK = { QUOTED: 0, PAID: 1, DRAWN: 2, FULFILL_PENDING: 3, FULFILLED: 3, DELIVER_PENDING: 4, DELIVERED: 5 };
const OFF_PATH = {
  EXPIRED: ["Expired", "No payment arrived before the quote expired. Get a new quote to try again."],
  REFUNDING: ["Refunding", ""],
  REFUND_PENDING: ["Refunding", ""],
  REFUNDED: ["Refunded", ""],
  NEEDS_ATTENTION: ["Needs attention", "Something went wrong while sending. Nothing is resent automatically, and the operator has been flagged. Keep this page's link."],
};
const REASON = {
  underpaid: "The payment was less than the exact amount, so all of it is going back to your return address.",
  overpaid: "The payment was more than the exact amount, so all of it is going back to your return address.",
  late: "The payment arrived after the quote expired, so all of it is going back to your return address.",
  fulfillment_failed: "The gift card couldn't be bought, so your full payment is going back to your address.",
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
      ? "Payment spotted. The wheel spins once it's in a block (usually under a minute)…"
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
    const what = `Your ${formatZec(p.refundZat)} ${u} Refund and gift card code`;
    return sent ? `${what} were sent to your wallet in an encrypted memo.` : `${what} are on the way to your wallet in an encrypted memo.`;
  }
  return sent ? "Your gift card code was sent to your wallet in an encrypted memo." : "Your gift card code is on the way to your wallet in an encrypted memo.";
}

async function reveal(p) {
  const q = p.quote;
  if (!wheel) showWheel(q);
  $("#reveal").hidden = false;
  $("#result").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  $("#verdict").textContent = "Spinning…";
  $("#verdict").className = "verdict";
  $("#verdictNote").textContent = "";
  // land the roll's exact angle under the pointer at 12 o'clock
  const at = ((p.roll + 0.5) / BPS) * 360;
  const end = 360 * 6 - at;
  wheel.svg.style.transform = `rotate(${end}deg)`;
  if (q.tier !== "standard" && !reduceMotion) {
    await wheel.svg.animate([{ transform: "rotate(0deg)" }, { transform: `rotate(${end}deg)` }], { duration: 5200, easing: "cubic-bezier(.1, .6, .1, 1)" }).finished;
  }
  const hit = q.table.indexOf(outcomeForRoll(q.table, p.roll));
  wheel.svg.querySelector(`[data-i="${hit}"]`)?.classList.add("hit");
  wheel.lights.classList.remove("chase");
  wheel.lights.classList.add("flash");
  wheel.hub.textContent = p.finalBps === 0 ? "Free" : pct(p.finalBps);
  const finalZat = q.maxPriceZat - (p.refundZat ?? 0);
  if (p.refundReason) {
    // The card couldn't be bought after the spin: everything goes back, so there's no final price.
    $("#verdict").textContent = "Refunded in full";
    $("#verdict").classList.add("at");
    $("#verdictNote").textContent = deliveryNote(p);
    $("#reveal").append(el("p", "detail-line", `The wheel stopped on ${pct(p.finalBps)} (roll ${p.roll} of 10,000), but nothing is charged.`));
  } else {
    $("#verdict").textContent = p.finalBps === 0 ? "Free! You pay nothing" : `You pay ${pct(p.finalBps)}`;
    $("#verdict").classList.add(kind(p.finalBps));
    $("#verdictNote").textContent = deliveryNote(p);
    $("#reveal").append(el("p", "detail-line", `Final price ${formatZec(finalZat)} ${unitFor(q.network)} (${usd(Math.round((q.referenceUsdCents * p.finalBps) / BPS))}). Roll ${p.roll} of 10,000.`));
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
  // the browser retries dropped streams itself, but gives up for good on some errors: start over then
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(feed, 3000); };
  es.onopen = () => ul.replaceChildren(el("li", "muted", "Waiting for the next spin…")); // the server replays recent spins on each connect
  es.addEventListener("purchase", (ev) => {
    const e = JSON.parse(ev.data);
    if (ul.querySelector(".muted")) ul.replaceChildren();
    const li = el("li", `${kind(e.finalBps)} fresh`);
    li.append(el("strong", null, e.finalBps === 0 ? "Free" : pct(e.finalBps)), `${TIERS[e.tier]?.name ?? e.tier}, ${e.productName}`);
    ul.prepend(li);
    while (ul.children.length > 8) ul.lastChild.remove();
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  bulbs(document.querySelector(".sign .bulbs"), 34, "rect");
  document.querySelector(".sign .bulbs").classList.add("chase");
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
  if (!products.length) $("#catalog").replaceChildren(el("p", "error", "The gift cards didn't load. Reload the page to try again."));
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
