// Loads plugin/park-advisor.js in a sandbox with stubbed OpenRCT2 globals, so the
// plugin can be exercised without the game. Socket semantics follow ScSocket.hpp:
// data arrives as string chunks, write() returns true only on a partial send.
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const vm = require("vm");

const PLUGIN = path.join(__dirname, "..", "plugin", "park-advisor.js");

function makeSocket(sock) {
    return {
        setNoDelay(v) { sock.setNoDelay(v); return this; },
        write(data) { sock.write(data, "utf8"); return false; },
        end(data) { sock.end(data); return this; },
        destroy() { sock.destroy(); return this; },
        connect() { throw new Error("not supported in harness"); },
        on(event, cb) {
            if (event === "data") sock.on("data", (b) => cb(b.toString("utf8")));
            else if (event === "close") sock.on("close", (hadError) => cb(hadError));
            else if (event === "error") sock.on("error", (e) => cb(String(e.message)));
            return this;
        },
        off() { return this; },
    };
}

function makeListener(logs) {
    const server = net.createServer();
    const conns = new Set();
    server.on("connection", (s) => { conns.add(s); s.on("close", () => conns.delete(s)); });
    let listening = false;
    const l = {
        get listening() { return listening; },
        listen(port, host) {
            if (host && !["localhost", "127.0.0.1", "::"].includes(host)) {
                throw new Error("For security reasons, only binding to localhost is allowed.");
            }
            server.on("error", (e) => logs.push("[listener] " + e.message));
            server.listen(port, host || "127.0.0.1", () => { listening = true; });
            return l;
        },
        close() { server.close(); listening = false; return l; },
        on(event, cb) {
            if (event === "connection") server.on("connection", (s) => cb(makeSocket(s)));
            return l;
        },
        off() { return l; },
        _dispose() { server.close(); for (const s of conns) s.destroy(); },
    };
    return l;
}

/**
 * Start the plugin in a sandbox.
 * @param {object} opts
 *   port:    bridge port (patched into the plugin source)
 *   globals: extra/override globals (park, map, date, scenario, climate, ...)
 *   players: [{id, name, group}]
 */
function loadPlugin(opts = {}) {
    const logs = [];      // console.log output
    const sent = [];      // {to, text} chat messages sent by the plugin
    const hooks = {};
    const timers = new Set();
    const listeners = [];
    const players = opts.players || [{ id: 0, name: "Server", group: 0 }, { id: 1, name: "Alice", group: 1 }];
    let registered = null;

    const network = {
        mode: "server",
        players,
        getPlayer(id) {
            const p = players.find((x) => x.id === id);
            if (!p) throw new Error("Invalid player id");
            return p;
        },
        sendMessage(text, to) { sent.push({ to: to ? to.slice() : null, text }); },
        createListener() { const l = makeListener(logs); listeners.push(l); return l; },
        createSocket() { throw new Error("not supported in harness"); },
    };

    const context = {
        apiVersion: 124,
        subscribe(hook, cb) {
            (hooks[hook] = hooks[hook] || []).push(cb);
            return { dispose() { hooks[hook] = hooks[hook].filter((x) => x !== cb); } };
        },
        setTimeout(cb, ms) { const h = setTimeout(() => { timers.delete(h); cb(); }, ms); timers.add(h); return h; },
        setInterval(cb, ms) { const h = setInterval(cb, ms); timers.add(h); return h; },
        clearTimeout(h) { clearTimeout(h); timers.delete(h); },
        clearInterval(h) { clearInterval(h); timers.delete(h); },
        // Rough stand-in for the game's formatter (only the codes the plugin uses).
        formatString(fmt, value) {
            if (fmt === "{HEIGHT}") return `{BLACK}${Math.round(value * 1.5)}m`;
            throw new Error("harness: unsupported format " + fmt);
        },
    };

    const sandbox = {
        console: { log: (...a) => logs.push(a.join(" ")) },
        context,
        network,
        registerPlugin(meta) { registered = meta; },
        ...(opts.globals || {}),
    };
    vm.createContext(sandbox);

    let src = fs.readFileSync(PLUGIN, "utf8");
    if (opts.port) src = src.replace(/var PORT = \d+;/, `var PORT = ${opts.port};`);
    vm.runInContext(src, sandbox, { filename: "park-advisor.js" });
    if (!registered) throw new Error("plugin did not call registerPlugin");
    registered.main();

    return {
        meta: registered,
        logs,
        sent,
        sandbox,
        /** Simulate a chat message; returns the (possibly modified) event. */
        chat(player, message) {
            const e = { player, message };
            for (const cb of hooks["network.chat"] || []) cb(e);
            return e;
        },
        /** Chat messages sent to a player since index `from`. */
        repliesTo(player, from = 0) {
            return sent.slice(from).filter((m) => m.to && m.to.includes(player)).map((m) => m.text);
        },
        async waitFor(pred, timeoutMs = 5000, what = "condition") {
            const end = Date.now() + timeoutMs;
            while (Date.now() < end) {
                if (pred()) return;
                await new Promise((r) => setTimeout(r, 20));
            }
            throw new Error(`timed out waiting for ${what}\nlogs:\n${logs.join("\n")}\nsent:\n${JSON.stringify(sent, null, 1)}`);
        },
        close() {
            for (const h of timers) { clearTimeout(h); clearInterval(h); }
            // Like RemoveSockets() on plugin stop: listeners and their connections go away.
            for (const l of listeners) l._dispose();
            hooks["network.chat"] = [];
        },
    };
}

module.exports = { loadPlugin };
