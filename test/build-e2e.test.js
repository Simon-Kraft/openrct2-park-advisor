// !build end to end: plugin in the harness with the fake map <-> real Python helper with the
// scripted fake models. Covers proposals, !yes/!no/!undo, permissions, limits and fallbacks.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { loadPlugin } = require("./harness");
const { makePark, addWorld, MAP } = require("./fixtures");

const ROOT = path.join(__dirname, "..");
const PORT = 28780 + Math.floor(Math.random() * 1000);
const [ALICE, BOB, CAROL, DAVE] = [1, 2, 3, 4];
const players = [
    { id: 0, name: "Server", group: 0 }, { id: ALICE, name: "Alice", group: 2 }, { id: BOB, name: "Bob", group: 1 },
    { id: CAROL, name: "Carol", group: 0 }, { id: DAVE, name: "Dave", group: 2 },
];
const groups = [
    { id: 0, name: "Admin", permissions: ["chat", "modify_groups"] }, { id: 1, name: "Guest", permissions: ["chat"] },
    { id: 2, name: "Builders", permissions: ["chat", "build_ride"] },
];

const g = makePark();
const world = addWorld(g, MAP, { guests: [[9, 4, 3]] });
const plugin = loadPlugin({ port: PORT, globals: g, actions: world.actions, players, groups });
let helper = null;

before(async () => {
    helper = spawn(path.join(ROOT, ".venv", "bin", "python"), ["-m", "park_advisor"], {
        cwd: path.join(ROOT, "helper"),
        env: {
            ...process.env, ADVISOR_PORT: String(PORT), ADVISOR_LLM: "fake", ADVISOR_LOG_LEVEL: "DEBUG",
            ADVISOR_ENV_FILE: "/dev/null", ADVISOR_RATE_LIMIT: "100", ADVISOR_ASK_TIMEOUT: "3",
            BUILD_ENABLED: "true", BUILD_ALLOWED_GROUPS: "Builders", BUILD_RATE_LIMIT: "2", BUILD_PROPOSAL_TTL: "1.5",
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

/** Send a chat line and wait until the player got `n` replies; returns the last one. */
async function say(player, text, n = 1) {
    const from = plugin.sent.length;
    plugin.chat(player, text);
    await plugin.waitFor(() => plugin.repliesTo(player, from).length >= n, 10000, `${n} replies to "${text}"\n${helper.output}`);
    return plugin.repliesTo(player, from).slice(-1)[0];
}

const build = (player, text) => say(player, "!build " + text, 2);   // "Thinking..." first
const rideNamed = (name) => g.map.rides.find((r) => r.name === name);

test("!help lists the build commands once the helper enables building", async () => {
    assert.match(await say(ALICE, "!help"), /!build <what> proposes a stall.*!undo removes your last build\.$/);
    assert.equal(await say(ALICE, "!build"), "Usage: !build <what>, e.g. !build a cheap burger bar");
});

test("propose, then !yes builds where many guests walk by, then !undo removes it", async () => {
    // (9,2) wins: next to the guests at (9,4) and away from the other burger bar.
    assert.equal(await build(ALICE, "a Burger Bar"),
        "Proposal: Burger Bar at (9,2) where many guests walk by, price £1.50, open. Cost £300. "
        + "Type !yes to build or !no to cancel.");
    const cash = g.park.cash;
    assert.equal(await say(ALICE, "!yes"),
        "Built Burger Bar 2 at (9,2) where many guests walk by, price £1.50, open, for £300. Type !undo to remove it.");
    const ride = rideNamed("Burger Bar 2");
    assert.deepEqual([ride.status, ride.price[0], g.park.cash], ["open", 15, cash - 3000]);
    assert.equal(world.tiles(9, 2)[1].ride, ride.id);

    assert.equal(await say(ALICE, "!undo"), "Removed Burger Bar 2, the park got £210 back.");
    assert.equal(rideNamed("Burger Bar 2"), undefined);
    assert.equal(await say(ALICE, "!undo"), "There is nothing of yours to undo.");
    assert.equal(await say(ALICE, "!yes"), "You have no proposal waiting. Use !build first.");
});

test("near a ride, a price wish, and an estimated cost when the park has none of that type yet", async () => {
    assert.equal(await build(ALICE, "a cheap drink stall near the Burger Bar 1"),
        "Proposal: Drinks Stall at (2,3) near Burger Bar 1, price £0.80, open. Cost about £300. "
        + "Type !yes to build or !no to cancel.");
    assert.equal(await say(ALICE, "!no"), "OK, cancelled.");
    assert.equal(await say(ALICE, "!no"), "You have no proposal waiting.");
    assert.equal(await say(ALICE, "!yes"), "You have no proposal waiting. Use !build first.");

    // The fixture's Big Dipper has no position on the map, and Ferris Wheel is no ride at all.
    assert.match(await build(ALICE, "an expensive balloon stall near the Big Dipper, kept closed"),
        /^Proposal: Balloon Stall at \(9,2\) where many guests walk by, price £3\.50, closed\. Cost about £200\. I don't know where Big Dipper is, so I picked a good spot instead\. Type !yes/);
    assert.equal(await say(ALICE, "!yes"),
        "Built Balloon Stall 1 at (9,2) where many guests walk by, price £3.50, closed, for £200. Type !undo to remove it.");
    assert.equal(await say(ALICE, "!undo"), "Removed Balloon Stall 1, the park got £140 back.");
    assert.match(await build(ALICE, "a balloon stall near the ferris wheel"),
        /Cost about £200\. I couldn't find a ride called ferris wheel, so I picked a good spot instead\./);
    assert.equal(await say(ALICE, "!no"), "OK, cancelled.");
});

test("stalls without a price, and the decision model picking among several", async () => {
    assert.match(await build(ALICE, "a first aid room"), /^Proposal: First Aid Room at \(9,2\) where many guests walk by, open\. Cost about £300\./);
    // Two food stalls are researched; the request's words pick the hot dog stall.
    assert.match(await build(ALICE, "some food, hot dogs maybe"), /^Proposal: Hot Dog Stall at/);
    // Nothing points either way: the first one, at the standard price.
    assert.match(await build(ALICE, "some food"), /^Proposal: Burger Bar at .*, price £1\.50, open\./);
    assert.equal(await say(ALICE, "!no"), "OK, cancelled.");
});

test("requests it can't build, and fallbacks when the model fails", async () => {
    assert.equal(await build(ALICE, "a giant roller coaster"),
        "I can build stalls and small rides, e.g. !build a cheap burger bar near the Big Dipper, or !build a merry-go-round.");
    // MAP has no room for a 3x3 ride (the flat ride tests use another map).
    assert.equal(await build(ALICE, "a carousel"),
        "I found no free, flat 3x3 spot with a row for the entrance and exit next to a path. Clear some space or buy land first.");
    assert.equal(await build(ALICE, "an ATM"),
        "The park has no ATM researched yet. It can build: Balloon Stall, Bumper Cars, Burger Bar, Drinks Stall, First Aid Room, "
        + "Hot Dog Stall, Information Kiosk, Merry-Go-Round, Restroom, Spiral Slide, T-Shirt Stall, Twist.");
    // Only the fake model knows "munchies"; when it fails, the keyword fallback still knows "hungry".
    assert.match(await build(ALICE, "munchies please"), /^Proposal: Burger Bar/);
    assert.match(await build(ALICE, "munchies please #badjson"), /^I can build stalls/);
    assert.match(await build(ALICE, "something for hungry guests #fail"), /^Proposal: Burger Bar/);
    assert.match(helper.output, /build request parse failed: fake failure/);
    assert.match(helper.output, /build request parse gave invalid JSON/);
    assert.equal(await say(ALICE, "!no"), "OK, cancelled.");
});

test("only admins and allowed groups build; undo is your own unless you are an admin", async () => {
    assert.equal(await build(BOB, "a burger bar"), "Sorry, only admins can build (and builders).");
    assert.match(await build(DAVE, "a T-Shirt Stall"), /^Proposal: T-Shirt Stall/);
    assert.match(await say(DAVE, "!yes"), /^Built T-Shirt Stall 1/);
    assert.equal(await say(ALICE, "!undo"), "There is nothing of yours to undo.");
    assert.equal(await say(BOB, "!undo"), "There is nothing of yours to undo.");
    assert.equal(await say(CAROL, "!undo"), "Removed T-Shirt Stall 1, the park got £140 back.");
    assert.equal(await say(CAROL, "!undo"), "I haven't built anything to undo.");
});

test("cost limits, cash reserve, expiry and the hourly build limit", async () => {
    world.costs[28] = 20000;   // a burger bar now costs 2000, over the 1000 limit
    try {
        assert.equal(await build(ALICE, "a burger bar"), "That costs about £2,000, more than the £1,000 limit for builds.");
    } finally {
        world.costs[28] = 3000;
    }
    const cash = g.park.cash;
    g.park.cash = 6000;
    try {
        assert.equal(await build(ALICE, "a burger bar"),
            "The park can't afford that: it costs about £300 and the park has £600, of which £500 stays in reserve.");
    } finally {
        g.park.cash = cash;
    }

    assert.match(await build(ALICE, "a burger bar"), /^Proposal/);
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(await say(ALICE, "!yes"), "Your proposal expired. Please use !build again.");

    // Two builds per hour (Alice built two above, so Dave tries this).
    assert.match(await build(DAVE, "a restroom"), /^Proposal/);
    assert.match(await say(DAVE, "!yes"), /^Built Restroom 2/);   // the park has Toilets 1 of the same object
    assert.match(await build(DAVE, "an information kiosk"), /^Proposal/);
    assert.equal(await say(DAVE, "!yes"), "You can build 2 things per hour. Try again in 60 minutes.");
});

test("a spot taken after the proposal, and a stall removed by hand before !undo", async () => {
    const [, x, y] = (await build(CAROL, "a drinks stall")).match(/^Proposal: Drinks Stall at \((\d+),(\d+)\)/);
    // Someone puts something there first.
    world.tiles(Number(x), Number(y)).push({ type: "small_scenery", baseZ: 112 });
    try {
        assert.equal(await say(CAROL, "!yes"), "I couldn't build it: that spot is not free any more. Please use !build again.");
    } finally {
        world.tiles(Number(x), Number(y)).pop();
    }
    assert.match(await build(CAROL, "a drinks stall"), /^Proposal/);
    assert.match(await say(CAROL, "!yes"), /^Built Drinks Stall 1/);
    rideNamed("Drinks Stall 1").name = "Lemonade Corner";
    assert.equal(await say(CAROL, "!undo"), "Drinks Stall 1 is already gone.");
    assert.ok(rideNamed("Lemonade Corner"), "a renamed ride is not demolished");
});

test("a slow model ends with the usual timeout, and one request at a time", async () => {
    const from = plugin.sent.length;
    plugin.chat(ALICE, "!build a #slow request");
    await plugin.waitFor(() => plugin.repliesTo(ALICE, from).length >= 1, 5000, "Thinking");
    assert.equal(await say(ALICE, "!build a burger bar"), "I'm still thinking about your last question.");
    await plugin.waitFor(() => plugin.repliesTo(ALICE, from).length >= 3, 6000, "timeout message");
    assert.equal(plugin.repliesTo(ALICE, from)[2], "Sorry, that took too long. Please try again.");
});

test("replies come in the request's language, unless the translation loses a number", async () => {
    assert.match(await build(ALICE, "bitte eine Burger Bar"), /^\[de\] Proposal: Burger Bar at \(\d+,\d+\) .* Type !yes to build or !no to cancel\.$/);
    assert.equal(await say(ALICE, "!no"), "[de] OK, cancelled.");
    // The "xx" translation drops digits, so the proposal goes out in English; a reply without numbers is still translated.
    assert.match(await build(ALICE, "a burger bar #xx"), /^Proposal: Burger Bar at \(\d+,\d+\)/);
    assert.match(helper.output, /translation to xx dropped/);
    assert.equal(await say(ALICE, "!no"), "[xx] OK, cancelled.");
    assert.match(await build(ALICE, "a burger bar"), /^Proposal/);
    assert.equal(await say(ALICE, "!no"), "OK, cancelled.");
});
