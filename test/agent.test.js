// Agent loop: plugin in the harness <-> real Python helper with the scripted fake LLM.
// Covers tool calls, memory, limits, timeouts, error messages and answer cleanup.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { loadPlugin } = require("./harness");
const { makePark } = require("./fixtures");

const ROOT = path.join(__dirname, "..");
const PORT = 24780 + Math.floor(Math.random() * 1000);
const players = [{ id: 0, name: "Server", group: 0 }];
for (let i = 1; i <= 12; i++) players.push({ id: i, name: "Player" + i, group: 1 });

const plugin = loadPlugin({ port: PORT, globals: makePark(), players });
let helper = null;

before(async () => {
    helper = spawn(path.join(ROOT, ".venv", "bin", "python"), ["-m", "park_advisor"], {
        cwd: path.join(ROOT, "helper"),
        env: {
            ...process.env, ADVISOR_PORT: String(PORT), ADVISOR_LLM: "fake", ADVISOR_LOG_LEVEL: "DEBUG",
            ADVISOR_ENV_FILE: "/dev/null", ADVISOR_RATE_LIMIT: "3", ADVISOR_ASK_TIMEOUT: "2",
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

test("the model's tool calls run in the plugin", async () => {
    const r = await ask(1, "!ask how are my rides?");
    assert.equal(r[0], "Thinking...");
    assert.match(r[1], /Tools: list_rides 5 items\./);
});

test("several tools in one round, and tool arguments", async () => {
    let r = await ask(2, "!ask guests and staff?");
    assert.match(r[1], /get_guest_overview guests_in_park=3 guests_lost=1; get_staff handyman=2 mechanic=1/);
    r = await ask(2, "!ask tell me about ride 4");
    assert.match(r[1], /get_ride id=4 name=Merry-Go-Round 1/);
});

test("tool errors go back to the model instead of failing the question", async () => {
    const r = await ask(3, "!ask what about ride 99?");
    assert.match(r[1], /get_ride error no ride with id 99/);
    const r2 = await ask(3, "!ask #badtool park");
    assert.match(r2[1], /get_park_summary park=Simon's Park .*; delete_park error unknown tool delete_park\./);
});

test("follow-up questions see the conversation, !reset forgets it", async () => {
    let r = await ask(4, "!ask first");
    assert.doesNotMatch(r[1], /History/);
    r = await ask(4, "!ask second");
    assert.match(r[1], /History: 1\./);
    assert.deepEqual(await ask(4, "!reset", 1), ["OK, I forgot our conversation."]);
    r = await ask(4, "!ask third");
    assert.doesNotMatch(r[1], /History/);
});

test("per-player rate limit", async () => {
    for (const q of ["one", "two", "three"]) assert.match((await ask(5, "!ask " + q))[1], /^Echo/);
    const r = await ask(5, "!ask four", 1);
    assert.match(r[0], /^Slow down a little, you can ask 3 questions per minute\. Try again in \d+ seconds\.$/);
    // Other players are not affected.
    assert.match((await ask(6, "!ask hi"))[1], /^Echo: hi/);
});

test("one question at a time per player, and a timeout ends a hanging question", async () => {
    const from = plugin.sent.length;
    plugin.chat(7, "!ask #slow");
    await plugin.waitFor(() => plugin.repliesTo(7, from).length >= 1, 5000, "Thinking");
    assert.deepEqual(await ask(7, "!ask again", 1), ["I'm still thinking about your last question."]);
    await plugin.waitFor(() => plugin.repliesTo(7, from).length >= 3, 5000, "timeout message");
    assert.equal(plugin.repliesTo(7, from)[2], "Sorry, that took too long. Please try again.");
});

test("the tool round limit forces a final answer", async () => {
    const r = await ask(8, "!ask #loop");
    // 6 rounds with one get_staff call each, then an answer without tools.
    assert.equal((r[1].match(/get_staff/g) || []).length, 6);
});

test("LLM failures give a friendly message", async () => {
    assert.deepEqual(await ask(9, "!ask #fail"), ["Thinking...", "Sorry, the advisor can't think right now. Please try again later."]);
    assert.deepEqual(await ask(9, "!ask #ratelimit"),
        ["Thinking...", "Sorry, the advisor has hit its usage limit. Please try again in a minute."]);
});

test("answers are cleaned to plain text the game can render", async () => {
    const r = await ask(10, "!ask #markdown");
    assert.equal(r[1], 'Great park! Your "Big Dipper" is popular - add a Burger Bar... item one. item two');
});

test("very long answers are cut to about three chat lines", async () => {
    const r = await ask(11, "!ask #long", 4);
    await new Promise((res) => setTimeout(res, 200));
    const answer = plugin.repliesTo(11).slice(1);
    assert.ok(answer.length <= 3, `${answer.length} chat lines`);
    assert.ok(answer.join(" ").length <= 600);
    assert.match(r[r.length - 1], /\.$/);
});
