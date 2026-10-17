"""TCP client for the plugin's newline-delimited JSON bridge, with automatic reconnect."""

import asyncio
import json
import logging
from typing import Awaitable, Callable

log = logging.getLogger("bridge")

Handler = Callable[[dict], Awaitable[None]]

PING_INTERVAL = 20.0
PING_TIMEOUT = 10.0
MAX_LINE = 4 * 1024 * 1024


class BridgeError(Exception):
    pass


class Bridge:
    def __init__(self, host: str, port: int, on_message: Handler):
        self.host = host
        self.port = port
        self.on_message = on_message
        self._writer: asyncio.StreamWriter | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._next_id = 0
        self._tasks: set[asyncio.Task] = set()

    @property
    def connected(self) -> bool:
        return self._writer is not None

    async def run_forever(self) -> None:
        delay = 1.0
        while True:
            try:
                reader, writer = await asyncio.open_connection(self.host, self.port, limit=MAX_LINE)
            except OSError as e:
                log.debug("connect to %s:%s failed: %s", self.host, self.port, e)
                if delay == 1.0:
                    log.info("waiting for the OpenRCT2 server on %s:%s ...", self.host, self.port)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 10.0)
                continue
            delay = 1.0
            log.info("connected to plugin at %s:%s", self.host, self.port)
            self._writer = writer
            pinger = asyncio.create_task(self._heartbeat())
            try:
                await self.send({"type": "hello", "name": "park-advisor-helper"})
                await self._read_loop(reader)
            except (OSError, BridgeError, asyncio.IncompleteReadError, ValueError) as e:
                log.warning("connection lost: %s", e)
            finally:
                pinger.cancel()
                self._writer = None
                writer.close()
                self._fail_pending("bridge disconnected")
            log.info("disconnected from plugin, reconnecting")
            await asyncio.sleep(1.0)

    async def _read_loop(self, reader: asyncio.StreamReader) -> None:
        while True:
            line = await reader.readline()
            if not line:
                return
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                log.warning("bad JSON from plugin: %r", line[:120])
                continue
            if not isinstance(msg, dict):
                continue
            rid = msg.get("id")
            if msg.get("type") in ("pong", "tool_result") and rid in self._pending:
                fut = self._pending.pop(rid)
                if not fut.done():
                    fut.set_result(msg)
                continue
            # Handle each message in its own task, so a slow LLM call never blocks the reader.
            task = asyncio.create_task(self._dispatch(msg))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _dispatch(self, msg: dict) -> None:
        try:
            await self.on_message(msg)
        except Exception:
            log.exception("error handling %s", msg.get("type"))

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(PING_INTERVAL)
            try:
                await self.request({"type": "ping"}, PING_TIMEOUT)
            except BridgeError as e:
                log.warning("heartbeat failed (%s), dropping connection", e)
                if self._writer:
                    self._writer.close()
                return

    async def send(self, obj: dict) -> None:
        if self._writer is None:
            raise BridgeError("not connected")
        # ensure_ascii: the plugin receives raw chunks, and a multi-byte UTF-8
        # character split across two chunks would be corrupted.
        data = json.dumps(obj, ensure_ascii=True, separators=(",", ":")) + "\n"
        self._writer.write(data.encode("ascii"))
        await self._writer.drain()

    async def request(self, obj: dict, timeout: float) -> dict:
        """Send a message with a fresh id and wait for the reply carrying the same id."""
        self._next_id += 1
        rid = self._next_id
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self.send({**obj, "id": rid})
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise BridgeError(f"{obj.get('type')} timed out after {timeout:.0f}s") from None
        finally:
            self._pending.pop(rid, None)

    async def say(self, player: int, text: str) -> None:
        await self.send({"type": "say", "player": player, "text": text})

    def _fail_pending(self, reason: str) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(BridgeError(reason))
        self._pending.clear()

