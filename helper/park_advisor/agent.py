"""The agent: question -> tools against the live park -> short plain-text answer.

Local models are small, so the model does not call tools itself: a decision model picks the tools,
the helper runs them, and a small chat model writes the answer from a compact text version of the
results."""

import asyncio
import json
import logging
import re
import unicodedata
from typing import Awaitable, Callable

from .llm import LLMError, Reply

log = logging.getLogger("agent")

ToolRunner = Callable[[str, dict], Awaitable[dict]]

MAX_ANSWER = 600      # chars; about three chat lines


# Short option texts for the decision model: in tests, longer ones were slower and no better.
ROUTER_OPTIONS = {
    "get_park_summary": "Park overview: cash, loan, park rating, guest count, park value, entrance fee, weather, "
                        "awards, scenario objective",
    "list_rides": "All rides, shops and stalls with status, ratings, prices, customers, profit, queues, breakdowns",
    "get_ride": "Full details for one specific ride by its id or name",
    "get_guest_overview": "Guest happiness, hunger, thirst, nausea, toilet needs, cash, litter, and what guests are "
                          "thinking or complaining about",
    "get_staff": "How many handymen, mechanics, security guards and entertainers",
    "get_recent_messages": "Recent park news: breakdowns, awards, finance warnings, complaints, research",
}
NO_DATA = "none"
ROUTER_STATE = ("An OpenRCT2 park advisor bot must answer a player question using live data from the player's "
                "theme park. Decide which park data to look up.\n")
ROUTER_INSTRUCTIONS = ("Which data source is most needed to answer the player's question about their park? "
                       "Pick none if no park data is needed.")
ROUTER_NONE = "Greeting, small talk or general game knowledge; no park data needed"
PICK_MIN = 0.15   # probability from which a tool is looked up
MAX_SENTENCES = 3
REMINDER = "Reply in the language of the question, in at most 3 short plain-text sentences.\n"
MAX_PICKS = 3

# The decision model reliably finds the main tool but misses second ones, and never picked get_staff
# for "do I need more mechanics?". These patterns can only add tools to its choice.
KEYWORD_TOOLS = {
    "get_staff": r"mechani|handym|staff|employ|security|guard|entertainer|\bhire|\bfire\b|personal|mitarbeiter|"
                 r"einstellen",
    "get_recent_messages": r"\bnews|recent|happened|lately|nachrichten|passiert|neuigkeit",
}

# How to order the ride list for a question: (pattern, field, highest first, label).
RIDE_ORDER = [
    (r"break|broke|repair|downtime|reliab|kaputt|panne", "downtime_pct", True, "downtime"),
    (r"queue|wait|line|schlange|warte", "max_queue_min", True, "longest queue"),
    (r"intens|nause|sick|übel", "intensity", True, "intensity"),
    (r"excit|thrill|aufregend", "excitement", True, "excitement"),
    (r"unhappy|satisf|zufrieden|complain", "satisfaction_pct", False, "guest satisfaction, lowest first"),
    (r"popular|busy|customer|beliebt|besucht", "customers", True, "customers"),
]
MAX_RIDES = 12
MAX_THOUGHTS = 8
MAX_MESSAGES = 8
RIDE_FIELDS = ["broken_down", "excitement", "intensity", "nausea", "price", "customers", "profit_per_hour",
               "satisfaction_pct", "downtime_pct", "max_queue_min"]

LOCAL_SYSTEM_PROMPT = """\
You are the Park Advisor, a friendly expert on RollerCoaster Tycoon 2, helping players on an \
OpenRCT2 multiplayer server run their shared park. Players ask you questions in the game chat.

Rules:
- Each question comes with live data from the park. Use only that data for facts about this park, \
and never invent numbers or names. If the data does not show something, say so.
- Lists in the data are already sorted as stated, so the first entry is the highest.
- You can only look, not change anything. Tell the players what they can do themselves.
- Answer in plain text only: no markdown, no lists, no emojis.
- Keep it short: at most 3 short sentences, with ride names and numbers.
- Answer in the language of the question.

Units: money is in the park's currency. Park rating goes from 0 to 999. Guest averages are percentages.\
"""


class Agent:
    """Decision model picks tools, the helper runs them, a small chat model answers in one call."""

    def __init__(self, router, llm, run_tool: ToolRunner):
        self.router = router
        self.llm = llm
        self.run_tool = run_tool
        self.available = set(ROUTER_OPTIONS)
        # A Raspberry Pi runs one local question at a time well, two in parallel badly.
        self.lock = asyncio.Lock()

    def set_available_tools(self, names: list[str]) -> None:
        self.available = set(names) & set(ROUTER_OPTIONS)

    async def answer(self, question: str, history: list[tuple[str, str]], player_name: str) -> str:
        async with self.lock:
            ride_id = await self.find_ride(question)
            tools = await self.pick_tools(question, history, ride_id is not None)
            data = await self.gather(question, tools, ride_id)
            messages: list[dict] = [{"role": "system", "content": LOCAL_SYSTEM_PROMPT + f"\n\nThe player asking is {player_name}."}]
            for q, a in history:
                messages.append({"role": "user", "content": q})
                messages.append({"role": "assistant", "content": a})
            # Small models follow rules better when they sit right next to the question.
            messages.append({"role": "user", "content": (data + "\n\n" if data else "") + REMINDER + "Question: " + question})
            log.debug("prompt: %r", messages[-1]["content"])
            reply = await self.llm.complete(messages)
            return first_sentences(finish_answer(reply), MAX_SENTENCES)

    async def pick_tools(self, question: str, history: list[tuple[str, str]], names_ride: bool) -> list[str]:
        options = {n: d for n, d in ROUTER_OPTIONS.items() if n in self.available}
        options[NO_DATA] = ROUTER_NONE
        state = ROUTER_STATE
        if history:  # lets follow-ups like "and the second one?" find the right data
            state += f"Previous question: {history[-1][0]}\n"
        probs = await self.router.choose(state + "Player question: " + question, ROUTER_INSTRUCTIONS, options)
        ranked = sorted(probs.items(), key=lambda kv: -kv[1])
        picked = [n for n, p in ranked if p >= PICK_MIN and n in self.available][:MAX_PICKS]
        q = question.lower()
        added = [n for n, pat in KEYWORD_TOOLS.items() if n in self.available and n not in picked and re.search(pat, q)]
        if names_ride and "get_ride" in self.available and "get_ride" not in picked:
            added.append("get_ride")
        log.info("router: %s -> %s%s", ", ".join(f"{n} {p:.2f}" for n, p in ranked[:3]), picked or [NO_DATA],
                 f", keywords add {added}" if added else "")
        return picked + added

    async def gather(self, question: str, tools: list[str], ride_id: int | None) -> str:
        """Run the tools and return their results as compact text sections."""
        sections = []
        for name in tools:
            args = {}
            if name == "get_ride":
                if ride_id is None:
                    log.info("no ride id or name in the question, listing all rides instead")
                    if "list_rides" in tools or "list_rides" not in self.available:
                        continue
                    name = "list_rides"
                else:
                    args = {"id": ride_id}
            log.info("tool %s %s", name, json.dumps(args))
            res = await self.run_tool(name, args)
            if not res.get("ok"):
                log.info("tool %s failed: %s", name, res.get("error"))
                sections.append(f"[{name}]\nerror: {res.get('error', 'tool failed')}")
            else:
                sections.append(FORMATTERS[name](res.get("result"), question))
        return "\n\n".join(sections)

    async def find_ride(self, question: str) -> int | None:
        """The ride a question is about, by "ride 4", "#4" or its name."""
        m = re.search(r"(?:\bride|#)\s*#?(\d+)\b", question, re.IGNORECASE)
        if m:
            return int(m.group(1))
        if "list_rides" not in self.available:
            return None
        res = await self.run_tool("list_rides", {})
        q = question.lower()
        names = [(r["name"].lower(), r["id"]) for r in (res.get("result") or []) if res.get("ok") and r.get("name")]
        hits = [(len(n), i) for n, i in names if n in q]
        return max(hits)[1] if hits else None


def _value(v) -> str:
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, list):
        return ", ".join(_value(x) for x in v) or "none"
    return str(v)


def _pairs(d: dict, prefix: str = "") -> list[str]:
    out = []
    for k, v in d.items():
        if isinstance(v, dict):
            out += _pairs(v, prefix + k + " ")
        else:
            out.append(f"{(prefix + k).replace('_', ' ')}: {_value(v)}")
    return out


def format_park(data: dict, question: str) -> str:
    return "[park]\n" + "\n".join(_pairs(data))


def format_ride(data: dict, question: str) -> str:
    return f"[ride {data.get('name')}]\n" + "\n".join(_pairs(data))


def format_rides(rides: list, question: str) -> str:
    q = question.lower()
    field, desc, label = "profit_per_hour", True, "profit per hour"
    for pat, f, d, lab in RIDE_ORDER:
        if re.search(pat, q):
            field, desc, label = f, d, lab
            break
    missing = float("-inf") if desc else float("inf")
    ordered = sorted(rides, key=lambda r: r.get(field) if isinstance(r.get(field), (int, float)) else missing,
                     reverse=desc)
    # Broken or closed rides are always shown, they are often what the question is about.
    problems = [r for r in ordered if r.get("broken_down") or r.get("status") not in ("open", None)]
    shown = ordered[:MAX_RIDES]
    shown += [r for r in problems if r not in shown]
    lines = [f"[rides] {len(rides)} total, sorted by {label}" + ("" if label.endswith("first") else ", highest first")]
    name = field.replace("_", " ")
    # Spelled out, because a 1B model does not reliably read the maximum off a list.
    if ordered and isinstance(ordered[0].get(field), (int, float)):
        lines.append(f"{'lowest' if not desc else 'highest'} {name}: {ordered[0].get('name')} ({_value(ordered[0][field])})")
    for r in shown:
        fields = [field] + [k for k in RIDE_FIELDS if k != field]  # the sort field first
        stats = ", ".join(f"{k.replace('_', ' ')} {_value(r[k])}" for k in fields if r.get(k) not in (None, []))
        lines.append(f"- {r.get('name')} (id {r.get('id')}, {r.get('type')}, {r.get('status')}): {stats}")
    if len(shown) < len(rides):
        lines.append(f"({len(rides) - len(shown)} more not shown)")
    return "\n".join(lines)


def format_guests(data: dict, question: str) -> str:
    data = dict(data)
    thoughts = data.pop("top_thoughts", [])[:MAX_THOUGHTS]
    lines = ["[guests]"] + _pairs(data)
    if thoughts:
        lines.append("most common thoughts: " + "; ".join(f"{t['thought']} ({t['guests']} guests)" for t in thoughts))
    return "\n".join(lines)


def format_staff(data: dict, question: str) -> str:
    return "[staff]\n" + ", ".join(f"{k} {v}" for k, v in data.items())


def format_messages(msgs: list, question: str) -> str:
    return "[news] newest first\n" + "\n".join(f"- {m['date']}: {m['text']}" for m in msgs[:MAX_MESSAGES])


FORMATTERS = {
    "get_park_summary": format_park,
    "list_rides": format_rides,
    "get_ride": format_ride,
    "get_guest_overview": format_guests,
    "get_staff": format_staff,
    "get_recent_messages": format_messages,
}


# Typography the game font may lack, mapped to ASCII.
_REPLACE = str.maketrans({
    "“": '"', "”": '"', "„": '"', "‟": '"', "‘": "'", "’": "'", "‚": "'", "′": "'", "″": '"',
    "–": "-", "—": "-", "−": "-", "…": "...", "•": "-", "·": "-", "→": "->", "←": "<-",
    " ": " ", " ": " ", " ": " ",
})


def plain_text(s: str) -> str:
    """Strip markdown and characters the game cannot render (emojis, pictographs), keep letters
    of any script so answers in other languages survive."""
    s = s.translate(_REPLACE)
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)            # [text](url)
    s = re.sub(r"(\*\*|__)(.+?)\1", r"\2", s)                  # **bold**
    s = re.sub(r"(?<!\w)[*_](\S.*?)[*_](?!\w)", r"\1", s)      # *italic*
    s = s.replace("`", "")
    lines = []
    for line in s.splitlines():
        line = re.sub(r"^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)", "", line).strip()
        if line:
            if lines and not re.search(r"[.!?:;,]$", lines[-1]):
                lines[-1] += "."
            lines.append(line)
    s = " ".join(lines)
    out = []
    for ch in s:
        if ord(ch) < 0x100:
            out.append(ch)
        elif unicodedata.category(ch)[0] in "LMNPZ" and unicodedata.category(ch) != "Mn" or ch in "€":
            out.append(ch)
    return re.sub(r"\s+", " ", "".join(out)).replace(" .", ".").strip()


def finish_answer(reply: Reply) -> str:
    text = shorten(plain_text(reply.content), MAX_ANSWER)
    if not text:
        raise LLMError("empty answer")
    return text


def first_sentences(s: str, n: int) -> str:
    parts = re.split(r"(?<=[.!?])\s+", s)
    return " ".join(parts[:n])


def shorten(s: str, limit: int) -> str:
    if len(s) <= limit:
        return s
    cut = s[:limit]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    if end >= limit // 2:
        return cut[:end + 1]
    return cut[:cut.rfind(" ")].rstrip(",;:") + "..."
