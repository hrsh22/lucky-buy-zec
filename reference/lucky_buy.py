"""Independent stdlib-only reference for the Lucky Buy draw (README "The game", PLAN D2)."""
import hashlib, math, re

# tier -> [(finalBps, probBps)] ascending by finalBps
TIERS = {
    "standard": [(10000, 10000)],
    "safe": [(8000, 50), (9000, 200), (9500, 600), (10000, 2150), (10800, 7000)],
    "classic": [(5000, 100), (6000, 100), (7000, 100), (8000, 100), (9000, 200),
                (9500, 300), (10000, 1300), (10500, 2100), (11000, 5700)],
    "moonshot": [(0, 25), (2500, 25), (5000, 100), (7500, 200), (9000, 400),
                 (10000, 6515), (12500, 2735)],
}
MAX_BPS = {"standard": 10000, "safe": 10800, "classic": 11000, "moonshot": 12500}
DOMAIN = b"LUCKY_BUY_V1"
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TXID_RE = re.compile(r"[0-9a-f]{64}")

for _name, _t in TIERS.items():
    _f = [f for f, _ in _t]
    assert sum(p for _, p in _t) == 10000, _name
    if _name != "standard":  # standard is a plain purchase at 100%, not a 105% tier
        assert sum(f * p for f, p in _t) == 10500 * 10000, _name
    assert MAX_BPS[_name] == max(_f), _name
    assert min(_f) >= 0 and _f == sorted(_f), _name


def commit(seed: bytes) -> str:
    assert len(seed) == 32
    return hashlib.sha256(seed).hexdigest()


def roll(seed: bytes, quote_id: str, payment_txid: str) -> int:
    assert len(seed) == 32, "seed must be 32 bytes"
    assert UUID_RE.fullmatch(quote_id), "quoteId must be a lowercase 36-char UUID"
    assert TXID_RE.fullmatch(payment_txid), "paymentTxid must be 64 lowercase hex"
    h = hashlib.sha256(seed + quote_id.encode() + payment_txid.encode() + DOMAIN).digest()
    return int.from_bytes(h[:8], "big") % 10000


def outcome(tier: str, r: int) -> int:
    """finalBps of the first bucket whose cumulative probBps exceeds the roll."""
    if tier == "standard":
        r = 0
    assert 0 <= r < 10000
    cum = 0
    for f, p in TIERS[tier]:
        cum += p
        if cum > r:
            return f
    raise AssertionError("unreachable: probabilities sum to 10000")


def kelly(tier: str) -> float:
    """Full Kelly R/B by grid search; first maximum wins."""
    t = TIERS[tier]
    worst = (10000 - min(f for f, _ in t)) / 10000
    best_x, best_g = 0.0, -math.inf
    for i in range(1, 10000):
        x = i / 1e4 / worst
        g = sum((p / 1e4) * math.log(1 + x * (f / 1e4 - 1)) for f, p in t)
        if g > best_g:
            best_x, best_g = x, g
    return best_x
