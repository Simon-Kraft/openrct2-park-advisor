import asyncio
import logging
import os
import sys
from pathlib import Path

from .app import Advisor
from .config import DEFAULT_ENV_FILE, Config, load_env_file


def main() -> None:
    load_env_file(Path(os.environ.get("ADVISOR_ENV_FILE") or DEFAULT_ENV_FILE))
    cfg = Config.from_env()
    logging.basicConfig(
        level=getattr(logging, cfg.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if cfg.log_level != "DEBUG":  # one "HTTP Request: POST ... 200 OK" line per LLM call
        for name in ("httpx", "httpx2"):
            logging.getLogger(name).setLevel(logging.WARNING)
    if cfg.llm_mode == "openai" and not cfg.llm_api_key:
        logging.error("no API key: set LLM_API_KEY or GEMINI_API_KEY (or ADVISOR_LLM=echo for testing)")
        sys.exit(2)
    try:
        asyncio.run(Advisor(cfg).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
