// Plugin tools against the fake park: unit conversion, sentinels, aggregation,
// and the tool_call protocol / !tool command.
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { loadPlugin } = require("./harness");
const { makePark } = require("./fixtures");

const PORT = 23780 + Math.floor(Math.random() * 1000);
const ALICE = 1;
const plugin = loadPlugin({ port: PORT, globals: makePark() });
let client = null;

after(() => {
    if (client) client.sock.destroy();
    plugin.close();
});

/** Minimal NDJSON client playing the helper's role. */
function connect() {
    return new Promise((resolve, reject) => {
        const sock = net.connect(PORT, "127.0.0.1");
        const waiting = new Map();
        let buf = "";
        let hello = null;
        sock.on("data", (d) => {
            buf += d.toString("utf8");
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const msg = JSON.parse(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                if (msg.type === "hello") { hello = msg; resolve(api); }
                else if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
            }
        });
        sock.on("error", reject);
        let id = 0;
        const api = {
            sock,
            get hello() { return hello; },
            call(name, args) {
                const rid = ++id;
                return new Promise((res) => {
                    waiting.set(rid, res);
                    sock.write(JSON.stringify({ type: "tool_call", id: rid, name, args }) + "\n");
                });
            },
        };
    });
}

async function tool(name, args) {
    if (!client) client = await connect();
    const r = await client.call(name, args);
    assert.equal(r.ok, true, r.error);
    return r.result;
}

test("hello lists the tools", async () => {
    client = await connect();
    assert.deepEqual(client.hello.tools, [
        "get_park_summary", "list_rides", "get_ride", "get_guest_overview", "get_staff", "get_recent_messages",
    ]);
    assert.equal(client.hello.api, 124);
});

test("get_park_summary converts money and reads flags", async () => {
    const s = await tool("get_park_summary");
    assert.equal(s.park, "Simon's Park");
    assert.equal(s.date, "April 17, Year 2");
    assert.equal(s.cash, 12345.6);
    assert.equal(s.loan, 10000);
    assert.equal(s.max_loan, 20000);
    assert.equal(s.park_value, 45678);
    assert.equal(s.company_value, 35678);
    assert.equal(s.entrance_fee, 15);
    assert.equal(s.park_rating, 642);
    assert.equal(s.pay_per_ride, false);
    assert.equal(s.no_money_scenario, undefined);
    assert.equal(s.weather, "rain, 14 C");
    assert.deepEqual(s.awards, ["+ Most tidy park", "- Worst food"]);
    assert.deepEqual(s.scenario, {
        name: "Forest Frontiers", status: "inProgress",
        objective: { type: "guestsBy", guests: 1200, by_end_of_year: 3 },
    });
});

test("list_rides: ratings, unrated sentinel, stalls, unknown values", async () => {
    const rides = await tool("list_rides");
    assert.equal(rides.length, 5);
    const [dipper, unrated, carousel, burger, toilets] = rides;

    assert.equal(dipper.excitement, 6.52);
    assert.equal(dipper.intensity, 5.89);
    assert.equal(dipper.nausea, 4.12);
    assert.equal(dipper.price, 4.5);
    assert.equal(dipper.total_profit, 5678);
    assert.equal(dipper.profit_per_hour, 240);
    assert.equal(dipper.running_cost_per_hour, 64);   // 40 * 16 / 10
    assert.equal(dipper.satisfaction_pct, 75);
    assert.equal(dipper.max_queue_min, 12);
    assert.equal(dipper.broken_down, undefined);
    assert.equal(dipper.stats, undefined);            // only in get_ride

    assert.equal(unrated.excitement, undefined);       // -1 = not rated yet
    assert.equal(unrated.running_cost_per_hour, undefined);
    assert.equal(unrated.satisfaction_pct, undefined); // 1275 = no data
    assert.equal(unrated.status, "testing");

    assert.equal(carousel.broken_down, "safety_cut_out");
    assert.equal(carousel.excitement, 1.2);

    assert.equal(burger.kind, "stall");
    assert.deepEqual(burger.price, [1.5]);
    assert.equal(burger.excitement, undefined);
    assert.equal(burger.downtime_pct, undefined);
    assert.equal(burger.satisfaction_pct, 40);

    assert.equal(toilets.kind, "facility");
    assert.equal(toilets.type, "Toilets");
});

test("get_ride adds details and validates the id", async () => {
    const r = await tool("get_ride", { id: 0 });
    assert.equal(r.photo_price, 2);
    assert.equal(r.income_per_hour, 304);
    assert.equal(r.reliability_pct, 88);
    assert.equal(r.value, 350);
    assert.equal(r.inspection, "30 min");
    assert.equal(r.stats.max_speed_kmh, 84);
    assert.equal(r.stats.length_m, 812);
    assert.equal(r.stats.highest_drop, "42m");
    assert.equal((await tool("get_ride", { id: 3 })).stats, undefined);

    const bad = await client.call("get_ride", { id: 99 });
    assert.deepEqual([bad.ok, bad.error], [false, "no ride with id 99"]);
    const unknown = await client.call("rm_rf", {});
    assert.deepEqual([unknown.ok, unknown.error], [false, "unknown tool rm_rf"]);
});

test("get_guest_overview averages like the guest window and aggregates thoughts", async () => {
    const g = await tool("get_guest_overview");
    assert.equal(g.guests_in_park, 3);
    assert.equal(g.guests_lost, 1);
    // happiness bars: 100, 3 (clamped min), 50 -> 51
    assert.equal(g.averages_pct.happiness, 51);
    // hunger bars (inverted, low stat = hungry): 95, 0, 40
    assert.equal(g.averages_pct.hunger, 45);
    // energy bars: 100, 3 (clamped min), 50
    assert.equal(g.averages_pct.energy, 51);
    assert.equal(g.average_cash, 20);                  // (500 + 0 + 100) / 3 / 10
    assert.equal(g.litter_on_map, 5);
    assert.deepEqual(g.top_thoughts[0], { thought: "I'm hungry", guests: 3 });
    assert.equal(g.top_thoughts.length, 3);
    assert.ok(!g.top_thoughts.some((t) => t.thought.includes("outside")));
});

test("get_staff counts per type", async () => {
    assert.deepEqual(await tool("get_staff"), { handyman: 2, mechanic: 1, security: 0, entertainer: 0, total: 3 });
});

test("get_recent_messages: newest first, codes stripped, limit clamped", async () => {
    const m = await tool("get_recent_messages", { limit: 3 });
    assert.deepEqual(m.map((x) => x.text), [
        "Your park has a cash flow problem", "archived same day", "Big Dipper has broken down",
    ]);
    assert.equal(m[0].date, "April 14, Year 2");
    assert.equal((await tool("get_recent_messages", { limit: 999 })).length, 4);
    assert.equal((await tool("get_recent_messages", {})).length, 4);
});

test("!tool prints results in chat, safely", async () => {
    let from = plugin.sent.length;
    plugin.chat(ALICE, "!tool get_staff");
    await plugin.waitFor(() => plugin.repliesTo(ALICE, from).length > 0);
    assert.deepEqual(plugin.repliesTo(ALICE, from), ['("handyman":2,"mechanic":1,"security":0,"entertainer":0,"total":3)']);

    from = plugin.sent.length;
    plugin.chat(ALICE, "!tool get_ride 0");
    await plugin.waitFor(() => plugin.repliesTo(ALICE, from).length > 0);
    const text = plugin.repliesTo(ALICE, from).join("");
    assert.match(text, /"name":"Big Dipper"/);
    for (const part of plugin.repliesTo(ALICE, from)) {
        assert.ok(part.length <= 200);
        assert.ok(!/[{}]/.test(part));
    }

    from = plugin.sent.length;
    plugin.chat(ALICE, "!tool");
    await plugin.waitFor(() => plugin.repliesTo(ALICE, from).length > 0);
    assert.match(plugin.repliesTo(ALICE, from)[0], /^Usage: !tool <name>.*get_park_summary/);

    from = plugin.sent.length;
    plugin.chat(ALICE, "!tool get_ride 42");
    await plugin.waitFor(() => plugin.repliesTo(ALICE, from).length > 0);
    assert.deepEqual(plugin.repliesTo(ALICE, from), ["!tool get_ride failed: no ride with id 42"]);
});

test("tools never write to the park", async () => {
    const park = makePark();
    const writes = [];
    const frozen = loadPlugin({ port: PORT + 1, globals: readonly(park, "", writes) });
    try {
        const from = frozen.sent.length;
        for (const name of ["get_park_summary", "list_rides", "get_ride 0", "get_guest_overview", "get_staff", "get_recent_messages"]) {
            frozen.chat(ALICE, "!tool " + name);
        }
        await frozen.waitFor(() => frozen.repliesTo(ALICE, from).length >= 6);
        assert.ok(!frozen.repliesTo(ALICE, from).some((t) => t.includes("failed")), frozen.repliesTo(ALICE, from).join("\n"));
        assert.deepEqual(writes, []);
    } finally {
        frozen.close();
    }
});

// The plugin is sloppy-mode code, where writes to frozen objects fail silently,
// so record (and reject) every write through a Proxy instead.
function readonly(o, path, writes) {
    if (o === null || (typeof o !== "object" && typeof o !== "function")) return o;
    return new Proxy(o, {
        get(t, k, r) {
            const v = Reflect.get(t, k, r);
            return typeof k === "symbol" || k === "prototype" ? v : readonly(v, path + "." + String(k), writes);
        },
        set(t, k) { writes.push(path + "." + String(k)); throw new Error("write to " + path + "." + String(k)); },
        defineProperty(t, k) { writes.push(path + "." + String(k)); throw new Error("define " + String(k)); },
        deleteProperty(t, k) { writes.push(path + "." + String(k)); throw new Error("delete " + String(k)); },
    });
}
