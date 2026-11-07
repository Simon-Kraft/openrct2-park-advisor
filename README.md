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
| `!build <what>` | Propose a stall, e.g. `!build a cheap burger bar near the Big Dipper` (when building is enabled) |
| `!yes` / `!no` | Build or cancel your proposal (it waits 2 minutes) |
| `!undo` | Remove the last thing the bot built for you (admins: the last thing it built) |

## Building

With `BUILD_ENABLED=true` players can ask the bot to build stalls: food, drinks, souvenirs, information kiosks, toilets, ATMs and first aid. It never builds straight away: `!build` replies with a proposal (what, where, price, cost), and only `!yes` builds it.

1. The chat model fills a small form from the request (category, price wish, a ride to build near, open or closed). If it fails, a few keywords still work, and an exact stall name always does.
2. The decision model picks between the matching stalls and a price level when the request doesn't say.
3. Plain code finds the spot: free, flat land the park owns, facing a path, near the named ride or where many guests walk by. It checks the build with the game first, and the plugin removes a half-built stall if a step fails.

Only admins can build, plus the groups in `BUILD_ALLOWED_GROUPS`. Builds are limited per player per hour, by cost, and by a cash reserve the park keeps; see `.env.example`. The plugin's game actions run as the server host, so these checks happen in the helper. What the bot built is remembered only while the helper runs.

## Tests

```sh
npm test
```

The tests load the plugin in a Node harness with stubbed OpenRCT2 globals and talk to the real Python helper. The LLMs are replaced by scripted fakes (`ADVISOR_LLM=fake`).
