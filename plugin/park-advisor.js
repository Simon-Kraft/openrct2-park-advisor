/// <reference path="../types/openrct2.d.ts" />
// Park Advisor: server-side bridge between multiplayer chat and the Python helper.
//
// This is a "remote" plugin, so OpenRCT2 sends this source to every client.
// Keep it small, put no secrets in it, and run everything only on the server.
//
// Protocol: newline-delimited JSON over TCP on 127.0.0.1:PORT. The plugin
// listens, the helper connects. Only one helper connection is kept; a new one
// replaces the old.

var PORT = 11780;
var CHUNK = 1000;         // max chars per chat message; answers are capped at 600, so they go out whole
var RETRY_MS = 5000;      // listener retry delay when the port is busy
var PROTOCOL = 1;

var HELP = "Park Advisor: !ask <question> asks the advisor about the park. " +
    "!reset forgets your conversation. !ping checks the bot. !tool <name> shows raw park data. !help shows this.";

var listener = null;
var conn = null;
var buf = "";
var retryHandle = null;

function log(msg) {
    console.log("[park-advisor] " + msg);
}

// Split text into chat-sized pieces at word (or comma) boundaries. Only a safety net for very long
// text: the game wraps long lines itself, so short pieces would just look like separate messages.
function chunk(text, max) {
    var rest = String(text).replace(/\s+/g, " ").trim();
    var out = [];
    while (rest.length > max) {
        var cut = Math.max(rest.lastIndexOf(" ", max), rest.lastIndexOf(",", max - 1) + 1);
        if (cut < max / 2) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
}

// Private chat message. "{" starts a format code in OpenRCT2 text, so replace braces.
function tell(player, text) {
    var parts = chunk(String(text).replace(/\{/g, "(").replace(/\}/g, ")"), CHUNK);
    for (var i = 0; i < parts.length; i++) {
        try {
            network.sendMessage(parts[i], [player]);
        } catch (e) {
            log("sendMessage to " + player + " failed: " + e);
            return;
        }
    }
}

function playerName(id) {
    try {
        return network.getPlayer(id).name;
    } catch (e) {
        return "player" + id;
    }
}

function send(obj) {
    if (!conn) return false;
    try {
        // write() returns true when not all bytes could be sent (see ScSocket.hpp).
        if (conn.write(JSON.stringify(obj) + "\n")) log("partial write, message may be truncated");
        return true;
    } catch (e) {
        log("write failed: " + e);
        dropConn();
        return false;
    }
}

function dropConn() {
    var c = conn;
    conn = null;
    buf = "";
    buildEnabled = false;
    if (c) {
        try { c.end(); } catch (e) { /* already closed */ }
    }
}

// ---------------------------------------------------------------- tools
// Read-only. Units are converted here, so the helper and the LLM only ever see
// currency amounts, real ratings and 0-100 percentages.

var MONTHS = ["March", "April", "May", "June", "July", "August", "September", "October"];
var INSPECTION = ["10 min", "20 min", "30 min", "45 min", "60 min", "120 min", "never"];

// Internal money is 1/10 of a pound (Money.hpp); GBP, USD, EUR and others share that rate.
// kMoney64Undefined (INT64_MIN) means "unknown".
function money(v) {
    if (typeof v !== "number" || v <= -9.2e18) return null;
    return Math.round(v) / 10;
}

// Ratings are fixed-point x100; unrated rides hold 0xFFFF, which reads as -1.
function rating(v) {
    return typeof v === "number" && v >= 0 && v < 0xFFFF ? Math.round(v) / 100 : null;
}

function pct(value, max, min) {
    return Math.max(min || 0, Math.min(100, Math.floor(value * 100 / max)));
}

function dateText(year, month, day) {
    return MONTHS[month] + " " + day + ", Year " + year;
}

// Remove OpenRCT2 format codes like {RED} and the curly quotes around thoughts.
function plain(s) {
    return String(s).replace(/\{[A-Z0-9_ ]*\}/g, "").replace(/[“”]/g, "").trim();
}

function formatted(fmt, value) {
    try {
        return plain(context.formatString(fmt, value));
    } catch (e) {
        return null;
    }
}

// Drop null/undefined fields to keep results compact.
function compact(obj) {
    var out = {};
    for (var k in obj) if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
    return out;
}

function objectiveInfo(o) {
    var info = { type: o.type };
    if (o.guests) info.guests = o.guests;
    if (o.year) info.by_end_of_year = o.year;
    if (o.parkValue) info.park_value = money(o.parkValue);
    if (o.monthlyIncome) info.monthly_income = money(o.monthlyIncome);
    if (o.excitement) info.min_excitement = o.excitement / 100;
    if (o.length) info.min_length_m = o.length;
    return info;
}

function rideInfo(r, detailed) {
    var isRide = r.classification === "ride";
    var prices = r.price.map(money);
    var station = r.stations.reduce(function (m, s) { return Math.max(m, s.queueTime); }, 0);
    var info = {
        id: r.id,
        name: r.name,
        type: r.object ? r.object.name : null,
        kind: r.classification,
        status: r.status,
        broken_down: r.breakdown !== "none" && r.breakdown !== "" ? r.breakdown : null,
        excitement: isRide ? rating(r.excitement) : null,
        intensity: isRide ? rating(r.intensity) : null,
        nausea: isRide ? rating(r.nausea) : null,
        price: isRide ? prices[0] : prices,
        customers: r.totalCustomers,
        total_profit: money(r.totalProfit),
        profit_per_hour: money(r.profit),
        running_cost_per_hour: r.runningCost <= -9.2e18 ? null : money(r.runningCost * 16),
        age_months: r.age,
        downtime_pct: isRide ? r.downtime : null,
        // 255 * 5 means "no data yet".
        satisfaction_pct: r.satisfaction <= 100 ? r.satisfaction : null,
        max_queue_min: isRide ? station : null
    };
    if (detailed) {
        info.photo_price = isRide && prices.length > 1 ? prices[1] : null;
        info.income_per_hour = money(r.incomePerHour);
        info.reliability_pct = isRide ? r.reliability : null;
        info.guests_on_ride = r.guestCount;
        info.value = money(r.value);
        info.inspection = isRide ? INSPECTION[r.inspectionInterval] : null;
        if (isRide && rating(r.excitement) !== null) {
            info.stats = {
                max_speed_kmh: Math.round(r.maxSpeed * 1.609),
                avg_speed_kmh: Math.round(r.averageSpeed * 1.609),
                ride_time_s: r.rideTime,
                length_m: Math.round(r.rideLength),
                max_pos_g: r.maxPositiveVerticalGs,
                max_neg_g: r.maxNegativeVerticalGs,
                max_lateral_g: r.maxLateralGs,
                airtime_s: r.totalAirTime,
                drops: r.numDrops,
                highest_drop: formatted("{HEIGHT}", r.highestDropHeight),
                lift_hills: r.numLiftHills
            };
        }
    }
    return compact(info);
}

var TOOLS = {
    get_park_summary: function () {
        var s = scenario;
        var weather = climate.current;
        return compact({
            park: park.name,
            date: dateText(date.year, date.month, date.day),
            cash: money(park.cash),
            loan: money(park.bankLoan),
            max_loan: money(park.maxBankLoan),
            park_rating: park.rating,
            guests_in_park: park.guests,
            guest_soft_cap: park.suggestedGuestMaximum,
            park_value: money(park.value),
            company_value: money(park.companyValue),
            park_open: park.getFlag("open"),
            entrance_fee: park.getFlag("freeParkEntry") ? 0 : money(park.entranceFee),
            pay_per_ride: park.getFlag("freeParkEntry") || park.getFlag("unlockAllPrices"),
            no_money_scenario: park.getFlag("noMoney") || null,
            weather: weather.weather + ", " + weather.temperature + " C",
            weather_next: climate.future.weather,
            awards: park.awards.map(function (a) { return (a.positive ? "+ " : "- ") + plain(a.text); }),
            scenario: {
                name: s.name,
                status: s.status,
                objective: objectiveInfo(s.objective)
            }
        });
    },

    list_rides: function () {
        return map.rides.map(function (r) { return rideInfo(r, false); });
    },

    get_ride: function (args) {
        var id = Number(args && args.id);
        var r = isFinite(id) ? map.getRide(id) : null;
        if (!r) throw new Error("no ride with id " + (args && args.id));
        return rideInfo(r, true);
    },

    get_guest_overview: function () {
        var guests = map.getAllEntities("guest");
        var n = 0, lost = 0, sum = { happiness: 0, energy: 0, hunger: 0, thirst: 0, nausea: 0, toilet: 0, cash: 0 };
        var thoughts = {};
        for (var i = 0; i < guests.length; i++) {
            var g = guests[i];
            if (!g.isInPark) continue;
            n++;
            if (g.isLost) lost++;
            // Same normalisation as the guest window's stat bars (windows/Guest.cpp).
            sum.happiness += pct(g.happiness, 255, 3);
            sum.energy += pct(g.energy - 32, 96, 3);
            sum.hunger += 100 - pct(g.hunger - 32, 158);
            sum.thirst += 100 - pct(g.thirst - 32, 158);
            sum.nausea += pct(g.nausea - 32, 223);
            sum.toilet += pct(g.toilet - 64, 178);
            sum.cash += g.cash;
            var th = g.thoughts;
            for (var j = 0; j < th.length; j++) {
                var t = plain(th[j].toString());
                if (t) thoughts[t] = (thoughts[t] || 0) + 1;
            }
        }
        var avg = {};
        for (var k in sum) avg[k] = n ? Math.round(sum[k] / n) : null;
        avg.cash = n ? money(sum.cash / n) : null;
        var top = Object.keys(thoughts)
            .sort(function (a, b) { return thoughts[b] - thoughts[a]; })
            .slice(0, 15)
            .map(function (t) { return { thought: t, guests: thoughts[t] }; });
        return {
            guests_in_park: n,
            guests_lost: lost,
            averages_pct: { happiness: avg.happiness, energy: avg.energy, hunger: avg.hunger, thirst: avg.thirst,
                nausea: avg.nausea, toilet: avg.toilet },
            average_cash: avg.cash,
            litter_on_map: map.getAllEntities("litter").length,
            top_thoughts: top
        };
    },

    get_staff: function () {
        var counts = { handyman: 0, mechanic: 0, security: 0, entertainer: 0 };
        var staff = map.getAllEntities("staff");
        for (var i = 0; i < staff.length; i++) counts[staff[i].staffType] = (counts[staff[i].staffType] || 0) + 1;
        counts.total = staff.length;
        return counts;
    },

    get_recent_messages: function (args) {
        var limit = Math.max(1, Math.min(30, Math.floor(Number(args && args.limit) || 10)));
        var msgs = park.messages.map(function (m, i) {
            return { m: m.month, d: m.day, recent: !m.isArchived, i: i, type: m.type, text: m.text };
        });
        // Newest first: by date, then the recent queue before the archive, then later entries first.
        msgs.sort(function (a, b) {
            return (b.m - a.m) || (b.d - a.d) || (Number(b.recent) - Number(a.recent)) || (b.i - a.i);
        });
        return msgs.slice(0, limit).map(function (x) {
            return { date: dateText(Math.floor(x.m / 8) + 1, x.m % 8, x.d), type: x.type, text: plain(x.text) };
        });
    },

    // For building, see below.
    get_buildable: buildable,
    find_sites: findSites,
    get_player_info: playerInfo
};

// ---------------------------------------------------------------- building
// Map reads for placing stalls, and the write tools that build and demolish them. The helper
// decides what and where; these only check and execute. Why each check is needed (the game
// itself accepts much of this) is in docs/ride-placement-spike.md.

var DELTA = [[-1, 0], [0, 1], [1, 0], [0, -1]];   // direction 0..3 as tile offsets
var ENTRANCE_PARK = 2;          // EntranceElement.object: 0 ride entrance, 1 ride exit, 2 park entrance
var SITE_RADIUS = 5;            // tiles counted for the nearby_* site features
var MAX_SITES = 100;
var MAX_PRICE = 20;             // currency; ridesetprice accepts 0..200 internal units
var BUILD_TIMEOUT_MS = 30000;   // give up on a build whose callbacks never come back

var buildEnabled = false;       // set by the helper's hello
var building = null;            // the build in progress: {ride, player}

function onMap(x, y) {
    return x >= 1 && y >= 1 && x < map.size.x - 1 && y < map.size.y - 1;
}

// Nothing on the tile but flat, dry land the park owns. Scenery counts as taken: the game
// would clear it silently.
function freeLand(x, y) {
    if (!onMap(x, y)) return null;
    var els = map.getTile(x, y).elements;
    var s = els.length === 1 ? els[0] : null;
    return s && s.type === "surface" && s.hasOwnership && s.slope === 0 && !s.waterHeight ? s : null;
}

// A flat, non-queue footpath at height z.
function flatPath(x, y, z) {
    if (!onMap(x, y)) return null;
    var els = map.getTile(x, y).elements;
    for (var i = 0; i < els.length; i++) {
        var e = els[i];
        if (e.type === "footpath" && e.baseZ === z && e.slopeDirection === null && !e.isQueue) return e;
    }
    return null;
}

function bitCount(n) {
    var c = 0;
    for (; n; n >>= 1) c += n & 1;
    return c;
}

// A 1x1 site for a stall: free land with a path next to it. The stall faces the path (the game
// accepts any direction); with several paths, the busiest junction wins, then the lowest direction.
function stallSite(x, y) {
    var s = freeLand(x, y);
    if (!s) return null;
    var best = null;
    for (var d = 0; d < 4; d++) {
        var p = flatPath(x + DELTA[d][0], y + DELTA[d][1], s.baseZ);
        var n = p ? bitCount(p.edges & 15) : -1;
        if (p && (!best || n > best.path_neighbors)) {
            best = { x: x, y: y, z: s.baseZ, direction: d, path: { x: x + DELTA[d][0], y: y + DELTA[d][1] }, path_neighbors: n };
        }
    }
    return best;
}

function tileOf(pos) {
    return pos ? { x: Math.floor(pos.x / 32), y: Math.floor(pos.y / 32) } : null;
}

function rideTile(r) {
    for (var i = 0; i < r.stations.length; i++) {
        var st = r.stations[i];
        if (st.entrance || st.start) return tileOf(st.entrance || st.start);
    }
    return null;
}

function nearest(x, y, points) {
    var best = null;
    for (var i = 0; i < points.length; i++) {
        var d = Math.abs(points[i].x - x) + Math.abs(points[i].y - y);
        if (best === null || d < best) best = d;
    }
    return best;
}

// Points per tile, so counting around a site costs the same however many guests there are.
function grid(points) {
    var g = {};
    for (var i = 0; i < points.length; i++) {
        var k = points[i].x * 100000 + points[i].y;
        g[k] = (g[k] || 0) + 1;
    }
    return g;
}

function countNear(x, y, g) {
    var n = 0;
    for (var dx = -SITE_RADIUS; dx <= SITE_RADIUS; dx++) {
        for (var dy = -SITE_RADIUS; dy <= SITE_RADIUS; dy++) n += g[(x + dx) * 100000 + y + dy] || 0;
    }
    return n;
}

var SITE_SORT = ["dist_near", "dist_park_entrance", "dist_nearest_ride", "nearby_guests", "nearby_stalls", "path_neighbors"];

function findSites(args) {
    if ((args.width || 1) !== 1 || (args.height || 1) !== 1) throw new Error("only 1x1 sites are supported");
    var limit = Math.max(1, Math.min(MAX_SITES, Math.floor(Number(args.limit) || 40)));
    var near = null;
    if (args.near_ride !== undefined && args.near_ride !== null) {
        var target = map.getRide(Number(args.near_ride));
        if (!target) throw new Error("no ride with id " + args.near_ride);
        near = rideTile(target);
    }
    var sort = near ? "dist_near" : args.sort || null;
    if (sort !== null && SITE_SORT.indexOf(sort) < 0) throw new Error("unknown sort " + sort);

    // One pass over the map for paths and park entrances, then only the land next to paths is
    // looked at: far fewer tile reads than checking every free tile for a path.
    var entrances = [], paths = [], rides = [], stalls = [], guests = [], byTile = {};
    for (var x = 0; x < map.size.x; x++) {
        for (var y = 0; y < map.size.y; y++) {
            var els = map.getTile(x, y).elements;
            for (var i = 0; i < els.length; i++) {
                var e = els[i];
                if (e.type === "entrance" && e.object === ENTRANCE_PARK) entrances.push({ x: x, y: y });
                if (e.type === "footpath" && e.slopeDirection === null && !e.isQueue) {
                    paths.push({ x: x, y: y, z: e.baseZ, n: bitCount(e.edges & 15) });
                }
            }
        }
    }
    paths.forEach(function (p) {
        for (var d = 0; d < 4; d++) {
            var sx = p.x - DELTA[d][0], sy = p.y - DELTA[d][1];   // the stall at sx,sy faces d, toward p
            var s = freeLand(sx, sy);
            if (!s || s.baseZ !== p.z) continue;
            var key = sx * 100000 + sy, old = byTile[key];
            // Same choice as stallSite: the busiest path, then the lowest direction.
            if (!old || p.n > old.path_neighbors || (p.n === old.path_neighbors && d < old.direction)) {
                byTile[key] = { x: sx, y: sy, z: s.baseZ, direction: d, path: { x: p.x, y: p.y }, path_neighbors: p.n };
            }
        }
    });
    var sites = Object.keys(byTile).map(function (k) { return byTile[k]; });
    map.rides.forEach(function (r) {
        var t = rideTile(r);
        if (t) (r.classification === "ride" ? rides : stalls).push(t);
    });
    map.getAllEntities("guest").forEach(function (g) {
        if (g.isInPark && isFinite(g.x)) guests.push(tileOf(g));
    });
    var guestGrid = grid(guests), stallGrid = grid(stalls);

    sites.forEach(function (s) {
        s.features = compact({
            dist_near: near ? Math.abs(near.x - s.x) + Math.abs(near.y - s.y) : null,
            dist_park_entrance: nearest(s.x, s.y, entrances),
            dist_nearest_ride: nearest(s.x, s.y, rides),
            nearby_guests: countNear(s.x, s.y, guestGrid),
            nearby_stalls: countNear(s.x, s.y, stallGrid),
            path_neighbors: s.path_neighbors
        });
        delete s.path_neighbors;
    });
    // Ascending distances, descending counts; ties by position so results are stable.
    var desc = sort && sort.indexOf("dist_") !== 0;
    sites.sort(function (a, b) {
        if (sort) {
            var fa = a.features[sort], fb = b.features[sort];
            if (fa === undefined) fa = desc ? -1 : 1e9;
            if (fb === undefined) fb = desc ? -1 : 1e9;
            if (fa !== fb) return desc ? fb - fa : fa - fb;
        }
        return (a.x - b.x) || (a.y - b.y);
    });
    return { total: sites.length, near: near, sites: sites.slice(0, limit) };
}

function rideObject(identifier) {
    var objs = objectManager.getAllObjects("ride");
    for (var i = 0; i < objs.length; i++) if (objs[i].identifier === identifier) return objs[i];
    return null;
}

function buildable(args) {
    var types = args.ride_types || null;
    var objects = objectManager.getAllObjects("ride").filter(function (o) {
        return (!types || types.indexOf(o.rideType[0]) >= 0) && park.research.isObjectResearched("ride", o.index);
    }).map(function (o) {
        return { object: o.identifier, name: o.name, ride_type: o.rideType[0] };
    });
    return {
        cash: money(park.cash),
        no_money: park.getFlag("noMoney"),
        max_price: MAX_PRICE,
        objects: objects
    };
}

function playerInfo(args) {
    var p = network.getPlayer(Number(args.player));
    var group = network.getGroup(p.group);
    return {
        id: p.id,
        name: p.name,
        group: group ? group.name : null,
        // Only the admin group can modify groups by default; a renamed admin group still counts.
        is_admin: !!group && group.permissions.indexOf("modify_groups") >= 0
    };
}

function resultError(r) {
    return plain(r.errorMessage || r.errorTitle || "error " + r.error);
}

// Check a build request and find the object; throws with a message for the player.
function checkBuild(args) {
    if (!buildEnabled) throw new Error("building is disabled");
    if (building) throw new Error("another build is in progress");
    var obj = rideObject(args.object);
    if (!obj || !park.research.isObjectResearched("ride", obj.index)) throw new Error(args.object + " is not available");
    if (obj.rideType[0] !== args.ride_type) throw new Error(args.object + " is not ride type " + args.ride_type);
    var price = Number(args.price);
    if (!(price >= 0 && price <= MAX_PRICE)) throw new Error("price must be between 0 and " + MAX_PRICE);
    var site = stallSite(args.x, args.y);
    if (!site || site.z !== args.z) throw new Error("that spot is not free any more");
    var d = DELTA[args.direction];
    if (!d || !flatPath(args.x + d[0], args.y + d[1], args.z)) throw new Error("there is no path in front of that spot");
    return obj;
}

function trackArgs(args, ride) {
    return {
        x: args.x * 32, y: args.y * 32, z: args.z, direction: args.direction, ride: ride,
        trackType: args.track_type, rideType: args.ride_type,
        brakeSpeed: 0, colour: 0, seatRotation: 4, trackPlaceFlags: 0, isFromTrackDesign: false
    };
}

// Without a ride of the same type to borrow, the game cannot query track placement (see the
// spike), so the cost stays unknown and the helper estimates it.
function dryRunBuild(args, obj, done) {
    var createArgs = { rideType: args.ride_type, rideObject: obj.index, entranceObject: 0, colour1: 0, colour2: 0,
        inspectionInterval: 2 };
    context.queryAction("ridecreate", createArgs, function (r) {
        if (r.error) return done(new Error(resultError(r)));
        var same = map.rides.filter(function (x) { return x.type === args.ride_type; })[0];
        if (!same) return done(null, { dry_run: true, cost: null, cash: money(park.cash) });
        context.queryAction("trackplace", trackArgs(args, same.id), function (t) {
            if (t.error) return done(new Error(resultError(t)));
            done(null, { dry_run: true, cost: money(t.cost), cash: money(park.cash) });
        });
    });
}

// ridecreate -> trackplace -> ridesetprice -> ridesetstatus, each in the previous callback
// (callbacks do not come back in call order). Any failure after ridecreate demolishes the ride.
function executeBuild(args, obj, player, done) {
    var started = date.ticksElapsed;
    var cost = 0;
    var job = building = { ride: null, player: null };
    var timer = context.setTimeout(function () { finish(new Error("the game did not answer")); }, BUILD_TIMEOUT_MS);

    function finish(err, result) {
        if (building !== job) return;
        building = null;
        context.clearTimeout(timer);
        if (err && job.ride !== null) {
            context.executeAction("ridedemolish", { ride: job.ride, modifyType: 0 }, function (d) {
                log("build rolled back ride " + job.ride + (d.error ? " FAILED: " + resultError(d) : ""));
            });
        }
        done(err, result);
    }

    function step(name, stepArgs, next) {
        context.executeAction(name, stepArgs, function (r) {
            if (building !== job) {   // timed out meanwhile; don't leave a late ride behind
                if (name === "ridecreate" && !r.error) context.executeAction("ridedemolish", { ride: r.ride, modifyType: 0 });
                return;
            }
            if (r.error) {
                log("build: " + name + " failed: " + resultError(r));
                return finish(new Error(resultError(r)));
            }
            cost += r.cost || 0;
            next(r);
        });
    }

    step("ridecreate", { rideType: args.ride_type, rideObject: obj.index, entranceObject: 0, colour1: 0, colour2: 0,
        inspectionInterval: 2 }, function (c) {
        job.ride = c.ride;
        step("trackplace", trackArgs(args, c.ride), function () {
            step("ridesetprice", { ride: c.ride, price: Math.round(Number(args.price) * 10), isPrimaryPrice: true }, function () {
                step("ridesetstatus", { ride: c.ride, status: args.open === false ? 0 : 1 }, function () {
                    var ride = map.getRide(c.ride);
                    log("built " + ride.name + " (ride " + c.ride + ") at " + args.x + "," + args.y + " for " + playerName(player) +
                        ", cost " + money(cost) + ", took " + (date.ticksElapsed - started) + " ticks, actions ran as player " +
                        job.player);
                    finish(null, { ride_id: c.ride, name: ride.name, cost: money(cost), status: ride.status });
                });
            });
        });
    });
}

var WRITE_TOOLS = {
    build: function (args, done) {
        var obj = checkBuild(args);
        if (args.dry_run) dryRunBuild(args, obj, done);
        else executeBuild(args, obj, args.player, done);
    },

    demolish: function (args, done) {
        if (!buildEnabled) throw new Error("building is disabled");
        var ride = map.getRide(Number(args.ride_id));
        if (!ride) throw new Error("no ride with id " + args.ride_id);
        var name = ride.name;
        context.executeAction("ridedemolish", { ride: ride.id, modifyType: 0 }, function (r) {
            if (r.error) return done(new Error(resultError(r)));
            log("demolished " + name + " (ride " + ride.id + ")");
            done(null, { ride_id: ride.id, name: name, refund: money(-(r.cost || 0)) });
        });
    }
};

// Which player the game runs our actions as: the host when hosting (see the spike).
function onActionExecute(e) {
    if (building && e.action === "ridecreate") building.player = e.player;
}

// Positional argument for "!tool <name> <value>".
var TOOL_ARG = { get_ride: "id", get_recent_messages: "limit", get_player_info: "player" };

function runTool(name, args) {
    if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) throw new Error("unknown tool " + name);
    return TOOLS[name](args || {});
}

// Answer a tool call with done(err, result), later for the write tools.
function callTool(name, args, done) {
    var answered = false;
    function once(err, result) {
        if (answered) return;
        answered = true;
        done(err, result);
    }
    try {
        if (Object.prototype.hasOwnProperty.call(WRITE_TOOLS, name)) WRITE_TOOLS[name](args || {}, once);
        else once(null, runTool(name, args));
    } catch (e) {
        once(e);
    }
}

// ---------------------------------------------------------------- helper messages

function handleMessage(msg) {
    switch (msg.type) {
        case "hello":
            buildEnabled = msg.build === true;
            log("helper connected (" + (msg.name || "?") + ")" + (buildEnabled ? ", building enabled" : ""));
            break;
        case "ping":
            send({ type: "pong", id: msg.id });
            break;
        case "say":
            tell(msg.player, msg.text);
            break;
        case "tool_call":
            callTool(msg.name, msg.args, function (err, result) {
                var reply = { type: "tool_result", id: msg.id, ok: !err };
                if (err) reply.error = String(err && err.message || err);
                else reply.result = result;
                send(reply);
            });
            break;
        default:
            log("unknown message type: " + msg.type);
    }
}

function onData(data) {
    buf += data;
    var nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
        var line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        var msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            log("bad JSON from helper: " + line.slice(0, 80));
            continue;
        }
        try {
            handleMessage(msg);
        } catch (e) {
            log("error handling " + msg.type + ": " + e);
        }
    }
    if (buf.length > 1000000) {
        log("receive buffer overflow, dropping helper");
        dropConn();
    }
}

function onConnection(socket) {
    if (conn) {
        log("new helper connection replaces the old one");
        dropConn();
    }
    conn = socket;
    buf = "";
    socket.setNoDelay(true);
    socket.on("data", onData);
    socket.on("error", function (err) { log("socket error: " + err); });
    socket.on("close", function () {
        if (conn === socket) {
            conn = null;
            buf = "";
            buildEnabled = false;
            log("helper disconnected");
        }
    });
    send({ type: "hello", protocol: PROTOCOL, api: context.apiVersion,
        tools: Object.keys(TOOLS).concat(Object.keys(WRITE_TOOLS)) });
}

// listen() throws if the port is in use, and a closed listener cannot be reused,
// so each attempt creates a fresh one.
function startListener() {
    retryHandle = null;
    var l = network.createListener();
    l.on("connection", onConnection);
    try {
        l.listen(PORT, "127.0.0.1");
        listener = l;
        log("listening on 127.0.0.1:" + PORT);
    } catch (e) {
        try { l.close(); } catch (e2) { /* ignore */ }
        log("cannot listen on " + PORT + " (" + e + "), retrying in " + RETRY_MS / 1000 + "s");
        retryHandle = context.setTimeout(startListener, RETRY_MS);
    }
}

// ---------------------------------------------------------------- chat commands

function onChat(e) {
    var text = String(e.message || "").trim();
    if (text.charAt(0) !== "!") return;
    var sp = text.indexOf(" ");
    var cmd = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    var arg = sp < 0 ? "" : text.slice(sp + 1).trim();
    var player = e.player;

    // Reply on the next tick, so the player's own message shows up first.
    function later(fn) { context.setTimeout(fn, 0); }

    switch (cmd) {
        case "!ping":
            later(function () { tell(player, "pong" + (conn ? "" : " (advisor helper offline)")); });
            break;
        case "!help":
            later(function () { tell(player, HELP); });
            break;
        case "!tool":
            later(function () { toolCommand(player, arg); });
            break;
        case "!ask":
        case "!reset":
            later(function () {
                if (cmd === "!ask" && !arg) {
                    tell(player, "Usage: !ask <question>");
                } else if (!send({ type: cmd.slice(1), player: player, name: playerName(player), text: arg })) {
                    tell(player, "Sorry, the park advisor is offline right now.");
                }
            });
            break;
    }
}

var TOOL_CHAT_LIMIT = 950;   // chars of !tool output sent to chat; the full result goes to the server log

function toolCommand(player, arg) {
    var parts = arg.split(/\s+/).filter(Boolean);
    var name = parts[0];
    if (!name) {
        tell(player, "Usage: !tool <name> [value]. Tools: " + Object.keys(TOOLS).join(", "));
        return;
    }
    if (Object.prototype.hasOwnProperty.call(WRITE_TOOLS, name)) {
        tell(player, "!tool only shows park data; " + name + " changes the park, use !build instead.");
        return;
    }
    var args = {};
    if (parts[1] !== undefined && TOOL_ARG[name]) args[TOOL_ARG[name]] = Number(parts[1]);
    var out;
    try {
        out = JSON.stringify(runTool(name, args));
    } catch (e) {
        tell(player, "!tool " + name + " failed: " + (e && e.message || e));
        return;
    }
    log("!tool " + name + " by " + playerName(player) + ": " + out);
    if (out.length > TOOL_CHAT_LIMIT) {
        out = out.slice(0, TOOL_CHAT_LIMIT) + " ... (" + out.length + " chars, full output in the server console)";
    }
    tell(player, out);
}

function main() {
    if (network.mode !== "server") return;
    context.subscribe("network.chat", onChat);
    context.subscribe("action.execute", onActionExecute);
    startListener();
}

registerPlugin({
    name: "ParkAdvisor",
    version: "0.2.0",
    authors: ["Simon"],
    type: "remote",
    licence: "MIT",
    targetApiVersion: 124,
    main: main
});
