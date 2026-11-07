# Plan: ride placement (`!build`)

Goal: players on the hosted server type `!build <request>` (e.g. `!build a cheap burger stall near the Big Dipper`)
and the advisor builds it in the park. This plan is written to be implemented by a model in a separate worktree.
Read `README.md`, `plugin/park-advisor.js`, `helper/park_advisor/{agent,app,bridge,llm,config}.py` and `test/harness.js` first;
new code must match their style (comment density, naming, plain functions, no new frameworks).

## 1. Principles

1. **Models never output coordinates, object ids, or API arguments.** They output choices from fixed catalogs.
   All geometry, costs, and action arguments come from plain code.
2. **Two models, two jobs, same as today:**
   - `qwen3:8b` (the answer model): free text -> structured request (slot filling) using a JSON schema; also writes the final reply.
   - `tev1:0.8b` (the decision model, `JevRouter.choose`): picks one option from a short named list with probabilities
     (ride type, price tier, placement policy). It is a classifier, so every question must be a bounded choice.
3. **A fixed policy plus planner decides where.** The planner is a pure function of (site candidates, policy). No model calls inside it.
4. **Plugin stays dumb.** It exposes map reads and a few write primitives. Scoring, policy, catalogs, and the confirm flow live in the helper.
5. **Propose, then confirm.** `!build` never builds directly. It replies with a proposal (what, where, cost). `!yes` builds, `!no` cancels.
6. **Dry-run everything** with `context.queryAction` before `executeAction`.
7. **Start tiny** (stalls, then simple flat rides). Roller coasters and custom track are out of scope for this plan.

## 2. Scope

In scope (milestones below):
- Stalls (food, drink, souvenir, information, ATM, first aid, toilets if supported as a ride type) and simple flat rides with a small fixed footprint (e.g. carousel, ferris wheel).
- Choosing ride type from what the park has researched, price, and open/closed status.
- Placement on free, owned, flat land, next to an existing path, per policy.
- Confirm / cancel / undo, permission checks, rate and cost limits.

Out of scope: coasters and tracked rides, terraforming, building paths, scenery, landscaping, staff hiring, renaming. Say so in `!help` ("I can build stalls and simple flat rides").

## 3. User flow

```
player: !build a cheap burger stall near the big dipper
bot:    Thinking...
bot:    Proposal: Burger Bar at (34,18), price $1.20, open. Cost about $40. Type !yes to build or !no to cancel.
player: !yes
bot:    Built Burger Bar (ride 14) at (34,18), price $1.20, open.
```

Commands (plugin `onChat` + helper `app.py`, same pattern as `!ask`/`!reset`):

| Command | Behavior |
|---|---|
| `!build <request>` | Parse -> choose -> plan -> dry-run -> store a pending proposal for that player -> reply with the proposal |
| `!yes` | Execute the player's pending proposal (expires after 2 minutes) |
| `!no` | Drop the pending proposal |
| `!undo` | Demolish the last thing the bot built (any player may undo only their own build; admins any) |

One pending proposal per player. A new `!build` replaces it. Reuse the existing `busy` set, per-player rate limit and ask timeout.

## 4. Pipeline (helper, new module `helper/park_advisor/builder.py`)

```
!build text
  1. qwen: parse            -> BuildRequest (validated JSON)
  2. code: fetch catalog    -> tool get_buildable (what is researched/available now)
  3. tev:  choose type      -> catalog entry
  4. tev:  choose price tier-> tier -> code maps to a price
  5. code: open/closed rule
  6. code: fetch sites      -> tool find_sites
  7. tev:  choose policy    -> policy name (optional, see 4.6)
  8. code: score + pick     -> Plan
  9. code: dry-run          -> tool build (dry_run=true)
 10. reply with proposal; on !yes -> tool build (dry_run=false)
 11. qwen or template: final confirmation text
```

### 4.1 Parse (qwen)
Use Ollama's structured output: pass a JSON schema as `format` on the chat request (Ollama's native `/api/chat`; the existing
`OllamaChat` uses the OpenAI-compatible endpoint, so add a small `complete_json(messages, schema)` method to `llm.py` that calls
`/api/chat` with `format`, `stream: false`, low temperature, `think: false`). Schema (all enums from code, never free strings except `near`):

```json
{
  "kind":      "stall | flat_ride | unknown",
  "category":  "food | drink | souvenir | info | atm | first_aid | toilet | thrill | gentle | any",
  "near":      "string or null   (a ride name the player mentioned, copied from the question)",
  "price_pref":"free | cheap | standard | premium | unspecified",
  "open":      "open | closed | unspecified",
  "count":     "integer 1..1 (reserved, always 1 for now)"
}
```
Validate in Python; on schema failure or `kind == unknown` reply "I can build stalls and simple flat rides, e.g. !build a cheap burger stall." Resolve `near` against `list_rides` names with the same logic as `Agent.find_ride`; if it matches nothing, ignore it and say so in the proposal.

### 4.2 Catalog (code)
Static table in `builder.py`, keyed by a stable internal name, with: `rideType` number, preferred object identifiers
(OpenRCT2 object identifiers like `rct2.ride.cstall`; verify exact ids in the spike), `kind`, `category`, `footprint` (w, h in tiles),
`needs_entrance` (flat rides yes, stalls no), `description` (short text for tev), and a `price_tiers` table (free/cheap/standard/premium -> money in the park's units,
per type; keep conservative values). The plugin tool `get_buildable` returns which catalog entries are actually available (object loaded + researched + not ride-type-disabled);
filter the catalog by that before asking tev.

### 4.3 Choose type (tev)
`JevRouter.choose(state, instructions, options)` where options = `{catalog_name: description}` for entries matching `kind`/`category` (plus the player's text in `state`).
Take the top option (`p >= PICK_MIN`). If only one entry matches the category, skip the model call. If nothing matches, tell the player what is available.

### 4.4 Choose price tier (tev)
Options: `free`, `cheap`, `standard`, `premium`, each with a one-line description. If `price_pref != unspecified`, skip the call and use it.
Code maps tier -> money from the catalog table. Clamp to the game's allowed range for that ride (plugin returns it or helper hardcodes a safe max).

### 4.5 Open/closed (code)
`open` -> open, `closed` -> closed, `unspecified` -> open. No model.

### 4.6 Placement policy (fixed, optional tev choice)
Policies are deterministic scoring functions over site features (section 5.2):

- `near_target`: minimize distance to the named ride's entrance (needs `near`).
- `near_busy`: maximize nearby guest count / ride queue length.
- `near_junction`: prefer path tiles with 3+ neighbors (stalls).
- `quiet`: away from the park entrance and from other stalls (thrill rides).

Selection: if `near` resolved -> `near_target`; else default by kind (stall -> `near_busy`, flat_ride -> `quiet`).
Optionally let tev choose among 2-3 policy names when the player gave no hint; keep this behind a config flag so it can be dropped if it adds nothing.

### 4.7 Plan
`Plan = {catalog_name, price, open, site: {x, y, z, direction}, entrance?: {...}, exit?: {...}, est_cost}`. Ties break deterministically (lowest x, then y) so tests are stable.
Try the best N (e.g. 5) sites in score order: dry-run each until one succeeds. If none do, report the last error text from the dry run in plain words.

## 5. Plugin changes (`plugin/park-advisor.js`)

Keep the existing `TOOLS` pattern (`runTool`, `handleMessage` `tool_call`). Add read tools and one write tool. Writes must be impossible through `!tool` (extend the `!tool` command to refuse names in a `WRITE_TOOLS` set).

### 5.1 `get_buildable`
Returns `[{rideType, objectId, name, available}]` for every catalog type the park can currently build. Use `objectManager` / `context.getAllObjects("ride")` and research state (`park.research`). Plugin does not know the helper's catalog; the helper passes the list of `objectId`s it cares about as an argument and the plugin answers per id. Include money (`park.cash`) so the helper can refuse unaffordable builds early.

### 5.2 `find_sites`
Args: `{width, height, limit, near?: {x, y}}`. Scan the map (`map.size`, `map.getTile(x, y).elements`) for rectangles of `width x height` tiles that are all:
- owned by the park (`surface.ownership` has owned flag),
- flat (`surface.slope === 0`) and above water (`surface.waterHeight` check),
- free of anything solid (no `footpath`, `track`, `entrance`, `wall`, `large_scenery`, `small_scenery` blocking, no existing ride),
- with at least one edge tile adjacent to a footpath element at compatible height (so guests can reach it).

Return up to `limit` candidates (default 40, hard cap 100) pre-ranked cheaply (by distance to `near` if given), each as
`{x, y, z, adjacent_path: {x, y, direction}, features: {dist_park_entrance, dist_nearest_ride, nearby_guests, nearby_stalls, path_neighbors}}`.
Keep each candidate small; the whole response must stay well under the existing 1 MB receive buffer and run fast (full-map scans per call are fine at map sizes seen in OpenRCT2, but profile on a 250x250 map; cache the result within one tick if needed).
Coordinates cross the protocol in tile units; the plugin converts to world units (x32) when calling actions.

### 5.3 `build`
Args: `{dry_run, rideType, objectId, site: {x, y, z, direction}, price, open, player}`.
Steps for a stall (verify each in the spike against `types/openrct2.d.ts` and the real game):
1. `ridecreate` (`RideCreateArgs`: rideType, rideObject, entranceObject, colour1, colour2, inspectionInterval) -> returns the new ride id.
2. `trackplace` (`TrackPlaceArgs`) with the flat-ride/stall track type at the site.
3. For flat rides: `rideentranceexitplace` for entrance and exit (`isExit` false/true) adjacent to the path.
4. `ridesetprice` (`isPrimaryPrice: true`).
5. `ridesetstatus` (1 = open, 0 = closed).

For `dry_run: true` use `context.queryAction` for each step that does not depend on a created ride id (ride creation must be committed before later steps can be queried, so the dry run is: query `ridecreate`, query `trackplace` with a placeholder ride id, accumulate `cost`). If querying with a placeholder is not reliable, fall back to: dry-run = check `find_sites` still reports the site free + query `ridecreate` only, and make the real build roll back (see below).
Failure handling: if any step fails after `ridecreate`, call `ridedemolish` (`modifyType: 0`) on the new ride and return `{ok: false, error}`. The plugin never leaves a half-built ride behind.
Action callbacks are asynchronous: chain the steps in callbacks and answer the helper's `tool_call` only when the chain finishes (extend the reply path so a tool can reply later; keep `id` matching as in `tool_call`).
Return `{ok, ride_id, cost}`. Cost, errors (`errorMessage`), and the final ride id all come from `GameActionResult`.

### 5.4 `demolish`
Args: `{ride_id}` -> `ridedemolish`. Used only by `!undo`. The helper tracks which rides it built (ids + builder) in memory; refuse to demolish any ride id it did not build.

### 5.5 Permissions and executing context
The plugin type is `remote` (server only). Confirm in the spike which player the executed action is attributed to and whether park permission checks apply. The helper must independently check who may build:
- `BUILD_ALLOWED_GROUPS` or a name whitelist in config (default: admins only), looked up through the plugin (add a `get_player_info` tool: group name, is admin).
- Money check: refuse when `est_cost > park cash - reserve` or `est_cost > BUILD_MAX_COST`.

## 6. Helper changes

- `helper/park_advisor/builder.py` (new): catalog, `parse_request`, `choose_*`, policies, `plan`, pending-proposal store (per player, TTL), undo stack.
- `helper/park_advisor/llm.py`: add `complete_json` and a `FakeLLM`/`FakeRouter` extension for tests (scripted parse results keyed on markers in the question, like the existing `#fail`, `#slow` markers).
- `helper/park_advisor/app.py`: route `build`, `yes`, `no`, `undo` messages next to `ask`/`reset`; reuse rate limiting and the `busy` set; wrap errors with the same specific messages (timeout, LLMError, BridgeError, generic).
- `helper/park_advisor/config.py` + `.env.example`: `BUILD_ENABLED` (default false), `BUILD_ALLOWED_GROUPS`, `BUILD_MAX_COST`, `BUILD_CASH_RESERVE`, `BUILD_RATE_LIMIT` (builds per player per hour), `BUILD_PROPOSAL_TTL`.
- Plugin `onChat`: add `!build`, `!yes`, `!no`, `!undo` to the switch, forwarded like `!ask`. Update `HELP`.
- `README.md`: document the commands and the config.
- Keep all reply messages plain text, short, one chat message (`CHUNK` is 1000 chars).

## 7. Tests (match existing structure: Node harness + real Python helper with fakes)

- `test/harness.js`: extend the stubbed OpenRCT2 globals with a small fake map (tiles with surface/footpath/ownership), `context.queryAction`/`executeAction` that record calls and simulate results (success, "not enough cash", "position blocked"), and `objectManager`.
- `test/build.test.js` (new):
  - `find_sites`: finds a free flat owned rectangle next to a path; ignores water, slopes, unowned land, occupied tiles; respects `limit`.
  - `build` stall happy path: the exact action sequence and arguments; rollback with `ridedemolish` when a later step fails.
  - Write tools are refused through `!tool`.
  - e2e: `!build ...` -> proposal -> `!yes` -> built message; `!no` cancels; expiry; `!undo`; non-admin refused; over cost limit refused; unknown request gives the help text.
- Python unit tests are not used in this repo (tests are Node); put planner logic behind functions that the e2e tests drive through the real helper with `ADVISOR_LLM=fake`.
- Planner determinism test: same candidates -> same pick; each policy picks the expected site in a hand-made layout.
- `npm test` must pass before each milestone is considered done.

## 8. Milestones (each ends with passing tests and a commit)

1. **Spike (read-only first, then one write).** In a scratch hosted park, from the plugin console or a throwaway plugin: verify `ridecreate` + `trackplace` for one stall type produces a working stall; record exact argument values (rideType, object ids, trackType, direction, z), the `GameActionResult` fields, how async callbacks sequence, and which player/permissions apply. Write findings to `docs/ride-placement-spike.md`. Do not build the pipeline until this is done.
2. **Plugin tools.** `get_buildable`, `find_sites`, `build` (stall only), `demolish`, `get_player_info`, `WRITE_TOOLS` guard, plus harness fakes and plugin tests.
3. **Helper pipeline with fakes.** `builder.py`, `complete_json`, command routing, confirm/cancel/undo, limits, fake-LLM e2e tests. No real models yet.
4. **Real models.** Wire qwen parsing and tev choices; tune option texts (short, like `ROUTER_OPTIONS`), thresholds, and the schema prompt on a handful of example requests in English and German (the project answers in the player's language). Log choices at INFO like the router does.
5. **Flat rides.** Footprints, entrance/exit placement, price/status for rides, extra catalog entries.
6. **Hardening.** Soak test on a large map, concurrent players, game restart mid-proposal, docs.

## 9. Open questions to settle in the spike (do not guess)

- Does `executeAction` from a `remote` plugin run with full permissions, and does it charge the park's cash? Is there a way to attribute the build to the requesting player?
- Exact `trackType`/`rideType` numbers and object identifiers for each stall and flat ride in the catalog; correct `z` and `direction` conventions; whether stalls need an entrance/exit (they should not).
- Is a faithful dry run possible for the multi-step build (query with placeholder ride id), or must the plugin roll back after a real attempt?
- Whether footpath adjacency and entrance placement for flat rides can be validated purely with `queryAction`.
- Performance of a full-map `find_sites` scan on large maps.
- Behavior on a game save/reload (ride ids stay valid; the helper's undo stack and pending proposals are in memory only and are dropped when the helper restarts, which is acceptable).

## 10. Risks and mitigations

- **Small-model parse errors:** schema-constrained output, enum-only fields, Python validation, and a confirm step before anything is built.
- **tev picks something odd:** only bounded options, thresholds, and skip the call when there is a single sensible candidate.
- **Griefing/spam builds:** admin-only by default, per-player hourly limit, cost cap, undo restricted to own builds.
- **Half-built rides:** plugin rolls back on any failure after `ridecreate`.
- **Blocking the game thread:** keep `find_sites` bounded and fast; never scan on every chat message, only on `!build`.
- **Feature should be opt-in:** `BUILD_ENABLED=false` by default; the plugin write tools refuse unless the helper announces the feature on `hello`.
