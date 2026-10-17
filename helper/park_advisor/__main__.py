import asyncio
import logging

from .app import Advisor
from .config import Config


def main() -> None:
    cfg = Config.from_env()
    logging.basicConfig(
        level=getattr(logging, cfg.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        asyncio.run(Advisor(cfg).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
