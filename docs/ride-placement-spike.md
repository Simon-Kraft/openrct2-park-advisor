# Spike: ride placement build actions (milestone 1)

Findings for `docs/ride-placement-plan.md`, milestone 1. Everything marked **observed** was run in the real game;
**source** means read in the OpenRCT2 v0.5.6 source and not run; **untested** means neither.

## Setup

- OpenRCT2 v0.5.6, plugin API 124 (macOS, same build as the server). The scripting engine is QuickJS.
- A copy of the server's latest autosave (Electric Fields, 103x103), opened with `--headless` and a scratch
  `--user-data-path`, so neither the real plugin folder nor the real config was used.
- A throwaway plugin that evaluated JS sent over `127.0.0.1:11799`, plus `action.query`/`action.execute` hooks for logging.
- **Single-player, not hosted.** The real server was running on the same machine, and a second hosted
  instance crashes at start (`SocketException: Unable to bind to socket`): every server binds the fixed
  LAN discovery UDP port 11754, even with `advertise = false`. So `network.mode` was `"none"`. The hosted-only questions
  are answered from source below and still need one check on a real host (see "Still to verify").

## Working stall build (observed)

This sequence built a Burger Bar that guests bought from (2 customers within about 4000 ticks once guests were hungry).
Tile (24,60), surface `baseZ` 112, footpath on tile (23,60) at z 112.

```js
context.executeAction("ridecreate", {
    rideType: 28,          // object.rideType[0] of rct2.ride.burgb
    rideObject: 1,         // object index (objectManager.getAllObjects("ride")[i].index)
    entranceObject: 0,     // ignored for stalls (only used by ride types with entrance/exit)
    colour1: 0, colour2: 0,// colour preset indices; 9 fails with "Invalid color"
    inspectionInterval: 2  // 0..6
}, function (r) {          // r = {error: 0, cost: 0, expenditureType: "ride_construction", ride: 2}
    context.executeAction("trackplace", {
        x: 24 * 32, y: 60 * 32,  // world units, tile corner
        z: 112,                  // surface baseZ (world units)
        direction: 0,            // toward the path tile (see conventions)
        ride: r.ride,
        trackType: 262,          // flatTrack1x1A
        rideType: 28,            // must equal the ride's type
        brakeSpeed: 0, colour: 0, seatRotation: 4, trackPlaceFlags: 0, isFromTrackDesign: false
    }, function (t) {            // t = {error: 0, cost: 3000, position: {x: 784, y: 1936, z: 112}, ...}
        context.executeAction("ridesetprice", { ride: r.ride, price: 15, isPrimaryPrice: true }, function (p) {
            context.executeAction("ridesetstatus", { ride: r.ride, status: 1 }, function (s) { /* done */ });
        });
    });
});
```

Result: ride 2 "Burger Bar 1" (name assigned by the game), `classification: "stall"`, status `open`, price `[15]` (1.50).
Park cash dropped by exactly 3000 (300.00) at `trackplace`; `ridecreate`, `ridesetprice` and `ridesetstatus` cost 0.
A new ride starts `closed`, so `ridesetstatus` is needed. No entrance or exit is needed for a stall.
The adjacent footpath connected by itself: its `edges` went from 11 to 15, and back to 11 after demolishing.

## Conventions (observed)

- **Coordinates:** action `x`/`y` are world units (tile x 32, tile corner). `GameActionResult.position` is the tile centre (+16).
- **z:** world units, equal to the surface element's `baseZ` on flat land. The game does **not** require z to be at ground level:
  z 128 over land at 112 is accepted and builds a raised stall on supports. z below the surface fails ("Raise or lower land first").
  The plugin must always pass the surface `baseZ`.
- **Direction:** 0 = -x, 1 = +y, 2 = +x, 3 = -y (delta `[[-1,0],[0,1],[1,0],[0,-1]]`). A stall's direction points **toward its path**:
  the existing Balloon Stall at (22,60) has direction 2 and its path at (23,60); the new stall at (24,60) has direction 0 and the
  same path, and it sold. The game accepts a stall facing away from any path (`queryAction` succeeds), so the plugin must compute
  the direction from the adjacent path tile itself. Whether guests can use a stall from its side or back was **untested**; assume not.
- **Ownership:** use `surface.hasOwnership`. The raw `surface.ownership` read 2 on owned land, not the bit flag in the C++ header.
  Land with construction rights but no ownership was **untested**.
- **Money:** internal units of 1/10 currency unit, as in `money()` in the plugin. Price 15 = 1.50.
  `ridesetprice` on a food stall accepts 0..200 (0.00..20.00); -1 and 201 fail with `error: 1` and an **empty** `errorMessage`.

## Ride types, objects and track types

Track types are `TrackElemType` values from `src/openrct2/ride/ted/TrackElemType.h` (v0.5.6), and the per-ride-type start piece
comes from `src/openrct2/ride/rtd/*`. The stall value 262 matches the existing stall's track element, so the numbering is confirmed.

Stalls (all `flatTrack1x1A` = 262 except the kiosk). Object ids as loaded in this park; `rideType` is `object.rideType[0]`.

| Category | rideType | Objects in this park | trackType | Status |
|---|---|---|---|---|
| food | 28 | `rct2.ride.burgb`, `hotds`, `substl`, `cndyf`, `chknug`, `cookst`, `icecr2` | 262 | built (`burgb`) |
| drink | 30 | `rct2.ride.drnks`, `coffs`, `lemst` | 262 | source |
| souvenir (shop) | 32 | `rct2.ride.balln`, `hatst`, `tshrt`, `souvs` | 262 | existing stall read |
| info kiosk | 35 | `rct2.ride.infok` | 264 (`flatTrack1x1B`) | source |
| toilets | 36 | `rct2.ride.tlt1` | 262 | source |
| ATM | 45 | `rct2.ride.atm1` | 262 | source |
| first aid | 48 | `rct2.ride.faid1` | 262 | source |

Flat rides (milestone 5; source unless noted): merry-go-round 33 / `mgr1` / 3x3 = 266 (`trackplace` query succeeded, cost 4600),
twist 46 / `twist1` / 266, circus 49 / 266, haunted house 47 / 266, space rings 41 / 266, top spin / 266,
spiral slide 21 / `hskelt` / 2x2 = 258, dodgems 25 / `dodg1` / 4x4 = 259, ferris wheel 37 / `fwh1` / 1x4C = 265,
magic carpet 77 / 1x4A = 257, pirate ship 26 / `swsh1` / 1x5 = 261, swinging inverter ship 27 / 1x4B = 263.
For flat rides `entranceObject` is a station object index (`objectManager.getAllObjects("station")`; index 0 =
`rct2.station.plain` here). Which tile of a multi-tile footprint `x`/`y` refer to, and entrance/exit placement, were **untested**.

## The game validates less than expected (observed)

The plugin has to enforce these itself:

- **Research is not checked** by `ridecreate` or `trackplace` (source, and a `ridecreate` query for the un-researched
  Cotton Candy Stall succeeded). Use `park.research.isObjectResearched("ride", object.index)`.
- **Ride type vs object is not checked:** `ridecreate` with `rideType: 28` and the Drinks Stall object created a ride of
  type 28 carrying `rct2.ride.drnks`. Always pass `object.rideType[0]`.
- **Track type vs ride type is not checked:** a `trackplace` query with the stall track type 262 on a merry-go-round ride succeeded.
  Take the track type from a fixed table keyed by ride type.
- **Small scenery is removed silently:** placing on a tile with small scenery succeeds and the cost includes clearing it
  (3120 instead of 3000). `find_sites` should skip tiles with scenery, as the plan says, or the bot will delete players' scenery.
- **z and direction** are not checked against the ground or the path (see Conventions).

## Errors (observed)

`trackplace` query results for a food stall (`errorTitle` is "Can’t construct this here…" for all):

| Case | `error` | `errorMessage` |
|---|---|---|
| tile has a ride | 9 | `Burger Bar 1 in the way` |
| tile has a footpath | 9 | `Footpath in the way` |
| land not owned | 2 | `Land not owned by park!` |
| off the map (200,200) | 2 | `Land not owned by park!` |
| water | 9 | `Cannot build partly above and partly below water!` |
| slope, or z below ground | 9 | `Raise or lower land first` |
| cash 10.0 | 4 | `Not enough cash - requires €300.00` (cost still reported: 3000) |
| ride id does not exist | 1 | `Ride not found` |
| ride exists but has another ride type | 1 | empty string |

`ridecreate` with a bad colour preset: `error: 1`, "Invalid color". `ridedemolish` on a missing id: `error: 1`, "Ride not found".
`errorMessage` can be empty or absent, so the plugin needs its own fallback text per step.

## GameActionResult (observed)

Fields seen: `error` (0 = ok), `errorTitle`, `errorMessage`, `cost`, `position`, `expenditureType`, and `ride` on `ridecreate` only.
A `ridecreate` **query** also returns `ride`: the id the next ride would get.

## Callback sequencing

- `queryAction`: the callback runs **synchronously**, before `queryAction` returns (observed).
- `executeAction`, success: the callback runs **later**, after the calling code has returned (observed in single-player).
  On a server, the action is queried, queued, executed on the next game tick, and the callback fires then (source: `GameActionRunner.cpp`).
- `executeAction`, failure in the up-front query: the callback runs **immediately**, synchronously (source, and observed:
  a failing `ridedemolish` issued after a successful one reported first).
- So callbacks from several `executeAction` calls do not come back in call order. Chain each step inside the previous
  step's callback (as above). The `build` tool's `tool_result` must be sent from the last callback, which needs the
  deferred-reply support the plan already describes.

## Rollback and demolish (observed)

- `ridecreate` then a failing `trackplace` leaves a ride with no track (status `closed`, no station start).
  `ridedemolish {ride, modifyType: 0}` removes it (`map.getRide(id)` returns `null` afterwards) at cost 0. Cash is unchanged overall.
- Demolishing the finished stall refunded 2099 of the 3000 (`cost: -2099`), but the **query** for it reported cost 0,
  so the refund for `!undo` is only known after executing.

## Answers to the plan's open questions (section 9)

1. **Permissions, cash, attribution.** Plugin actions are **not permission-checked**: group permissions are only enforced in
   `NetworkBase::ServerHandleGameAction`, for actions arriving from clients (source). They **charge park cash** (observed:
   -3000 at `trackplace`). On a server, a plugin action is attributed to the **host player** (`Enqueue` sets
   `Network::GetCurrentPlayerId()` when the player is -1); in single-player the hooks reported `player: -1` (observed).
   Built-in actions **cannot be attributed to the requesting player**: the args have no player field and only custom actions
   get one (source). So the helper must check who may build, as the plan already says.
2. **Numbers and conventions:** see the tables and Conventions above. Stalls need no entrance or exit (observed).
3. **Faithful dry run: not possible in general.** A `trackplace` query needs an existing ride of the **same ride type**:
   with a missing id it fails "Ride not found"; with another type's ride it fails with an empty message. Reusing the
   existing Balloon Stall (type 32) as a placeholder gave correct blocked/owned results, but its cost (2000) differs from
   the real Burger Bar cost (3000), because cost depends on the ride type.
   Recommendation for milestone 2: the dry run is `ridecreate` query + the plugin's own site checks (owned, flat, dry, free,
   no scenery, path at `tile + delta[direction]` with the same z) + a cash check against a per-ride-type construction cost
   in the catalog (food stall 3000 observed; shop 2000 and merry-go-round 4600 from placeholder queries). When the park already has a ride of the
   same ride type, also run the `trackplace` query with it as a placeholder. The real build rolls back with
   `ridedemolish` on any failure, which was shown to leave nothing behind.
4. **Path adjacency and entrances with `queryAction` only: no.** The game accepts a stall with no path next to it and in
   any direction, so adjacency must be checked in plugin code. Entrance placement for flat rides was **untested** (milestone 5).
5. **Scan performance (observed):** reading every tile's elements and their surface fields took 8 ms on 103x103
   (10,609 tiles) and 42 ms on the same park enlarged to 254x254 (64,516 tiles). That is fine on `!build`, not on every tick.
6. **Save/reload: untested.** Ride ids are stored in the save; the helper's undo stack and proposals are in memory only,
   which the plan accepts.

## Other notes for later milestones

- `trackplace` refuses while the game is paused ("Construction not possible while game is paused") unless the
  build-while-paused cheat is on (source). Give a specific reply for that error.
- The money a plugin build spends is counted towards the host player's "money spent" (source), not the requesting player's.

## Still to verify on a real hosted server

These follow from source. The design does not depend on them, so they are checked on the first real build with the
advisor plugin rather than with a separate test plugin: the build tool logs the tick each step is issued and answered, and
the `action.execute` player id. Expect callbacks one tick or more after the call, player 0 (the host), cash charged as in
single-player, and connected clients seeing the new stall straight away (actions are relayed with `Network::SendGameAction`).
