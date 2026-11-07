"""Chat-completion clients (Ollama's OpenAI-compatible endpoint, and its native /api/chat for JSON
answers), the Jev-style decision-model router (Ollama's /v1/systemone), and scripted fakes of both
for tests."""

import asyncio
import json
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass

import openai

log = logging.getLogger("llm")


class LLMError(Exception):
    def __init__(self, message: str, rate_limited: bool = False):
        super().__init__(message)
        self.rate_limited = rate_limited


def describe(e: openai.OpenAIError) -> str:
    """One-line error text; error bodies can be huge."""
    body = getattr(e, "body", None)
    if isinstance(body, dict):
        body = body.get("error", body)
    text = body.get("message") if isinstance(body, dict) else None
    text = re.sub(r"\s+", " ", str(text or e)).strip()
    status = getattr(e, "status_code", None)
    return (f"{status} {text}" if status else text)[:400]


@dataclass
class Reply:
    content: str


def post_json(url: str, body: dict, timeout: float, model: str) -> dict:
    """POST a JSON body to Ollama and return the JSON reply (blocking; run it in a thread)."""
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read(400).decode("utf-8", "replace")
        raise LLMError(f"{model}: {e.code} {detail}", rate_limited=e.code == 429) from e
    except (OSError, ValueError) as e:  # URLError, timeouts and bad JSON
        raise LLMError(f"{model}: {e}") from e


class OllamaChat:
    """Chat client for Ollama's OpenAI-compatible endpoint."""

    def __init__(self, base_url: str, model: str, timeout: float = 40.0, **options):
        # Ollama ignores the key, but the client library insists on one.
        self.client = openai.AsyncOpenAI(base_url=base_url, api_key="ollama", timeout=timeout, max_retries=1)
        self.model = model
        self.options = options  # extra request parameters, e.g. temperature or max_tokens
        self.timeout = timeout
        self.native_url = base_url.rstrip("/").removesuffix("/v1") + "/api/chat"

    async def complete(self, messages: list[dict]) -> Reply:
        try:
            resp = await self.client.chat.completions.create(model=self.model, messages=messages, **self.options)
        except openai.OpenAIError as e:
            raise LLMError(f"{self.model}: {describe(e)}", isinstance(e, openai.RateLimitError)) from e
        if not resp.choices:
            raise LLMError(f"{self.model}: empty response")
        if resp.usage:
            log.debug("%s: %s prompt + %s completion tokens", self.model, resp.usage.prompt_tokens,
                      resp.usage.completion_tokens)
        return Reply(resp.choices[0].message.content or "")

    async def complete_json(self, messages: list[dict], schema: dict) -> dict:
        """One answer constrained to a JSON schema. Ollama's native API takes the schema as `format`
        (the OpenAI-compatible endpoint does not), and `think: false` keeps Qwen3 from reasoning first."""
        body = {"model": self.model, "messages": messages, "format": schema, "stream": False, "think": False,
                "options": {"temperature": 0}}
        resp = await asyncio.to_thread(post_json, self.native_url, body, self.timeout, self.model)
        try:
            return json.loads(resp["message"]["content"])
        except (KeyError, TypeError, ValueError) as e:
            raise LLMError(f"{self.model}: unexpected JSON response {str(resp)[:200]}") from e


class JevRouter:
    """A decision model behind Ollama's /v1/systemone (TypeSafe's Jev API). Instead of text it
    returns a probability for each option of a choice question."""

    def __init__(self, base_url: str, model: str, timeout: float = 30.0):
        self.url = base_url.rstrip("/") + "/v1/systemone"
        self.model = model
        self.timeout = timeout

    async def choose(self, state: str, instructions: str, options: dict[str, str]) -> dict[str, float]:
        body = {"model": self.model, "state": state,
                "questions": {"pick": {"type": "choice", "instructions": instructions, "criteria": options}}}
        resp = await asyncio.to_thread(post_json, self.url, body, self.timeout, self.model)
        try:
            answer = resp["answers"]["pick"]
            probs = {k: float(v) for k, v in answer["probabilities"].items()}
        except (KeyError, TypeError, ValueError, AttributeError) as e:
            raise LLMError(f"{self.model}: unexpected decision response {str(resp)[:200]}") from e
        log.debug("%s: %s input tokens, picked %s (confidence %.2f)", self.model,
                  (resp.get("usage") or {}).get("input_tokens"), answer.get("choice"), answer.get("confidence") or 0)
        return probs


class FakeRouter:
    """Deterministic stand-in for JevRouter. For tool picks, the first option whose pattern matches
    the player question wins, otherwise "none"; it never picks get_staff, like the real model. For
    other choices (building), the option sharing the most words with the request wins; with no
    shared word every option gets 0.1. #fail raises."""

    PATTERNS = {
        "get_ride": r"ride \d|big dipper|merry",
        "list_rides": r"ride|coaster|profit",
        "get_guest_overview": r"guest|gäste",
        "get_park_summary": r"park|money|cash",
        "get_recent_messages": r"happened",
    }

    async def choose(self, state: str, instructions: str, options: dict[str, str]) -> dict[str, float]:
        q = re.split(r"Player (?:question|request):", state)[-1].lower()
        if "#fail" in q:
            raise LLMError("fake router failure")
        if any(n in self.PATTERNS for n in options):
            pick = next((n for n, pat in self.PATTERNS.items() if n in options and re.search(pat, q)), "none")
        else:
            words = set(re.findall(r"\w{3,}", q))
            overlap = {n: len(words & set(re.findall(r"\w{3,}", (n + " " + d).lower()))) for n, d in options.items()}
            pick = max(overlap, key=overlap.get)
            if not overlap[pick]:  # nothing fits: unsure, like the real model
                return {n: 0.1 for n in options}
        return {n: (0.9 if n == pick else 0.1 / max(1, len(options) - 1)) for n in options}


class FakeLLM:
    """Deterministic stand-in for tests: echoes the question plus a short summary of the park data
    sections in the prompt. Markers trigger edge cases: #fail (API error), #ratelimit, #slow (hangs),
    #markdown (formatted answer with emojis), #long (very long answer).
    complete_json fills the build form from a few words; #badjson returns a broken form."""

    # A deliberately different word list than the builder's keyword fallback, so tests can tell
    # which one parsed a request ("munchies" only the fake model knows).
    FORM_WORDS = [("food", r"burger|hot dog|munchies|food"), ("drink", r"drink|coffee"), ("souvenir", r"balloon|souvenir"),
                  ("toilet", r"toilet|restroom"), ("atm", r"\batm\b|money machine"), ("first_aid", r"first aid")]

    async def complete_json(self, messages: list[dict], schema: dict) -> dict:
        q = messages[-1]["content"].lower()
        if "#fail" in q:
            raise LLMError("fake failure")
        if "#slow" in q:
            await asyncio.sleep(3600)
        if "#badjson" in q:
            return {"kind": "spaceship"}
        near = re.search(r"\b(?:near|next to|by) (?:the )?(.+?)(?:[,.!]|$)", q)
        what = q[:near.start()] + q[near.end():] if near else q   # "near the Burger Bar" is not a burger
        category = next((c for c, pat in self.FORM_WORDS if re.search(pat, what)), None)
        price = next((t for t in ("free", "cheap", "premium") if t in q), "unspecified")
        return {
            "kind": "stall" if category else "flat_ride" if "carousel" in what else "unknown",
            "category": category or "any",
            "near": near.group(1).strip() if near else None,
            "price_pref": "premium" if "expensive" in q else price,
            "open": "closed" if "closed" in q else "unspecified",
        }

    async def complete(self, messages: list[dict]) -> Reply:
        last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
        question = messages[last_user]["content"]
        history = sum(1 for m in messages[:last_user] if m["role"] == "user")
        q = question.lower()

        if "#fail" in q:
            raise LLMError("fake failure")
        if "#ratelimit" in q:
            raise LLMError("fake rate limit", rate_limited=True)
        if "#slow" in q:
            await asyncio.sleep(3600)

        if "#markdown" in q:
            answer = "**Great park!** 🎢 Your “Big Dipper” is popular — add a `Burger Bar`…\n- item one\n- item two ✨"
        elif "#long" in q:
            answer = " ".join(" ".join(f"word{i}" for i in range(60)) + "." for _ in range(3))
        else:
            # The park data comes inside the question, as "[section]" blocks.
            data, _, asked = question.rpartition("Question: ")
            answer = f"Echo: {asked}"
            sections = re.findall(r"^\[([^\]]+)\](.*)$", data, re.MULTILINE)
            if sections:
                answer += " Data: " + "; ".join((name + rest).strip() for name, rest in sections) + "."
                rides = re.findall(r"^- (.+?) \(id", data, re.MULTILINE)
                if rides:
                    answer += " Rides: " + ", ".join(rides) + "."
            if history:
                answer += f" History: {history}."
        return Reply(answer)
