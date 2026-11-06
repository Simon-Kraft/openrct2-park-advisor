"""Configuration from environment variables (see README)."""

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines (optionally prefixed with "export") into os.environ.
    Variables that are already set win, so the real environment can override the file."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


@dataclass(frozen=True)
class Config:
    bridge_host: str
    bridge_port: int
    llm_mode: str  # "local" (Ollama), "fake" (tests) or "echo"
    local_url: str  # Ollama, for local mode
    local_router_model: str  # decision model that picks the tools
    local_answer_model: str  # small chat model that writes the answer
    log_level: str
    rate_limit: int  # questions per player per minute
    ask_timeout: float  # seconds for a whole question, including tool calls

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            bridge_host=_env("ADVISOR_HOST", "127.0.0.1"),
            bridge_port=int(_env("ADVISOR_PORT", "11780")),
            llm_mode=_env("ADVISOR_LLM", "local").lower(),
            local_url=_env("LOCAL_URL", "http://localhost:11434"),
            local_router_model=_env("LOCAL_ROUTER_MODEL", "tev1:0.8b"),
            local_answer_model=_env("LOCAL_ANSWER_MODEL", "qwen3:8b"),
            log_level=_env("ADVISOR_LOG_LEVEL", "INFO").upper(),
            rate_limit=int(_env("ADVISOR_RATE_LIMIT", "4")),
            ask_timeout=float(_env("ADVISOR_ASK_TIMEOUT", "90")),
        )
