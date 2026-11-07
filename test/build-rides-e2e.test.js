// !build for flat rides end to end: plugin in the harness with room for rides <-> real Python
// helper with the scripted fake models.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { loadPlugin } = require("./harness");
const { makePark, addWorld, FLAT_MAP } = require("./fixtures");

const ROOT = path.join(__dirname, "..");
const PORT = 30780 + Math.floor(Math.random() * 1000);
const ADMIN = 0;

const g = makePark();
const world = addWorld(g, FLAT_MAP);
const plugin = loadPlugin({ port: PORT, globals: g, actions: world.actions });
let helper = null;

before(async () => {
    helper = spawn(path.join(ROOT, ".venv", "bin", "python"), ["-m", "park_advisor"], {
        cwd: path.join(ROOT, "helper"),
        env: {
            ...process.env, ADVISOR_PORT: String(PORT), ADVISOR_LLM: "fake", ADVISOR_LOG_LEVEL: "DEBUG",
            ADVISOR_ENV_FILE: "/dev/null", ADVISOR_RATE_LIMIT: "100", BUILD_ENABLED: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    helper.output = "";
    helper.stdout.on("data", (d) => (helper.output += d));
    helper.stderr.on("data", (d) => (helper.output += d));
    await plugin.waitFor(() => plugin.logs.some((l) => l.includes("building enabled")), 10000, "helper connection");
});

after(async () => {
    if (helper && helper.exitCode === null) {
        await new Promise((resolve) => { helper.on("exit", resolve); helper.kill("SIGTERM"); });
    }
    plugin.close();
});

async function say(text, n = 1) {
    const from = plugin.sent.length;
    plugin.chat(ADMIN, text);
    await plugin.waitFor(() => plugin.repliesTo(ADMIN, from).length >= n, 10000, `${n} replies to "${text}"\n${helper.output}`);
    return plugin.repliesTo(ADMIN, from).slice(-1)[0];
}

const build = (text) => say("!build " + text, 2);

test("a merry-go-round goes to a quiet spot, with its entrance and exit joined to the path", async () => {
    // Farthest from the park entrance at (1,5). The park charges for entry, so ride tickets stay free.
    assert.equal(await build("a merry-go-round"),
        "Proposal: Merry-Go-Round at (8,1) in a quieter spot away from the park entrance, open. Cost about £460. "
        + "Type !yes to build or !no to cancel.");
    assert.equal(await say("!yes"),
        "Built Merry-Go-Round 2 at (8,1) in a quieter spot away from the park entrance, open, for £460. Type !undo to remove it.");
    const ride = g.map.rides.find((r) => r.name === "Merry-Go-Round 2");
    assert.deepEqual([ride.stations[0].entrance, ride.stations[0].exit].map((t) => [t.x / 32, t.y / 32, t.direction]),
        [[8, 4, 3], [9, 4, 3]]);
    for (const x of [8, 9]) assert.ok(world.tiles(x, 5).find((e) => e.type === "footpath").edges & (1 << 3));
});

test("thrill rides, ticket prices when the park allows them, and a ride next to another", async () => {
    assert.match(await build("a thrill ride"),
        /^Proposal: Twist at \(5,1\) in a quieter spot away from the park entrance, open\. Cost about £360\./);
    g.park.flags.freeParkEntry = true;
    try {
        assert.match(await build("an expensive twist"), /^Proposal: Twist at \(5,1\) .*, price £3\.00, open\./);
    } finally {
        g.park.flags.freeParkEntry = false;
    }
    assert.match(await build("a twist next to the Merry-Go-Round 2"), /^Proposal: Twist at \(5,1\) near Merry-Go-Round 2, open\./);
    assert.equal(await say("!no"), "OK, cancelled.");
});

test("rides it can't place get a clear answer", async () => {
    assert.equal(await build("a Ferris Wheel"),
        "Sorry, I can't build a Ferris Wheel. I can build stalls and these rides: Bumper Cars, Merry-Go-Round, Spiral Slide, Twist.");
    assert.equal(await build("bumper cars"),
        "I found no free, flat 4x4 spot with a row for the entrance and exit next to a path. Clear some space or buy land first.");
});

test("!undo demolishes the ride with its entrance and exit", async () => {
    assert.equal(await say("!undo"), "Removed Merry-Go-Round 2, the park got £322 back.");
    for (const [x, y] of [[9, 2], [8, 4], [9, 4]]) assert.equal(world.tiles(x, y).length, 1);
});
