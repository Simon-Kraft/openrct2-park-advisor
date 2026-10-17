"""Chat-completion clients (any OpenAI-compatible API), the Jev-style decision-model router
(Ollama's /v1/systemone), and scripted fakes of both for tests."""

import asyncio
import json
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field

import openai

log = logging.getLogger("llm")

MAX_RATE_LIMIT_WAIT = 30.0  # seconds; longer "retry in" hints (e.g. daily quota) fail right away


class LLMError(Exception):
    def __init__(self, message: str, rate_limited: bool = False):
        super().__init__(message)
        self.rate_limited = rate_limited


def describe(e: openai.OpenAIError) -> str:
    """One-line error text; provider error bodies can be huge."""
    body = getattr(e, "body", None)
    if isinstance(body, list) and body:  # Gemini wraps the error in a list
        body = body[0]
    if isinstance(body, dict):
        body = body.get("error", body)
    text = body.get("message") if isinstance(body, dict) else None
    text = re.sub(r"\s+", " ", str(text or e)).strip()
    status = getattr(e, "status_code", None)
    return (f"{status} {text}" if status else text)[:400]


def retry_delay(e: openai.APIStatusError) -> float | None:
    """Seconds the provider asks us to wait, from a Retry-After header or Gemini's "retry in 18.2s"."""
    try:
        return float(e.response.headers.get("retry-after", ""))
    except (AttributeError, ValueError):
        pass
    m = re.search(r"retry in (\d+(?:\.\d+)?)s|retryDelay\W+(\d+(?:\.\d+)?)s", str(e), re.IGNORECASE)
    return float(m.group(1) or m.group(2)) if m else None


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # JSON text, as the model produced it


@dataclass
class Reply:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    message: dict = field(default_factory=dict)  # assistant message to append to the conversation


class OpenAIChat:
    """Works with OpenAI, Gemini, Mistral, Groq, Ollama, ... through their OpenAI-compatible endpoints."""

    def __init__(self, base_url: str, api_key: str, model: str, fallback_model: str = "", timeout: float = 40.0,
                 **options):
        self.client = openai.AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=timeout, max_retries=1)
        self.model = model
        self.fallback_model = fallback_model if fallback_model != model else ""
        self.options = options  # extra request parameters, e.g. temperature or max_tokens

    async def complete(self, messages: list[dict], tools: list[dict], tool_choice: str = "auto") -> Reply:
        models = [self.model] + ([self.fallback_model] if self.fallback_model else [])
        for i, model in enumerate(models):
            try:
                return await self._complete_waiting(model, messages, tools, tool_choice)
            except (openai.AuthenticationError, openai.PermissionDeniedError) as e:
                raise LLMError(f"{model}: {describe(e)}") from e
            except openai.OpenAIError as e:
                if i == len(models) - 1:
                    raise LLMError(f"{model}: {describe(e)}", isinstance(e, openai.RateLimitError)) from e
                log.warning("%s failed (%s), trying %s", model, describe(e), models[i + 1])
        raise AssertionError("unreachable")

    async def _complete_waiting(self, model: str, messages: list[dict], tools: list[dict], tool_choice: str) -> Reply:
        """Like _complete, but when the provider says "retry in N s" for a short N, wait and retry once.
        Free tiers allow only a few requests per minute, so waiting beats failing."""
        try:
            return await self._complete(model, messages, tools, tool_choice)
        except openai.RateLimitError as e:
            delay = retry_delay(e)
            if delay is None or delay > MAX_RATE_LIMIT_WAIT:
                raise
            log.info("%s rate limited, retrying in %.0fs", model, delay)
            await asyncio.sleep(delay + 0.5)
            return await self._complete(model, messages, tools, tool_choice)

    async def _complete(self, model: str, messages: list[dict], tools: list[dict], tool_choice: str) -> Reply:
        params = dict(self.options)
        if tools:
            params.update(tools=tools, tool_choice=tool_choice)
        resp = await self.client.chat.completions.create(model=model, messages=messages, **params)
        if not resp.choices:
            raise LLMError(f"{model}: empty response")
        msg = resp.choices[0].message
        calls = [ToolCall(tc.id, tc.function.name, tc.function.arguments or "{}")
                 for tc in (msg.tool_calls or []) if tc.type == "function"]
        message: dict = {"role": "assistant", "content": msg.content or ""}
        if msg.tool_calls:
            # model_dump keeps provider extras such as Gemini's thought signatures,
            # which must be sent back with the tool results.
            message["tool_calls"] = [tc.model_dump(exclude_none=True) for tc in msg.tool_calls]
        if resp.usage:
            log.debug("%s: %s prompt + %s completion tokens", model, resp.usage.prompt_tokens, resp.usage.completion_tokens)
        return Reply(msg.content or "", calls, message)


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
        resp = await asyncio.to_thread(self._post, body)
        try:
            answer = resp["answers"]["pick"]
            probs = {k: float(v) for k, v in answer["probabilities"].items()}
        except (KeyError, TypeError, ValueError, AttributeError) as e:
            raise LLMError(f"{self.model}: unexpected decision response {str(resp)[:200]}") from e
        log.debug("%s: %s input tokens, picked %s (confidence %.2f)", self.model,
                  (resp.get("usage") or {}).get("input_tokens"), answer.get("choice"), answer.get("confidence") or 0)
        return probs

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request(self.url, json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read(400).decode("utf-8", "replace")
            raise LLMError(f"{self.model}: {e.code} {detail}", rate_limited=e.code == 429) from e
        except (OSError, ValueError) as e:  # URLError, timeouts and bad JSON
            raise LLMError(f"{self.model}: {e}") from e


class FakeRouter:
    """Deterministic stand-in for JevRouter: the first option whose pattern matches the player
    question wins, otherwise "none". It never picks get_staff, like the real model. #fail raises."""

    PATTERNS = {
        "get_ride": r"ride \d|big dipper|merry",
        "list_rides": r"ride|coaster|profit",
        "get_guest_overview": r"guest|gäste",
        "get_park_summary": r"park|money|cash",
        "get_recent_messages": r"happened",
    }

    async def choose(self, state: str, instructions: str, options: dict[str, str]) -> dict[str, float]:
        q = state.rsplit("Player question:", 1)[-1].lower()
        if "#fail" in q:
            raise LLMError("fake router failure")
        pick = next((n for n, pat in self.PATTERNS.items() if n in options and re.search(pat, q)), "none")
        return {n: (0.9 if n == pick else 0.1 / max(1, len(options) - 1)) for n in options}


class FakeLLM:
    """Deterministic stand-in for tests. It picks tools from keywords in the question and then
    answers with an echo plus a short summary of the tool results (or, when no tools are offered,
    of the park data sections in the prompt). Markers trigger edge cases:
    #fail (API error), #ratelimit, #slow (hangs), #loop (never stops calling tools),
    #markdown (formatted answer with emojis), #long (very long answer)."""

    def __init__(self):
        self._ids = 0

    async def complete(self, messages: list[dict], tools: list[dict], tool_choice: str = "auto") -> Reply:
        last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
        question = messages[last_user]["content"]
        history = sum(1 for m in messages[:last_user] if m["role"] == "user")
        results = [m for m in messages[last_user:] if m["role"] == "tool"]
        q = question.lower()

        if "#fail" in q:
            raise LLMError("fake failure")
        if "#ratelimit" in q:
            raise LLMError("fake rate limit", rate_limited=True)
        if "#slow" in q:
            await asyncio.sleep(3600)

        if tools and tool_choice != "none" and ("#loop" in q or not results):
            calls = self._pick_tools(q)
            if calls:
                tcs = []
                for name, args in calls:
                    self._ids += 1
                    tcs.append(ToolCall(f"call_{self._ids}", name, json.dumps(args)))
                message = {"role": "assistant", "content": "", "tool_calls": [
                    {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}} for c in tcs]}
                return Reply("", tcs, message)

        if "#markdown" in q:
            answer = "**Great park!** 🎢 Your “Big Dipper” is popular — add a `Burger Bar`…\n- item one\n- item two ✨"
        elif "#long" in q:
            answer = " ".join(f"Sentence number {i} is here." for i in range(100))
        elif not tools:
            # Local mode: the park data comes inside the question, as "[section]" blocks.
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
        else:
            answer = f"Echo: {question}"
            if results:
                names = {tc["id"]: tc["function"]["name"]
                         for m in messages if m.get("tool_calls") for tc in m["tool_calls"]}
                answer += " Tools: " + "; ".join(self._summary(names.get(m["tool_call_id"], "?"), m) for m in results) + "."
            if history:
                answer += f" History: {history}."
        return Reply(answer, [], {"role": "assistant", "content": answer})

    @staticmethod
    def _pick_tools(q: str) -> list[tuple[str, dict]]:
        if "#loop" in q:
            return [("get_staff", {})]
        calls = []
        m = re.search(r"ride (\d+)", q)
        if m:
            calls.append(("get_ride", {"id": int(m.group(1))}))
        elif "ride" in q:
            calls.append(("list_rides", {}))
        if "guest" in q:
            calls.append(("get_guest_overview", {}))
        if "staff" in q:
            calls.append(("get_staff", {}))
        if "news" in q:
            calls.append(("get_recent_messages", {"limit": 3}))
        if "park" in q:
            calls.append(("get_park_summary", {}))
        if "#badtool" in q:
            calls.append(("delete_park", {}))
        return calls

    @staticmethod
    def _summary(name: str, tool_msg: dict) -> str:
        data = json.loads(tool_msg["content"])
        if isinstance(data, dict) and "error" in data:
            return f"{name} error {data['error']}"
        if isinstance(data, list):
            return f"{name} {len(data)} items"
        scalars = [f"{k}={v}" for k, v in data.items() if isinstance(v, (str, int, float))][:2]
        return f"{name} " + " ".join(scalars)
