// Local mode: plugin in the harness <-> real Python helper with the scripted fake router and LLM.
// Covers tool picking, the keyword safety net, ride lookup, data trimming and errors.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { loadPlugin } = require("./harness");
const { makePark, ride } = require("./fixtures");

const ROOT = path.join(__dirname, "..");
const PORT = 25780 + Math.floor(Math.random() * 1000);
const players = [{ id: 0, name: "Server", group: 0 }];
for (let i = 1; i <= 10; i++) players.push({ id: i, name: "Player" + i, group: 1 });

const park = makePark();
const plugin = loadPlugin({ port: PORT, globals: park, players });
let helper = null;

before(async () => {
    helper = spawn(path.join(ROOT, ".venv", "bin", "python"), ["-m", "park_advisor"], {
        cwd: path.join(ROOT, "helper"),
        env: {
            ...process.env, ADVISOR_PORT: String(PORT), ADVISOR_LLM: "fake-local", ADVISOR_LOG_LEVEL: "DEBUG",
            ADVISOR_ENV_FILE: "/dev/null", ADVISOR_RATE_LIMIT: "100",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    helper.output = "";
    helper.stdout.on("data", (d) => (helper.output += d));
    helper.stderr.on("data", (d) => (helper.output += d));
    await plugin.waitFor(() => plugin.logs.some((l) => l.includes("helper connected")), 10000, "helper connection");
});

after(async () => {
    if (helper && helper.exitCode === null) {
        await new Promise((resolve) => { helper.on("exit", resolve); helper.kill("SIGTERM"); });
    }
    plugin.close();
});

/** Send a chat line and wait until the player got `n` replies; returns them. */
async function ask(player, text, n = 2) {
    const from = plugin.sent.length;
    plugin.chat(player, text);
    await plugin.waitFor(() => plugin.repliesTo(player, from).length >= n, 10000, `${n} replies to "${text}"`);
    return plugin.repliesTo(player, from);
}

test("the router's pick is looked up and reaches the answer model, sorted for the question", async () => {
    let r = await ask(1, "!ask which ride makes the most profit?");
    assert.equal(r[0], "Thinking...");
    assert.equal(r[1], "Echo: which ride makes the most profit? Data: rides 5 total, sorted by profit per hour, "
        + "highest first. Rides: Big Dipper, New Coaster 1, Merry-Go-Round 1, Burger Bar 1, Toilets 1.");
    r = await ask(1, "!ask which rides break down a lot?");
    assert.match(r[1], /Data: rides 5 total, sorted by downtime, highest first\. Rides: Big Dipper,/);
});

test("questions without park data get no data", async () => {
    assert.deepEqual(await ask(2, "!ask hi, who are you?"), ["Thinking...", "Echo: hi, who are you?"]);
});

test("keywords add the tools the router misses", async () => {
    const r = await ask(3, "!ask do I need more mechanics?");
    assert.equal(r[1], "Echo: do I need more mechanics? Data: staff.");
    const r2 = await ask(3, "!ask warum sind die Gäste unglücklich und haben wir genug Personal?");
    assert.match(r2[1], /Data: guests; staff\./);
});

test("get_ride finds the ride by number or name, and falls back to the ride list", async () => {
    assert.match((await ask(4, "!ask tell me about ride 4"))[1], /Data: ride Merry-Go-Round 1\./);
    assert.match((await ask(4, "!ask how is the Big Dipper doing?"))[1], /Data: ride Big Dipper\./);
    assert.match((await ask(4, "!ask what about ride 99?"))[1], /Data: get_ride\./);
});

test("long ride lists are cut, broken and closed rides always stay", async () => {
    const extra = [];
    for (let i = 0; i < 20; i++) {
        extra.push(ride({ id: 20 + i, name: "Stall " + i, classification: "stall", price: [10], profit: 100 + i * 10 }));
    }
    park.map.rides.push(...extra);
    try {
        const r = await ask(5, "!ask which ride makes the most profit?", 3);
        const answer = r.slice(1).join(" ");
        assert.match(answer, /rides 25 total, sorted by profit per hour, highest first\. Rides: Big Dipper, Stall 19, Stall 18,/);
        // 12 by profit, plus the closed Merry-Go-Round and the testing coaster.
        assert.match(answer, /Stall 9, New Coaster 1, Merry-Go-Round 1\./);
    } finally {
        park.map.rides.splice(park.map.rides.length - extra.length);
    }
});

test("follow-up questions see the conversation", async () => {
    assert.doesNotMatch((await ask(6, "!ask first"))[1], /History/);
    assert.match((await ask(6, "!ask second"))[1], /History: 1\./);
});

test("router failures give a friendly message", async () => {
    assert.deepEqual(await ask(7, "!ask #fail"), ["Thinking...", "Sorry, the advisor can't think right now. Please try again later."]);
});
