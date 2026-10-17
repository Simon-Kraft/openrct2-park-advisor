// End-to-end: plugin in the harness <-> real Python helper (fake LLM, no network).
// Run: node --test test/
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const { loadPlugin } = require("./harness");
const { makePark } = require("./fixtures");

const ROOT = path.join(__dirname, "..");
const PORT = 21780 + Math.floor(Math.random() * 1000);
const ALICE = 1;

function startHelper(env = {}) {
    const proc = spawn(path.join(ROOT, ".venv", "bin", "python"), ["-m", "park_advisor"], {
        cwd: path.join(ROOT, "helper"),
        env: {
            ...process.env, ADVISOR_PORT: String(PORT), ADVISOR_LLM: "fake", ADVISOR_LOG_LEVEL: "DEBUG",
            ADVISOR_ENV_FILE: "/dev/null", ADVISOR_RATE_LIMIT: "100", ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    proc.output = "";
    proc.stdout.on("data", (d) => (proc.output += d));
    proc.stderr.on("data", (d) => (proc.output += d));
    return proc;
}

function stopHelper(proc) {
    return new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.on("exit", resolve);
        proc.kill("SIGTERM");
    });
}

const connectedCount = (p) => p.logs.filter((l) => l.includes("helper connected")).length;

/** Send a chat line and wait until the player got `n` replies; returns them. */
async function ask(plugin, text, n, player = ALICE) {
    const from = plugin.sent.length;
    plugin.chat(player, text);
    await plugin.waitFor(() => plugin.repliesTo(player, from).length >= n, 10000, `${n} replies to "${text}"`);
    return plugin.repliesTo(player, from);
}

let plugin = loadPlugin({ port: PORT, globals: makePark() });
let helper = null;

after(async () => {
    if (helper) await stopHelper(helper);
    plugin.close();
});

test("commands work locally while the helper is offline", async () => {
    assert.deepEqual(await ask(plugin, "!ping", 1), ["pong (advisor helper offline)"]);
    assert.match((await ask(plugin, "!help", 1))[0], /!ask <question>/);
    assert.deepEqual(await ask(plugin, "!ask hello", 1), ["Sorry, the park advisor is offline right now."]);
    assert.deepEqual(await ask(plugin, "!ask", 1), ["Usage: !ask <question>"]);
    // Ordinary chat is ignored.
    const before = plugin.sent.length;
    plugin.chat(ALICE, "hi everyone");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(plugin.sent.length, before);
});

test("helper connects and !ask round-trips", async () => {
    helper = startHelper();
    await plugin.waitFor(() => connectedCount(plugin) === 1, 10000, "helper connection");
    assert.deepEqual(await ask(plugin, "!ping", 1), ["pong"]);
    const r = await ask(plugin, "!ask why are guests leaving?", 2);
    assert.equal(r[0], "Thinking...");
    assert.match(r[1], /why are guests leaving\?/);
    // The fake LLM looked at the guests through the plugin's tool.
    assert.match(r[1], /Tools: get_guest_overview guests_in_park=3/);
});

test("non-ASCII survives the bridge, braces are made safe", async () => {
    const r = await ask(plugin, "!ask Warum gehen die Gäste {RED} weg? Größe", 2);
    assert.match(r[1], /Gäste \(RED\) weg\? Größe/);
});

test("long answers are split at word boundaries", async () => {
    const words = Array.from({ length: 60 }, (_, i) => "word" + i).join(" ");
    const r = await ask(plugin, "!ask " + words, 4);
    const echoed = r.slice(1);
    for (const part of echoed) assert.ok(part.length <= 200, `chunk too long: ${part.length}`);
    assert.ok(echoed.join(" ").includes("word0 word1 word2") && echoed.join(" ").includes("word58 word59"));
    for (const part of echoed) assert.match(part, /^\S.*\S$/);
});

test("helper reconnects after the plugin restarts", async () => {
    plugin.close();
    plugin = loadPlugin({ port: PORT, globals: makePark() });
    await plugin.waitFor(() => connectedCount(plugin) === 1, 15000, "reconnect");
    const r = await ask(plugin, "!ask still there?", 2);
    assert.match(r[1], /still there\?/);
});

test("plugin notices when the helper goes away", async () => {
    await stopHelper(helper);
    helper = null;
    await plugin.waitFor(() => plugin.logs.some((l) => l.includes("helper disconnected")), 5000, "disconnect");
    assert.deepEqual(await ask(plugin, "!ask hello", 1), ["Sorry, the park advisor is offline right now."]);
});
