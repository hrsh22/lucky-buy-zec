"""Print Lucky Buy test vectors JSON to stdout. Draw inputs are fixed (from test/vectors.json)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lucky_buy import TIERS, commit, roll, outcome, kelly

TIERS_OUT = ("safe", "classic", "moonshot")
INPUTS = [  # (serverSeed, quoteId, paymentTxid)
    ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "00000000-0000-4000-8000-000000000000", "0" * 64),
    ("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "00000000-0000-4000-8000-000000000000", "f" * 64),
    ("db9fbddbd7caeff7a326645c1bb47116eb3fd4ae3834bf5039fc5d47386786f5", "6f9619ff-8b86-4011-b42d-00c04fc964ff", "a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"),
    ("ab" * 32, "123e4567-e89b-42d3-a456-426614174000", "0123456789abcdef" * 4),
    ("8efd6168a055d1e45863c237eb3feab2be94f10b7ccdc5bf8bb54305c8b19f7f", "3fc733aa-a85c-4171-8bb4-319765d14389", "91f0e7159da2067f58409cc8129457d810bf124dfaa3646a4551c1ca6048362a"),
    ("0eb026731d9ea3f870511f8c18daeb814eaa2c9e276082b204f2a962212fb5bd", "8a3e90ba-8a51-4e1e-8e3d-a22b26bf3d8d", "045ef594d81d2f2134d61151ed71260d8f79e657c7cb6ed1d893688532017409"),
    ("532b20b0105c9883348558ed2711c7d23ea6b4ee718364a87e16fad4b3c3a029", "550c8741-449c-43a7-8a7b-9016aea1fc99", "0ab25f3049004ce5969100672c92a2768481db2abf7e0267a3b0828a639d5f75"),
    ("06a8db106a32a00f305948a18f7c301fe27f780eb07fa61b5e664d51c1011718", "1f16f2ae-3c69-4e20-8d36-d073c1e7220c", "eea1ad3fbf2142ede510d0220518d902a5ba9b502851530d7fc1454f5147206c"),
    ("20e98ed255fc5b1683eecfde5e917384d22f99efe335ce172d2032394cfc35ba", "0e2a0c66-c71a-4892-898f-1a4488bfa60c", "54cc301a70fd9f3b497965ba192cda510ea6f789d9cbfd25b83864e5deef5c15"),
    ("55b263f8978e1a4af98db8495710c2cac343440cb6e75071ddf45b99cfbebd25", "6d9f5d47-c795-4bc2-8e51-d08de1b1053a", "9b66130d2c7c05ee662b24fdca0a32bfda1a0cb1102fb3e53168eb61b378fc6d"),
    ("4b60c1df8b47a0c6a8ff1d7b342c9d79fb736253cb65d527616dbdc63041ce23", "3ffcd814-91ca-42b6-861b-7b27a58071f5", "54b32b2543de9611ccae06cd2fbf1a7f8d5297ad931ffd18b25dd11f8cec9852"),
    ("5c70e30634e3828249c12b6765b9a7f787b43d21db6a1f3da93ab9c704625dc0", "39e9b0c3-cc17-4040-86bb-29292ae6aba4", "05320dd888b1da6f0de8cbf6e50cf39572ef9678ffca974b5372c3dcbe5b6716"),
    ("d7620a781db6bfbd52efd993d2a8e08d3697dadfe0b7f34a7f03c2ea8e6b0fa1", "a68a86b3-d675-491a-886d-d4ff9b87ec4b", "33a823447396bf2531d530f9478174194bdd0ace46d417cccefed7fc798b7bcd"),
    ("cc630d62db791bb769f950e3b3d5d855d17d5fe1038c14a9ecd4317ae7aa2d03", "2645697a-8c4b-4fd0-8fd9-16f26f1b3807", "1684297ae612416c19f3e86ebc48de53cb016a6eacfa8f2400bf108a4dd71a3e"),
    ("9b67ba79df4d0f0851f30ce6c7bc02af744daab31a7822939042f5e96c485b53", "e476f620-58b3-4bb1-8b70-9162c500074e", "580cdc2653fc59876961bb39292d5a80e3c470a8eebddb340e8a487ccbc3daeb"),
    ("0bb1b42fc1b5b7bdf6bc8662dfa3377e5fa2c89e68843bcd8db1032c65599d1f", "13d0580f-dec2-41b8-83ee-1dbc8582275b", "fab2f5a389ed60fd654935fcd8fa098ce3815ba66f48c9e6b74335eb0c758eba"),
]


def draw(seed_hex, quote_id, txid):
    seed = bytes.fromhex(seed_hex)
    r = roll(seed, quote_id, txid)
    return {"serverSeed": seed_hex, "commit": commit(seed), "quoteId": quote_id,
            "paymentTxid": txid, "roll": r, "finalBps": {t: outcome(t, r) for t in TIERS_OUT}}


print(json.dumps({
    "tables": {t: [list(o) for o in TIERS[t]] for t in TIERS_OUT},
    "kelly": {t: kelly(t) for t in TIERS_OUT},
    "draws": [draw(*i) for i in INPUTS],
}, indent=2))
