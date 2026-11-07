# OpenRCT2 Park Advisor

A chat bot for OpenRCT2 multiplayer servers. Players type `!ask <question>` in the game chat and get a short answer based on the live state of the park.

There are two parts:

- **`plugin/park-advisor.js`**: a server-side OpenRCT2 plugin (tested on v0.5.6). It handles the chat commands and reads the park through read-only tools: park summary, ride list, ride details, guests, staff, recent news, and for building: buildable stalls, free sites next to paths, player info. Two write tools build and demolish stalls; only the helper can call them, and only when building is enabled. It listens on `127.0.0.1:11780`.
- **`helper/`**: a Python program that connects to the plugin and answers questions with an LLM.

## How questions are answered

Everything runs on the server through [Ollama](https://ollama.com):

1. A decision model (`tev1:0.8b`, through `/v1/systemone`) picks the park data the question needs. Keywords and ride names add anything it misses.
2. The helper fetches the data and trims it to a short text.
3. A chat model (`qwen3:8b` by default, set `LOCAL_ANSWER_MODEL=gemma3:1b` for a lighter one) writes the answer in one call.

Answers are plain text, at most about 3 sentences, in the language of the question. Each player's last 3 questions are remembered for 15 minutes. Each player can ask 4 questions per minute.

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env              # then edit it
ollama pull tev1:0.8b && ollama pull qwen3:8b   # local mode needs Ollama 0.35 or newer; optional: ollama pull gemma3:1b
./deploy.sh                       # copies the plugin to the OpenRCT2 plugin folder
```

OpenRCT2 doesn't reload plugins while hosting, so restart the server after each deploy. Then start the helper:

```sh
cd helper && ../.venv/bin/python -m park_advisor
```

## Chat commands

| Command | Description |
|---|---|
| `!ask <question>` | Ask the advisor about the park |
| `!reset` | Forget your conversation |
| `!ping` | Check that the bot is running |
| `!tool <name> [arg]` | Show raw tool output, for debugging |
| `!help` | List the commands |

## Tests

```sh
npm test
```

The tests load the plugin in a Node harness with stubbed OpenRCT2 globals and talk to the real Python helper. The LLMs are replaced by scripted fakes (`ADVISOR_LLM=fake`).
