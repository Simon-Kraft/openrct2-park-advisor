"""Configuration from environment variables (see README)."""

import os
from dataclasses import dataclass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


@dataclass(frozen=True)
class Config:
    bridge_host: str
    bridge_port: int
    llm_mode: str  # "openai" (any OpenAI-compatible API), "fake" or "echo"
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    llm_fallback_model: str
    log_level: str

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            bridge_host=_env("ADVISOR_HOST", "127.0.0.1"),
            bridge_port=int(_env("ADVISOR_PORT", "11780")),
            llm_mode=_env("ADVISOR_LLM", "openai").lower(),
            llm_base_url=_env("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/"),
            llm_api_key=_env("LLM_API_KEY") or _env("GEMINI_API_KEY"),
            llm_model=_env("LLM_MODEL", "gemini-3.8-flash"),
            llm_fallback_model=_env("LLM_FALLBACK_MODEL", "gemini-flash-latest"),
            log_level=_env("ADVISOR_LOG_LEVEL", "INFO").upper(),
        )
