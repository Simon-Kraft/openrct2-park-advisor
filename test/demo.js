// Interactive demo: the plugin in the harness with the fixture park, the real Python helper and the
// real Ollama models. Type questions (or any chat command) at the prompt; Ctrl+D quits.
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const { loadPlugin } = require("./harness");
const { makePark } = require("./fixtures");

const ROOT = path.join(__dirname, "..");
const PORT = 26780 + Math.floor(Math.random() * 1000);
const PLAYER = 1;

const plugin = loadPlugin({ port: PORT, globals: makePark(), players: [{ id: 0, name: "Server", group: 0 }, { id: PLAYER, name: "You", group: 1 }] });
const helper = spawn(path.join(ROOT, ".venv", "bin", "python"), ["-m", "park_advisor"], {
    cwd: path.join(ROOT, "helper"),
    env: { ...process.env, ADVISOR_PORT: String(PORT), ADVISOR_LLM: "local", ADVISOR_LOG_LEVEL: process.env.ADVISOR_LOG_LEVEL || "INFO" },
    stdio: ["ignore", "inherit", "inherit"],  // the helper's log shows the router's picks
});

async function main() {
    await plugin.waitFor(() => plugin.logs.some((l) => l.includes("helper connected")), 15000, "helper connection");
    console.log("\nPark Advisor demo (fixture park). Try: !ask which ride makes the most profit?   Ctrl+D quits.\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
    rl.prompt();
    let queue = Promise.resolve();  // questions run one at a time, also when input is piped
    rl.on("line", (line) => { queue = queue.then(() => handle(line)); });
    async function handle(line) {
        const text = line.trim();
        if (text) {
            const from = plugin.sent.length;
            plugin.chat(PLAYER, text.startsWith("!") ? text : "!ask " + text);
            const asking = !text.startsWith("!") || text.startsWith("!ask");
            const end = Date.now() + 120000;
            let shown = 0, lastChange = Date.now();
            while (Date.now() < end) {
                await new Promise((r) => setTimeout(r, 100));
                const replies = plugin.repliesTo(PLAYER, from);
                for (; shown < replies.length; shown++) { console.log("bot> " + replies[shown]); lastChange = Date.now(); }
                if (shown && (!asking || (shown >= 2 && Date.now() - lastChange > 500))) break;
            }
        }
        rl.prompt();
    }
    rl.on("close", () => queue.then(() => { helper.kill("SIGTERM"); plugin.close(); process.exit(0); }));
}

main().catch((e) => { console.error(e.message); helper.kill("SIGTERM"); process.exit(1); });
