"""!build: a player's request -> a proposal (what, where, price, cost) -> !yes builds it.

Models never produce coordinates or game arguments (docs/ride-placement-plan.md). The chat model
only fills a small form (BuildRequest), the decision model only picks from short named lists, and
plain code finds the site, the price and the action arguments. Without models, an exact stall name
or a few keywords still work."""

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field, replace

from .agent import plain_text
from .bridge import BridgeError
from .llm import LLMError

log = logging.getLogger("builder")


@dataclass(frozen=True)
class RideType:
    category: str
    track_type: int
    est_cost: float                  # currency; the dry run gives the exact cost when the park has one already
    prices: dict[str, float] | None  # per price tier; None: the game has no price for it
    size: int = 1                    # footprint, size x size tiles; above 1 it is a flat ride
    about: str = ""                  # for the decision model, which can't tell a merry-go-round from its name alone


TIERS = ("free", "cheap", "standard", "premium")
GENTLE_PRICES = dict(zip(TIERS, (0, 0.5, 1.0, 2.0)))
THRILL_PRICES = dict(zip(TIERS, (0, 1.0, 1.5, 3.0)))
# Construction costs as seen in the game (the ATM and the 3x3 rides other than the merry-go-round and
# twist are guesses on the safe side). The dry run gives the exact cost when the park has one already. Flat rides are the square ones the plugin can
# place (2x2, 3x3, 4x4); ferris wheels, swinging ships and the like are longer than wide.
RIDE_TYPES = {
    28: RideType("food", 262, 300, dict(zip(TIERS, (0, 1.0, 1.5, 2.5)))),
    30: RideType("drink", 262, 250, dict(zip(TIERS, (0, 0.8, 1.2, 2.0)))),
    32: RideType("souvenir", 262, 200, dict(zip(TIERS, (0, 1.0, 2.0, 3.5)))),
    35: RideType("info", 264, 250, dict(zip(TIERS, (0, 0.5, 0.8, 1.5)))),
    36: RideType("toilet", 262, 225, dict(zip(TIERS, (0, 0.1, 0.2, 0.4)))),
    45: RideType("atm", 262, 300, None),
    48: RideType("first_aid", 262, 250, None),
    33: RideType("gentle", 266, 460, GENTLE_PRICES, 3, "a carousel with horses going round, for small children"),
    49: RideType("gentle", 266, 500, GENTLE_PRICES, 3, "a circus show in a tent"),
    47: RideType("gentle", 266, 500, GENTLE_PRICES, 3, "a spooky walk-through haunted house"),
    41: RideType("gentle", 266, 500, GENTLE_PRICES, 3, "rings that spin guests around"),
    21: RideType("gentle", 258, 330, GENTLE_PRICES, 2, "a slide winding down a tower"),
    25: RideType("gentle", 259, 600, GENTLE_PRICES, 4, "bumper cars, dodgems or autoscooters that crash into each other"),
    46: RideType("thrill", 266, 360, THRILL_PRICES, 3, "fast spinning arms with cars, a thrill ride"),
}
CATEGORY_NAMES = {
    "food": "food stall", "drink": "drinks stall", "souvenir": "souvenir stall", "info": "information kiosk",
    "toilet": "toilet", "atm": "ATM", "first_aid": "first aid room", "gentle": "gentle ride", "thrill": "thrill ride",
}
KINDS = ("stall", "flat_ride", "unknown")
CATEGORIES = tuple(CATEGORY_NAMES) + ("any",)
RIDE_CATEGORIES = ("gentle", "thrill")
PRICE_PREFS = TIERS + ("unspecified",)
OPEN_PREFS = ("open", "closed", "unspecified")

# For requests without a working model, and to catch an exact stall name. German too, as the
# advisor answers in the player's language.
CATEGORY_WORDS = {
    "food": r"burger|hot ?dog|food|snack|pizza|fries|chips|sandwich|candy|cookie|ice ?cream|nugget|hungry|essen|imbiss|hunger",
    "drink": r"drink|coffee|lemonade|soda|thirst|getränk|kaffee|limo|durst",
    "souvenir": r"souvenir|balloon|ballon|\bhat\b|t-?shirt|shirt|\bhut\b|andenken",
    "info": r"\binfo|kiosk|\bmaps?\b|umbrella|karte|schirm",
    "toilet": r"toilet|restroom|bathroom|\bwc\b|\bloo\b|klo|toilette",
    "atm": r"\batm\b|cash machine|geldautomat|bankomat",
    "first_aid": r"first ?aid|erste ?hilfe|sanitäter",
}
FLAT_RIDE_WORDS = r"carousel|merry|ferris|twist|swing|ship|bumper|dodgem|slide|circus|ride\b|karussell|riesenrad|rutsche|fahrgeschäft"
THRILL_WORDS = r"thrill|wild|intense|scary|spannend|wilde?s?"
PRICE_WORDS = [("free", r"\bfree\b|gratis|kostenlos|umsonst"), ("cheap", r"cheap|low.?price|günstig|billig"),
               ("premium", r"expensive|premium|pricey|high.?price|teuer")]
CLOSED_WORDS = r"\bclosed\b|keep it closed|geschlossen|zu lassen"

PARSE_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"enum": list(KINDS)},
        "category": {"enum": list(CATEGORIES)},
        "near": {"type": ["string", "null"]},
        "price_pref": {"enum": list(PRICE_PREFS)},
        "open": {"enum": list(OPEN_PREFS)},
        "language": {"type": "string"},
    },
    "required": ["kind", "category", "near", "price_pref", "open", "language"],
}
PARSE_PROMPT = """\
You turn a RollerCoaster Tycoon 2 player's build request into JSON. Fields:
- kind: "stall" for shops, stalls and facilities (food, drinks, souvenirs, information kiosk, toilets, ATM, \
first aid); "flat_ride" for small rides like a merry-go-round, twist, spiral slide or bumper cars; "unknown" if \
it is not a build request or asks for anything else (roller coasters, paths, scenery, staff).
- category: food, drink, souvenir, info, toilet, atm or first_aid for stalls; thrill or gentle for flat rides; \
any if the player did not say what.
- near: the name of a ride the player wants it next to, copied exactly from the request, or null.
- price_pref: free, cheap, standard or premium if the player asked for a price level, else unspecified.
- open: closed if the player wants it kept closed, open if they asked for it open, else unspecified.
- language: the two-letter code of the request's language, e.g. en or de.
The request can be in any language."""

TRANSLATE_PROMPT = """Translate the game chat message into the language with the code {lang}. Keep every name, number, price and coordinate, and the commands !build, !yes, !no and !undo, exactly as they are. Reply with the translation only, as one line of plain text."""

PRICE_OPTIONS = {
    "free": "Free, no charge",
    "cheap": "Cheap, a low price",
    "standard": "A normal price, or no price wish",
    "premium": "Expensive, a high price",
}

# Placement policies: how to pre-sort sites in the plugin, and a score (higher is better) over the
# site features. Pure functions of the sites, so the same park gives the same pick.
POLICIES = {
    "near_target": ({}, lambda f: -f.get("dist_near", 999)),
    "near_busy": ({"sort": "nearby_guests"},
                  lambda f: f.get("nearby_guests", 0) - 3 * f.get("nearby_stalls", 0) + f.get("path_neighbors", 0)),
    "near_junction": ({"sort": "path_neighbors"},
                      lambda f: 10 * f.get("path_neighbors", 0) + f.get("nearby_guests", 0) - 3 * f.get("nearby_stalls", 0)),
    # Rides: away from the crowded park entrance and from stalls.
    "quiet": ({"sort": "dist_park_entrance", "desc": True},
              lambda f: f.get("dist_park_entrance", 0) - 3 * f.get("nearby_stalls", 0)),
}
POLICY_OPTIONS = {
    "near_busy": "Where many guests walk by",
    "near_junction": "At a path junction where several paths meet",
    "none": "No wish about where it goes",   # without it, a request with no hint still picked one of the two
}
POLICY_TEXT = {"near_busy": "where many guests walk by", "near_junction": "at a path junction",
               "quiet": "in a quieter spot away from the park entrance"}
DEFAULT_POLICY = "near_busy"
RIDE_POLICY = "quiet"

PICK_MIN = 0.15   # probability from which the decision model's pick is used
SITES_LIMIT = 40
DRY_RUN_TRIES = 5
MAX_BUILT = 100   # builds remembered for !undo
HELP_TEXT = "I can build stalls and small rides, e.g. !build a cheap burger bar near the Big Dipper, or !build a merry-go-round."
STATE = "An OpenRCT2 park advisor bot builds what a player asks for in their theme park.\n"


@dataclass
class BuildRequest:
    kind: str
    category: str
    near: str | None = None
    price_pref: str = "unspecified"
    open: str = "unspecified"
    language: str = "en"
    object: str | None = None   # an exact stall name from the request wins over any choice


@dataclass
class Proposal:
    obj: dict             # from get_buildable: object, name, ride_type
    price: float | None
    open: bool
    site: dict            # x, y, z, direction; entrance and exit for rides
    size: int
    cost: float
    cost_exact: bool
    where: str            # for the reply, e.g. "near Big Dipper"
    expires: float


@dataclass
class Built:
    ride_id: int
    name: str
    owner: str            # lower-case player name; ids change when a player reconnects
    at: float = field(default_factory=time.monotonic)


def validate_request(data) -> BuildRequest | None:
    """A BuildRequest from the model's JSON, or None if anything is off."""
    if not isinstance(data, dict):
        return None
    near = data.get("near")
    if (data.get("kind") not in KINDS or data.get("category") not in CATEGORIES or data.get("price_pref") not in PRICE_PREFS
            or data.get("open") not in OPEN_PREFS or not (near is None or isinstance(near, str))):
        return None
    lang = str(data.get("language") or "en").strip().lower()
    kind, category = data["kind"], data["category"]
    # Small models mix the two up now and then; the category is the better hint.
    if category in RIDE_CATEGORIES:
        kind = "flat_ride"
    elif kind == "flat_ride" and category != "any":
        kind = "stall"
    return BuildRequest(kind, category, (near or "").strip() or None, data["price_pref"], data["open"],
                        lang if re.fullmatch(r"[a-z]{2,3}", lang) else "en")


def parse_keywords(text: str) -> BuildRequest:
    q = text.lower()
    category = next((c for c, pat in CATEGORY_WORDS.items() if re.search(pat, q)), None)
    if category:
        kind = "stall"
    elif re.search(FLAT_RIDE_WORDS, q) or re.search(THRILL_WORDS, q):
        kind, category = "flat_ride", "thrill" if re.search(THRILL_WORDS, q) else "any"
    else:
        kind, category = "unknown", "any"
    price = next((t for t, pat in PRICE_WORDS if re.search(pat, q)), "unspecified")
    return BuildRequest(kind, category, None, price, "closed" if re.search(CLOSED_WORDS, q) else "unspecified")


def exact_object(text: str, objects: list[dict], rides: list[dict]) -> dict | None:
    """The longest available stall or ride name in the request, not counting the park's ride names
    ("a drinks stall near Burger Bar 1" is not a burger bar)."""
    q = text.lower()
    for name in sorted((r["name"].lower() for r in rides if r.get("name")), key=len, reverse=True):
        q = q.replace(name, " ")
    hits = [o for o in objects if o["name"].lower() in q]
    return max(hits, key=lambda o: len(o["name"])) if hits else None


def find_ride(near: str | None, text: str, rides: list[dict]) -> dict | None:
    """The ride a request points at: the model's `near` text, else the longest ride name in the request."""
    named = [r for r in rides if r.get("name")]
    if near:
        n = near.lower().removeprefix("the ").strip()
        for match in (lambda r: r["name"].lower() == n, lambda r: n in r["name"].lower(), lambda r: r["name"].lower() in n):
            hits = [r for r in named if match(r)]
            if hits:
                return min(hits, key=lambda r: len(r["name"]))
        return None
    q = text.lower()
    hits = [r for r in named if r["name"].lower() in q]
    return max(hits, key=lambda r: len(r["name"])) if hits else None


def site_tiles(site: dict, size: int) -> set[tuple[int, int]]:
    """The tiles a build would take: its footprint, plus the entrance and exit of a ride."""
    tiles = {(site["x"] + dx, site["y"] + dy) for dx in range(size) for dy in range(size)}
    for end in ("entrance", "exit"):
        if end in site:
            tiles.add((site[end]["x"], site[end]["y"]))
    return tiles


def rank_sites(sites: list[dict], policy: str) -> list[dict]:
    """Best site first by the policy's score; ties by position, so the pick is stable."""
    score = POLICIES[policy][1]
    return sorted(sites, key=lambda s: (-score(s.get("features", {})), s["x"], s["y"]))


def fmt_money(v: float, currency: dict) -> str:
    text = f"{v:,.0f}" if v == int(v) else f"{v:,.2f}"
    return f"{currency.get('prefix', '')}{text}{currency.get('suffix', '')}"


def fmt_price(v: float | None, currency: dict) -> str:
    if v is None:
        return ""
    return "free" if v == 0 else f"price {currency.get('prefix', '')}{v:.2f}{currency.get('suffix', '')}"


class Builder:
    def __init__(self, cfg, router, llm, run_tool, limiter):
        self.cfg = cfg
        self.router = router      # None without models: keyword parsing and default choices
        self.llm = llm
        self.run_tool = run_tool
        self.limiter = limiter    # builds per player per hour
        self.pending: dict[str, Proposal] = {}
        self.built: list[Built] = []
        self.currency: dict = {}
        self.language: dict[str, str] = {}   # per player, from their last !build
        self.dropped: set[str] = set()       # players whose proposal a game restart dropped
        # Builds run one at a time (the plugin refuses a second meanwhile), and choosing a spot and
        # reserving it for a proposal happen together, so two players never get the same spot.
        self.lock = asyncio.Lock()

    def reset(self) -> None:
        """The plugin (re)connected: the game may have restarted with another park, so proposals
        for spots in the old one are dropped. The undo list stays; demolish checks the ride's name."""
        if self.pending:
            log.info("plugin reconnected, dropping %d proposals", len(self.pending))
        self.dropped |= set(self.pending)
        self.pending.clear()

    async def tool(self, name: str, args: dict):
        res = await self.run_tool(name, args)
        if not res.get("ok"):
            raise BridgeError(f"{name}: {res.get('error')}")
        return res["result"]

    async def refusal(self, player: int) -> str | None:
        """Why this player may not build, or None if they may."""
        res = await self.run_tool("get_player_info", {"player": player})
        if not res.get("ok"):
            return "Sorry, I can't tell who you are, so I can't build for you."
        info = res["result"]
        if info.get("is_admin") or (info.get("group") or "").lower() in self.cfg.build_allowed_groups:
            return None
        return "Sorry, only admins can build" + (" (and " + ", ".join(self.cfg.build_allowed_groups) + ")"
                                                 if self.cfg.build_allowed_groups else "") + "."

    def money_refusal(self, cost: float, info: dict) -> str | None:
        if cost > self.cfg.build_max_cost:
            return (f"That costs about {fmt_money(cost, self.currency)}, more than the "
                    f"{fmt_money(self.cfg.build_max_cost, self.currency)} limit for builds.")
        if not info.get("no_money") and cost > info["cash"] - self.cfg.build_cash_reserve:
            return (f"The park can't afford that: it costs about {fmt_money(cost, self.currency)} and the park has "
                    f"{fmt_money(info['cash'], self.currency)}, of which {fmt_money(self.cfg.build_cash_reserve, self.currency)} "
                    f"stays in reserve.")
        return None

    # ------------------------------------------------------------ !build

    async def propose(self, player: int, name: str, text: str) -> str:
        return await self.localize(name, await self._propose(player, name, text))

    async def _propose(self, player: int, name: str, text: str) -> str:
        why = await self.refusal(player)
        if why:
            return why
        # Everything researched, so an exact name of something it can't build gets a clear answer.
        info = await self.tool("get_buildable", {})
        self.currency = info.get("currency") or {}
        everything = info["objects"]
        objects = [o for o in everything if o["ride_type"] in RIDE_TYPES]
        rides = await self.tool("list_rides", {})
        req = await self.parse(text, everything, rides)
        self.language[name.lower()] = req.language
        log.info("build request from %s: %s", name, req)
        if req.kind == "unknown":
            return HELP_TEXT
        unsupported = next((o for o in everything if o["object"] == req.object and o["ride_type"] not in RIDE_TYPES), None)
        if unsupported:
            rides_here = ", ".join(sorted({o["name"] for o in objects if RIDE_TYPES[o["ride_type"]].size > 1})) or "none yet"
            return f"Sorry, I can't build a {unsupported['name']}. I can build stalls and these rides: {rides_here}."

        flat = req.kind == "flat_ride"
        if req.object:
            candidates = [o for o in objects if o["object"] == req.object]
        else:
            candidates = [o for o in objects if (RIDE_TYPES[o["ride_type"]].size > 1) == flat
                          and req.category in ("any", RIDE_TYPES[o["ride_type"]].category)]
        if not candidates:
            have = ", ".join(sorted({o["name"] for o in objects})) or "nothing yet"
            what = CATEGORY_NAMES.get(req.category, "ride" if flat else "stall")
            return f"The park has no {what} researched yet. It can build: {have}."
        obj = await self.choose_object(text, candidates)
        rtype = RIDE_TYPES[obj["ride_type"]]
        price = None
        # Parks that charge for entry keep ride tickets free; stalls always have prices.
        if rtype.prices is not None and (rtype.size == 1 or info.get("ride_prices")):
            tier = await self.choose_tier(text, req.price_pref)
            price = min(rtype.prices[tier], info["max_price"])

        target = find_ride(req.near, text, rides)
        note = ""
        if req.near and not target:
            note = f" I couldn't find a ride called {req.near}, so I picked a good spot instead."
        async with self.lock:
            return await self.place(player, name, text, req, obj, rtype, price, target, note, info)

    async def place(self, player, name, text, req, obj, rtype, price, target, note, info) -> str:
        """Find, dry-run and reserve a spot, and store the proposal."""
        now = time.monotonic()
        for key in [k for k, p in self.pending.items() if p.expires < now or k == name.lower()]:
            del self.pending[key]
        taken = set().union(*(site_tiles(p.site, p.size) for p in self.pending.values()))
        found = None
        size = {"width": rtype.size, "height": rtype.size}
        if target:
            found = await self.tool("find_sites", {"limit": SITES_LIMIT, "near_ride": target["id"], **size})
            if found["near"] is None:   # e.g. a ride whose track was removed
                note = f" I don't know where {target['name']} is, so I picked a good spot instead."
                target = found = None
        policy = "near_target" if target else RIDE_POLICY if rtype.size > 1 else await self.choose_policy(text)
        if found is None:
            found = await self.tool("find_sites", {"limit": SITES_LIMIT, **size, **POLICIES[policy][0]})
        sites = [s for s in rank_sites(found["sites"], policy) if not site_tiles(s, rtype.size) & taken]
        log.info("build: %s, price %s, policy %s, %d sites", obj["object"], price, policy, len(sites))
        if not sites:
            if rtype.size > 1:
                return (f"I found no free, flat {rtype.size}x{rtype.size} spot with a row for the entrance and exit "
                        f"next to a path. Clear some space or buy land first.")
            return "I found no free, flat spot next to a path that the park owns. Clear some space or buy land first."

        error = None
        for site in sites[:DRY_RUN_TRIES]:
            res = await self.run_tool("build", self.build_args(obj, price, req.open != "closed", site, player, True))
            if res.get("ok"):
                break
            error = res.get("error")
            log.info("build dry run at %s,%s failed: %s", site["x"], site["y"], error)
        else:
            return f"I couldn't find a spot that works: {error}."
        cost = res["result"]["cost"]
        exact = cost is not None
        cost = cost if exact else rtype.est_cost
        why = self.money_refusal(cost, info)
        if why:
            return why

        where = f"near {target['name']}" if target else POLICY_TEXT.get(policy, "next to a path")
        p = Proposal(obj, price, req.open != "closed", {k: site[k] for k in ("x", "y", "z", "direction", "entrance", "exit")
                                                         if k in site}, rtype.size, cost, exact,
                     where, time.monotonic() + self.cfg.build_proposal_ttl)
        self.pending[name.lower()] = p
        self.dropped.discard(name.lower())
        details = ", ".join(x for x in (fmt_price(price, self.currency), "open" if p.open else "closed") if x)
        return (f"Proposal: {obj['name']} at ({site['x']},{site['y']}) {where}, {details}. "
                f"Cost {'' if exact else 'about '}{fmt_money(cost, self.currency)}.{note} "
                f"Type !yes to build or !no to cancel.")

    def build_args(self, obj: dict, price, is_open: bool, site: dict, player: int, dry_run: bool) -> dict:
        args = {"dry_run": dry_run, "object": obj["object"], "ride_type": obj["ride_type"],
                "track_type": RIDE_TYPES[obj["ride_type"]].track_type, "x": site["x"], "y": site["y"], "z": site["z"],
                "direction": site.get("direction", 0), "price": price, "open": is_open, "player": player}
        if "entrance" in site:   # flat rides
            args["entrance"], args["exit"] = site["entrance"], site["exit"]
        return args

    async def parse(self, text: str, objects: list[dict], rides: list[dict]) -> BuildRequest:
        req = None
        if self.llm is not None:
            messages = [{"role": "system", "content": PARSE_PROMPT}, {"role": "user", "content": text}]
            try:
                data = await self.llm.complete_json(messages, PARSE_SCHEMA)
                req = validate_request(data)
                if req is None:
                    log.warning("build request parse gave invalid JSON: %s", json.dumps(data)[:200])
            except LLMError as e:
                log.warning("build request parse failed: %s", e)
        if req is None:
            req = parse_keywords(text)
        exact = exact_object(text, objects, rides)
        if exact and exact["ride_type"] in RIDE_TYPES:
            rtype = RIDE_TYPES[exact["ride_type"]]
            req = replace(req, kind="flat_ride" if rtype.size > 1 else "stall", category=rtype.category, object=exact["object"])
        elif exact:   # something it can't build; propose() says so
            req = replace(req, kind="flat_ride", object=exact["object"])
        return req

    async def choose(self, text: str, instructions: str, options: dict[str, str], default: str) -> str:
        """The decision model's pick among named options, or `default` without a model or a clear pick."""
        if self.router is None:
            return default
        try:
            probs = await self.router.choose(STATE + "Player request: " + text, instructions, options)
        except LLMError as e:
            log.warning("build choice failed, using %s: %s", default, e)
            return default
        best = max(options, key=lambda k: probs.get(k, 0))
        log.info("build choice: %s", ", ".join(f"{k} {probs.get(k, 0):.2f}" for k in sorted(options, key=lambda k: -probs.get(k, 0))[:3]))
        return best if probs.get(best, 0) >= PICK_MIN else default

    async def choose_object(self, text: str, candidates: list[dict]) -> dict:
        if len(candidates) == 1:
            return candidates[0]
        options = {o["object"]: f"{o['name']}: " + (RIDE_TYPES[o["ride_type"]].about
                                                    or f"a {CATEGORY_NAMES[RIDE_TYPES[o['ride_type']].category]}")
                   for o in candidates}
        pick = await self.choose(text, "Which one fits the player's request best?", options, candidates[0]["object"])
        return next(o for o in candidates if o["object"] == pick)

    async def choose_tier(self, text: str, pref: str) -> str:
        if pref != "unspecified":
            return pref
        return await self.choose(text, "Which price level does the player want?", PRICE_OPTIONS, "standard")

    async def choose_policy(self, text: str) -> str:
        if not self.cfg.build_choose_policy:
            return DEFAULT_POLICY
        pick = await self.choose(text, "Where should the stall go?", POLICY_OPTIONS, DEFAULT_POLICY)
        return DEFAULT_POLICY if pick == "none" else pick

    # ------------------------------------------------------------ !yes, !no, !undo

    async def confirm(self, player: int, name: str) -> str:
        return await self.localize(name, await self._confirm(player, name))

    async def _confirm(self, player: int, name: str) -> str:
        p = self.pending.pop(name.lower(), None)
        if p is None:
            if name.lower() in self.dropped:
                self.dropped.discard(name.lower())
                return "Your proposal was dropped because the game restarted. Please use !build again."
            return "You have no proposal waiting. Use !build first."
        if time.monotonic() > p.expires:
            return "Your proposal expired. Please use !build again."
        why = await self.refusal(player)
        if why:
            return why
        info = await self.tool("get_buildable", {"ride_types": [p.obj["ride_type"]]})
        why = self.money_refusal(p.cost, info)
        if why:
            return why
        wait = self.limiter.wait_time(name.lower())
        if wait:
            return (f"You can build {self.cfg.build_rate_limit} things per hour. "
                    f"Try again in {int(wait // 60) + 1} minutes.")
        async with self.lock:
            res = await self.run_tool("build", self.build_args(p.obj, p.price, p.open, p.site, player, False))
        if not res.get("ok"):
            return f"I couldn't build it: {res.get('error')}. Please use !build again."
        r = res["result"]
        self.built = self.built[-(MAX_BUILT - 1):] + [Built(r["ride_id"], r["name"], name.lower())]
        log.info("built %s (ride %s) for %s, cost %s", r["name"], r["ride_id"], name, r["cost"])
        details = ", ".join(x for x in (fmt_price(p.price, self.currency), r["status"]) if x)
        return (f"Built {r['name']} at ({p.site['x']},{p.site['y']}) {p.where}, {details}, for "
                f"{fmt_money(r['cost'], self.currency)}. Type !undo to remove it.")

    async def cancel(self, name: str) -> str:
        if self.pending.pop(name.lower(), None) is None:
            return await self.localize(name, "You have no proposal waiting.")
        return await self.localize(name, "OK, cancelled.")

    async def undo(self, player: int, name: str) -> str:
        return await self.localize(name, await self._undo(player, name))

    async def _undo(self, player: int, name: str) -> str:
        res = await self.run_tool("get_player_info", {"player": player})
        admin = bool(res.get("ok") and res["result"].get("is_admin"))
        mine = [b for b in self.built if admin or b.owner == name.lower()]
        if not mine:
            return "There is nothing of yours to undo." if not admin else "I haven't built anything to undo."
        last = mine[-1]
        async with self.lock:
            res = await self.run_tool("demolish", {"ride_id": last.ride_id, "name": last.name})
        if not res.get("ok"):
            if re.search(r"no ride with id|is now called", str(res.get("error"))):
                self.built.remove(last)
                return f"{last.name} is already gone."
            return f"I couldn't remove {last.name}: {res.get('error')}."
        self.built.remove(last)
        log.info("undo: demolished %s (ride %s) for %s", last.name, last.ride_id, name)
        return f"Removed {last.name}, the park got {fmt_money(res['result']['refund'], self.currency)} back."

    async def localize(self, name: str, text: str) -> str:
        """The reply in the player's language. The translation is only used if every number and
        command survived it; otherwise the English text goes out."""
        lang = self.language.get(name.lower(), "en")
        if lang == "en" or self.llm is None:
            return text
        prompt = TRANSLATE_PROMPT.format(lang=lang)
        try:
            reply = await self.llm.complete([{"role": "system", "content": prompt}, {"role": "user", "content": text}])
        except LLMError as e:
            log.warning("translation to %s failed: %s", lang, e)
            return text
        out = plain_text(reply.content)
        keep = re.findall(r"\d+(?:[.,]\d+)*|![a-z]+", text)
        swap = str.maketrans(".,", ",.")   # "3.50" may become "3,50" in German
        lost = [k for k in keep if k not in out and k.translate(swap) not in out]
        if not out or lost:
            log.info("translation to %s dropped %s, sending English: %s", lang, lost, out)
            return text
        return out
