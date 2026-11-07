// Building tools against a fake map and game-action engine: site search, the build action
// sequence with rollback, demolish, and the guards around the write tools.
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin, connect } = require("./harness");
const { makePark, addWorld, LAND_Z, MAP } = require("./fixtures");

const PORT = 27780 + Math.floor(Math.random() * 1000);
const ALICE = 1;

// Free sites on MAP, by position.
const SITES = [[1, 1], [1, 3], [2, 3], [4, 3], [6, 1], [6, 3], [7, 1], [8, 1], [8, 3], [9, 2]];

function start(port, opts = {}) {
    const g = makePark();
    const world = addWorld(g, MAP, opts);
    const plugin = loadPlugin({ port, globals: g, actions: world.actions });
    return { g, world, plugin };
}

const main = start(PORT, { guests: [[9, 4, 3]] });
let client = null;
const others = [];

after(() => {
    for (const c of [client, ...others]) if (c) c.sock.destroy();
    main.plugin.close();
});

async function call(name, args) {
    if (!client) client = await connect(PORT, { build: true });
    return client.call(name, args);
}

async function ok(name, args) {
    const r = await call(name, args);
    assert.equal(r.ok, true, r.error);
    return r.result;
}

const stall = (o) => ({ object: "rct2.ride.burgb", ride_type: 28, track_type: 262, x: 6, y: 3, z: LAND_Z, direction: 3,
    price: 1.5, open: true, player: ALICE, ...o });

test("find_sites: free, flat, owned land next to a path, facing it", async () => {
    const r = await ok("find_sites", { limit: 100 });
    assert.equal(r.total, SITES.length);
    assert.deepEqual(r.sites.map((s) => [s.x, s.y]), SITES);
    const at = (x, y) => r.sites.find((s) => s.x === x && s.y === y);
    assert.equal(at(6, 1).direction, 1);
    assert.equal(at(6, 3).direction, 3);
    assert.deepEqual([at(9, 2).direction, at(9, 2).path], [0, { x: 8, y: 2 }]);
    assert.deepEqual(at(1, 1).path, { x: 1, y: 2 });   // the park entrance tile's path counts
    assert.equal(at(1, 1).z, LAND_Z);
    // No ride (as opposed to stall) has a position here, so dist_nearest_ride is left out.
    assert.deepEqual(at(1, 1).features, { dist_park_entrance: 1, nearby_guests: 0, nearby_stalls: 1, path_neighbors: 1 });
});

test("find_sites: limit, sorting and near_ride", async () => {
    assert.deepEqual((await ok("find_sites", { limit: 3 })).sites.map((s) => [s.x, s.y]), SITES.slice(0, 3));
    assert.equal((await ok("find_sites", { limit: 999 })).sites.length, SITES.length);

    // Guests stand around (9,4): within 5 tiles of it come first, then by position.
    const busy = await ok("find_sites", { sort: "nearby_guests", limit: 4 });
    assert.deepEqual(busy.sites.map((s) => [s.x, s.y, s.features.nearby_guests]), [[4, 3, 3], [6, 1, 3], [6, 3, 3], [7, 1, 3]]);

    const near = await ok("find_sites", { near_ride: 7, limit: 4 });
    assert.deepEqual(near.near, { x: 3, y: 3 });
    assert.deepEqual(near.sites.map((s) => [s.x, s.y, s.features.dist_near]), [[2, 3, 1], [4, 3, 1], [1, 3, 2], [6, 3, 3]]);

    assert.equal((await call("find_sites", { near_ride: 99 })).error, "no ride with id 99");
    assert.equal((await call("find_sites", { sort: "price" })).error, "unknown sort price");
    assert.equal((await call("find_sites", { width: 3, height: 3 })).error, "only 1x1 sites are supported");
});

test("get_buildable lists researched objects, get_player_info tells admins apart", async () => {
    const b = await ok("get_buildable", { ride_types: [28, 45] });
    assert.deepEqual(b.objects, [
        { object: "rct2.ride.burgb", name: "Burger Bar", ride_type: 28 },
        { object: "rct2.ride.hotds", name: "Hot Dog Stall", ride_type: 28 },
    ]);   // Cotton Candy and ATM are not researched
    assert.deepEqual([b.cash, b.no_money, b.max_price], [12345.6, false, 20]);
    assert.equal((await ok("get_buildable", {})).objects.length, 9);

    assert.deepEqual(await ok("get_player_info", { player: 0 }), { id: 0, name: "Server", group: "Admin", is_admin: true });
    assert.deepEqual(await ok("get_player_info", { player: ALICE }), { id: 1, name: "Alice", group: "Guest", is_admin: false });
});

test("build dry run checks everything and only queries", async () => {
    const before = main.world.calls.length;
    // A Burger Bar already exists, so its ride id can stand in for the track query: exact cost.
    assert.deepEqual(await ok("build", stall({ dry_run: true })), { dry_run: true, cost: 300, cash: 12345.6 });
    // No drinks stall yet: the cost is unknown.
    assert.deepEqual(await ok("build", stall({ dry_run: true, object: "rct2.ride.drnks", ride_type: 30 })),
        { dry_run: true, cost: null, cash: 12345.6 });
    assert.ok(main.world.calls.slice(before).every((c) => c.kind === "query"));
    assert.equal(main.g.map.rides.length, 5);

    const fails = {
        "rct2.ride.cndyf is not available": stall({ dry_run: true, object: "rct2.ride.cndyf" }),
        "rct2.ride.nope is not available": stall({ dry_run: true, object: "rct2.ride.nope" }),
        "rct2.ride.drnks is not ride type 28": stall({ dry_run: true, object: "rct2.ride.drnks" }),
        "price must be between 0 and 20": stall({ dry_run: true, price: 25 }),
        "that spot is not free any more": stall({ dry_run: true, x: 5, y: 3 }),
        "there is no path in front of that spot": stall({ dry_run: true, direction: 1 }),
    };
    for (const [error, args] of Object.entries(fails)) assert.equal((await call("build", args)).error, error);
    main.g.park.cash = 100;
    try {
        assert.equal((await call("build", stall({ dry_run: true }))).error, "Not enough cash - requires £300.00");
    } finally {
        main.g.park.cash = 123456;
    }
});

test("build runs create, track, price, status in order and reports the ride", async () => {
    const before = main.world.calls.length;
    const r = await ok("build", stall({}));
    assert.deepEqual(r, { ride_id: 1, name: "Burger Bar 2", cost: 300, status: "open" });
    const executed = main.world.calls.slice(before).filter((c) => c.kind === "execute");
    assert.deepEqual(executed.map((c) => c.name), ["ridecreate", "trackplace", "ridesetprice", "ridesetstatus"]);
    assert.deepEqual(executed[0].args, { rideType: 28, rideObject: 0, entranceObject: 0, colour1: 0, colour2: 0, inspectionInterval: 2 });
    assert.deepEqual(executed[1].args, { x: 192, y: 96, z: LAND_Z, direction: 3, ride: 1, trackType: 262, rideType: 28,
        brakeSpeed: 0, colour: 0, seatRotation: 4, trackPlaceFlags: 0, isFromTrackDesign: false });
    assert.deepEqual(executed[2].args, { ride: 1, price: 15, isPrimaryPrice: true });
    assert.deepEqual(executed[3].args, { ride: 1, status: 1 });
    assert.equal(main.g.park.cash, 123456 - 3000);
    assert.equal(main.world.tiles(6, 3)[1].ride, 1);
    assert.ok(main.plugin.logs.some((l) => /built Burger Bar 2 \(ride 1\) at 6,3 for Alice, cost 300, .*as player 0/.test(l)),
        main.plugin.logs.join("\n"));
    // The spot is taken now, and the new stall shows up for later searches.
    assert.equal((await call("build", stall({ dry_run: true }))).error, "that spot is not free any more");
    assert.ok(!(await ok("find_sites", { limit: 100 })).sites.some((s) => s.x === 6 && s.y === 3));
});

test("a closed stall stays closed", async () => {
    const r = await ok("build", stall({ x: 8, y: 3, open: false, price: 0 }));
    assert.equal(r.status, "closed");
    assert.equal(main.g.map.getRide(r.ride_id).price[0], 0);
});

test("a failure after ridecreate rolls the ride back", async () => {
    main.world.failOnExecute.trackplace = { error: 9, errorTitle: "Can’t construct this here…", errorMessage: "{BLACK}Footpath in the way", cost: 0 };
    const rides = main.g.map.rides.length;
    const before = main.world.calls.length;
    const r = await call("build", stall({ x: 4, y: 3 }));
    assert.deepEqual([r.ok, r.error], [false, "Footpath in the way"]);
    await main.plugin.waitFor(() => main.g.map.rides.length === rides, 2000, "rollback");
    assert.deepEqual(main.world.calls.slice(before).filter((c) => c.kind === "execute").map((c) => c.name),
        ["ridecreate", "trackplace", "ridedemolish"]);
    // The plugin is free for the next build.
    assert.equal((await ok("build", stall({ x: 4, y: 3, dry_run: true }))).dry_run, true);
});

test("one build at a time", async () => {
    const [a, b] = await Promise.all([call("build", stall({ x: 4, y: 3 })), call("build", stall({ x: 2, y: 3 }))]);
    assert.equal(a.ok, true, a.error);
    assert.deepEqual([b.ok, b.error], [false, "another build is in progress"]);
    assert.equal((await ok("build", stall({ x: 2, y: 3 }))).name, "Burger Bar 5");
});

test("demolish removes the ride and reports the refund", async () => {
    const built = await ok("build", stall({ x: 1, y: 3 }));
    const cash = main.g.park.cash;
    assert.deepEqual(await ok("demolish", { ride_id: built.ride_id }), { ride_id: built.ride_id, name: built.name, refund: 210 });
    assert.equal(main.g.park.cash, cash + 2100);
    assert.equal(main.g.map.getRide(built.ride_id), null);
    assert.equal((await call("demolish", { ride_id: 99 })).error, "no ride with id 99");
});

test("write tools need the helper to enable building, and never run from !tool", async () => {
    const port = PORT + 1;
    const off = start(port);
    try {
        const c = await connect(port);
        others.push(c);
        assert.equal((await c.call("build", stall({ dry_run: true }))).error, "building is disabled");
        assert.equal((await c.call("demolish", { ride_id: 7 })).error, "building is disabled");
        assert.equal(off.world.calls.length, 0);

        const from = off.plugin.sent.length;
        off.plugin.chat(ALICE, "!tool build");
        off.plugin.chat(ALICE, "!tool demolish 7");
        await off.plugin.waitFor(() => off.plugin.repliesTo(ALICE, from).length >= 2);
        assert.deepEqual(off.plugin.repliesTo(ALICE, from), [
            "!tool only shows park data; build changes the park, use !build instead.",
            "!tool only shows park data; demolish changes the park, use !build instead.",
        ]);
        assert.equal(off.g.map.getRide(7).name, "Burger Bar 1");

        // The chat commands say so too, and !help leaves them out.
        const chatFrom = off.plugin.sent.length;
        off.plugin.chat(ALICE, "!build a burger bar");
        off.plugin.chat(ALICE, "!yes");
        off.plugin.chat(ALICE, "!help");
        await off.plugin.waitFor(() => off.plugin.repliesTo(ALICE, chatFrom).length >= 3);
        const [build, yes, help] = off.plugin.repliesTo(ALICE, chatFrom);
        assert.deepEqual([build, yes], ["Building is turned off on this server.", "Building is turned off on this server."]);
        assert.doesNotMatch(help, /!build/);

        // A helper that reconnects without the build flag turns building off again.
        const on = await connect(port, { build: true });
        others.push(on);
        await off.plugin.waitFor(() => off.plugin.logs.some((l) => l.includes("building enabled")));
        assert.equal((await on.call("build", stall({ dry_run: true }))).ok, true);
        const again = await connect(port, {});
        others.push(again);
        await new Promise((r) => setTimeout(r, 50));
        assert.equal((await again.call("build", stall({ dry_run: true }))).error, "building is disabled");
    } finally {
        off.plugin.close();
    }
});
