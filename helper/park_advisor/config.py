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


def _flag(name: str) -> bool:
    return _env(name, "false").lower() in ("1", "true", "yes", "on")


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
    build_enabled: bool  # players may build stalls with !build
    build_allowed_groups: tuple[str, ...]  # lower-case group names allowed to build, besides admins
    build_max_cost: float  # currency, per build
    build_cash_reserve: float  # currency the park keeps after a build
    build_rate_limit: int  # builds per player per hour
    build_proposal_ttl: float  # seconds a proposal waits for !yes
    build_choose_policy: bool  # let the decision model pick the placement policy

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
            build_enabled=_flag("BUILD_ENABLED"),
            build_allowed_groups=tuple(g.strip().lower() for g in _env("BUILD_ALLOWED_GROUPS").split(",") if g.strip()),
            build_max_cost=float(_env("BUILD_MAX_COST", "1000")),
            build_cash_reserve=float(_env("BUILD_CASH_RESERVE", "500")),
            build_rate_limit=int(_env("BUILD_RATE_LIMIT", "5")),
            build_proposal_ttl=float(_env("BUILD_PROPOSAL_TTL", "120")),
            build_choose_policy=_flag("BUILD_CHOOSE_POLICY"),
        )
