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
var CHUNK = 200;          // max chars per chat message
var RETRY_MS = 5000;      // listener retry delay when the port is busy
var PROTOCOL = 1;

var HELP = "Park Advisor: !ask <question> asks the advisor about the park. " +
    "!reset forgets your conversation. !ping checks the bot. !tool <name> shows raw park data. !help shows this.";

var listener = null;
var conn = null;
var buf = "";
var retryHandle = null;

function log(msg) {
    console.log("[advisor] " + msg);
}

// Split text into chat-sized pieces at word (or comma) boundaries.
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
    }
};

// Positional argument for "!tool <name> <value>".
var TOOL_ARG = { get_ride: "id", get_recent_messages: "limit" };

function runTool(name, args) {
    if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) throw new Error("unknown tool " + name);
    return TOOLS[name](args || {});
}

// ---------------------------------------------------------------- helper messages

function handleMessage(msg) {
    switch (msg.type) {
        case "hello":
            log("helper connected (" + (msg.name || "?") + ")");
            break;
        case "ping":
            send({ type: "pong", id: msg.id });
            break;
        case "say":
            tell(msg.player, msg.text);
            break;
        case "tool_call":
            var reply = { type: "tool_result", id: msg.id };
            try {
                reply.ok = true;
                reply.result = runTool(msg.name, msg.args);
            } catch (e) {
                reply.ok = false;
                reply.error = String(e && e.message || e);
            }
            send(reply);
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
            log("helper disconnected");
        }
    });
    send({ type: "hello", protocol: PROTOCOL, api: context.apiVersion, tools: Object.keys(TOOLS) });
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

var TOOL_CHAT_LIMIT = 1600;  // chars of !tool output sent to chat; the full result goes to the server log

function toolCommand(player, arg) {
    var parts = arg.split(/\s+/).filter(Boolean);
    var name = parts[0];
    if (!name) {
        tell(player, "Usage: !tool <name> [value]. Tools: " + Object.keys(TOOLS).join(", "));
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
