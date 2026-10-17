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
    "!reset forgets your conversation. !ping checks the bot. !help shows this.";

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
    send({ type: "hello", protocol: PROTOCOL, api: context.apiVersion });
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

function main() {
    if (network.mode !== "server") return;
    context.subscribe("network.chat", onChat);
    startListener();
}

registerPlugin({
    name: "ParkAdvisor",
    version: "0.1.0",
    authors: ["Simon"],
    type: "remote",
    licence: "MIT",
    targetApiVersion: 124,
    main: main
});
