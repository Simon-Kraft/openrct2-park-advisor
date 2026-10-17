"""Chat command handling: turns plugin messages into replies."""

import asyncio
import logging
import time
from collections import deque

from .agent import Agent, LocalAgent
from .bridge import Bridge, BridgeError
from .config import Config
from .llm import FakeLLM, FakeRouter, JevRouter, LLMError, OpenAIChat

log = logging.getLogger("app")

MEMORY_TURNS = 3        # question/answer pairs remembered per player
MEMORY_TTL = 15 * 60    # seconds of silence after which a conversation is forgotten
MAX_QUESTION = 500      # chars
TOOL_TIMEOUT = 10.0     # seconds per tool call to the plugin
LOCAL_OPTIONS = {"temperature": 0.3, "max_tokens": 200}  # a 1B model invents less when it is not creative


class Memory:
    """Short per-player conversation history."""

    def __init__(self, turns: int = MEMORY_TURNS, ttl: float = MEMORY_TTL):
        self.turns = turns
        self.ttl = ttl
        self._data: dict[tuple, tuple[float, deque]] = {}

    def get(self, key: tuple) -> list[tuple[str, str]]:
        entry = self._data.get(key)
        if not entry:
            return []
        if time.monotonic() - entry[0] > self.ttl:
            del self._data[key]
            return []
        return list(entry[1])

    def add(self, key: tuple, question: str, answer: str) -> None:
        pairs = deque(self.get(key), maxlen=self.turns)
        pairs.append((question, answer))
        self._data[key] = (time.monotonic(), pairs)

    def clear(self, key: tuple) -> None:
        self._data.pop(key, None)


class RateLimiter:
    """At most `limit` events per `window` seconds per key."""

    def __init__(self, limit: int, window: float = 60.0):
        self.limit = limit
        self.window = window
        self._events: dict[int, deque[float]] = {}

    def wait_time(self, key: int) -> float:
        """0 if allowed now (and records the event), else seconds until the next slot."""
        now = time.monotonic()
        events = self._events.setdefault(key, deque())
        while events and now - events[0] >= self.window:
            events.popleft()
        if len(events) >= self.limit:
            return self.window - (now - events[0])
        events.append(now)
        return 0.0


class Advisor:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.bridge = Bridge(cfg.bridge_host, cfg.bridge_port, self.on_message)
        self.agent = None
        if cfg.llm_mode == "openai":
            llm = OpenAIChat(cfg.llm_base_url, cfg.llm_api_key, cfg.llm_model, cfg.llm_fallback_model, cfg.llm_timeout)
            self.agent = Agent(llm, self.run_tool)
            log.info("LLM: %s at %s (fallback %s)", cfg.llm_model, cfg.llm_base_url, cfg.llm_fallback_model or "none")
        elif cfg.llm_mode == "local":
            # The whole question has one timeout; a cold model load alone can take a while on a Pi.
            router = JevRouter(cfg.local_url, cfg.local_router_model, cfg.ask_timeout)
            llm = OpenAIChat(cfg.local_url.rstrip("/") + "/v1/", "ollama", cfg.local_answer_model, "", cfg.ask_timeout,
                             **LOCAL_OPTIONS)
            self.agent = LocalAgent(router, llm, self.run_tool)
            log.info("LLM: local, %s picks tools, %s answers, at %s", cfg.local_router_model, cfg.local_answer_model,
                     cfg.local_url)
        elif cfg.llm_mode == "fake":
            self.agent = Agent(FakeLLM(), self.run_tool)
            log.info("LLM: fake (tests)")
        elif cfg.llm_mode == "fake-local":
            self.agent = LocalAgent(FakeRouter(), FakeLLM(), self.run_tool)
            log.info("LLM: fake local (tests)")
        else:
            log.info("LLM: none, echo mode")
        self.memory = Memory()
        self.limiter = RateLimiter(cfg.rate_limit)
        self.busy: set[int] = set()

    async def run(self) -> None:
        await self.bridge.run_forever()

    async def on_message(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "hello":
            tools = msg.get("tools", [])
            log.info("plugin hello: protocol %s, API %s, tools: %s", msg.get("protocol"), msg.get("api"), ", ".join(tools))
            if self.agent:
                self.agent.set_available_tools(tools)
        elif kind == "ask":
            await self.on_ask(msg["player"], msg.get("name", "?"), msg.get("text", ""))
        elif kind == "reset":
            self.memory.clear((msg["player"], msg.get("name", "?")))
            await self.bridge.say(msg["player"], "OK, I forgot our conversation.")
        else:
            log.debug("ignoring message %s", kind)

    async def run_tool(self, name: str, args: dict) -> dict:
        return await self.bridge.request({"type": "tool_call", "name": name, "args": args}, TOOL_TIMEOUT)

    async def on_ask(self, player: int, name: str, question: str) -> None:
        log.info("ask from %s (#%s): %s", name, player, question)
        question = question.strip()[:MAX_QUESTION]
        if self.agent is None:
            await self.bridge.say(player, "Thinking...")
            await self.bridge.say(player, f"Echo: {question}")
            return
        if player in self.busy:
            await self.bridge.say(player, "I'm still thinking about your last question.")
            return
        wait = self.limiter.wait_time(player)
        if wait:
            await self.bridge.say(player, f"Slow down a little, you can ask {self.cfg.rate_limit} questions per minute. "
                                          f"Try again in {int(wait) + 1} seconds.")
            return

        key = (player, name)
        self.busy.add(player)
        started = time.monotonic()
        try:
            await self.bridge.say(player, "Thinking...")
            answer = await asyncio.wait_for(self.agent.answer(question, self.memory.get(key), name), self.cfg.ask_timeout)
            self.memory.add(key, question, answer)
            log.info("answer for %s after %.1fs: %s", name, time.monotonic() - started, answer)
            await self.bridge.say(player, answer)
        except asyncio.TimeoutError:
            log.warning("question from %s timed out after %.0fs", name, self.cfg.ask_timeout)
            await self.say_safely(player, "Sorry, that took too long. Please try again.")
        except LLMError as e:
            log.warning("LLM error for %s: %s", name, e)
            if e.rate_limited:
                await self.say_safely(player, "Sorry, the advisor has hit its usage limit. Please try again in a minute.")
            else:
                await self.say_safely(player, "Sorry, the advisor can't think right now. Please try again later.")
        except BridgeError as e:
            log.warning("bridge error while answering %s: %s", name, e)
            await self.say_safely(player, "Sorry, I lost track of the park while thinking. Please try again.")
        except Exception:
            log.exception("error answering %s", name)
            await self.say_safely(player, "Sorry, something went wrong. Please try again.")
        finally:
            self.busy.discard(player)

    async def say_safely(self, player: int, text: str) -> None:
        try:
            await self.bridge.say(player, text)
        except BridgeError:
            log.warning("could not tell player %s: %s", player, text)
