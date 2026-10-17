"""Chat command handling: turns plugin messages into replies."""

import logging

from .bridge import Bridge
from .config import Config

log = logging.getLogger("app")


class Advisor:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.bridge = Bridge(cfg.bridge_host, cfg.bridge_port, self.on_message)

    async def run(self) -> None:
        await self.bridge.run_forever()

    async def on_message(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "hello":
            log.info("plugin hello: protocol %s, API %s", msg.get("protocol"), msg.get("api"))
        elif kind == "ask":
            await self.on_ask(msg["player"], msg.get("name", "?"), msg.get("text", ""))
        elif kind == "reset":
            await self.bridge.say(msg["player"], "OK, I forgot our conversation.")
        else:
            log.debug("ignoring message %s", kind)

    async def on_ask(self, player: int, name: str, question: str) -> None:
        log.info("ask from %s (#%s): %s", name, player, question)
        await self.bridge.say(player, "Thinking...")
        await self.bridge.say(player, f"Echo: {question}")
