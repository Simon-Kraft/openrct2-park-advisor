// A small fake park for the harness, using raw (internal) units the way the
// OpenRCT2 v0.5.6 API returns them.
"use strict";

const MONEY_UNDEFINED = -9223372036854775808;

function ride(o) {
    return {
        id: 0, name: "Ride", object: { name: "Ride type" }, classification: "ride", status: "open",
        breakdown: "none", excitement: -1, intensity: -1, nausea: -1, price: [0, 0], totalCustomers: 0,
        totalProfit: 0, profit: 0, incomePerHour: 0, runningCost: 0, age: 0, downtime: 0, reliability: 100,
        satisfaction: 255 * 5, guestCount: 0, value: null, inspectionInterval: 2, stations: [{ queueTime: 0 }],
        maxSpeed: 0, averageSpeed: 0, rideTime: 0, rideLength: 0, maxPositiveVerticalGs: 0,
        maxNegativeVerticalGs: 0, maxLateralGs: 0, totalAirTime: 0, numDrops: 0, numLiftHills: 0,
        highestDropHeight: 0,
        ...o,
    };
}

const thought = (text, type = "other") => ({ type, item: 0, freshness: 1, freshTimeout: 0, toString: () => `“${text}”` });

function guest(o) {
    return {
        id: 100, isInPark: true, isLost: false, happiness: 128, energy: 80, hunger: 128, thirst: 128,
        nausea: 32, toilet: 64, cash: 200, thoughts: [], ...o,
    };
}

function makePark() {
    const rides = [
        ride({
            id: 0, name: "Big Dipper", object: { name: "Wooden Roller Coaster" }, excitement: 652, intensity: 589,
            nausea: 412, price: [45, 20], totalCustomers: 1234, totalProfit: 56780, profit: 2400, incomePerHour: 3040,
            runningCost: 40, age: 14, downtime: 7, reliability: 88, satisfaction: 75, guestCount: 24, value: 3500,
            stations: [{ queueTime: 12 }, { queueTime: 3 }], maxSpeed: 52.5, averageSpeed: 21.2, rideTime: 95,
            rideLength: 812.4, maxPositiveVerticalGs: 3.4, maxNegativeVerticalGs: -0.8, maxLateralGs: 1.6,
            totalAirTime: 1.5, numDrops: 6, numLiftHills: 1, highestDropHeight: 28,
        }),
        ride({ id: 3, name: "New Coaster 1", object: { name: "Steel Twister" }, status: "testing", runningCost: MONEY_UNDEFINED }),
        ride({ id: 4, name: "Merry-Go-Round 1", object: { name: "Merry-Go-Round" }, status: "closed", breakdown: "safety_cut_out", excitement: 120, intensity: 50, nausea: 0 }),
        ride({ id: 7, name: "Burger Bar 1", type: 28, object: { name: "Burger Bar", identifier: "rct2.ride.burgb" }, classification: "stall", price: [15], totalCustomers: 300, totalProfit: 1200, satisfaction: 40, runningCost: 25 }),
        ride({ id: 8, name: "Toilets 1", type: 36, object: { name: "Toilets", identifier: "rct2.ride.tlt1" }, classification: "facility", price: [0] }),
    ];

    const guests = [
        guest({ id: 1, happiness: 255, energy: 128, hunger: 40, thirst: 200, nausea: 255, toilet: 242, cash: 500,
            thoughts: [thought("I'm hungry", "hungry"), thought("Big Dipper is really good value", "good_value")] }),
        guest({ id: 2, happiness: 0, energy: 32, hunger: 200, thirst: 40, nausea: 32, toilet: 64, cash: 0,
            thoughts: [thought("I'm hungry", "hungry"), thought("I want to go home", "go_home")] }),
        guest({ id: 3, isLost: true, happiness: 128, energy: 80, hunger: 128, thirst: 128, cash: 100,
            thoughts: [thought("I'm hungry", "hungry")] }),
        guest({ id: 4, isInPark: false, happiness: 10, cash: 9999, thoughts: [thought("outside, must not count")] }),
    ];

    const staff = [
        { id: 50, staffType: "handyman" }, { id: 51, staffType: "handyman" }, { id: 52, staffType: "mechanic" },
    ];

    const messages = [
        { isArchived: false, month: 9, day: 14, type: "money", text: "{BLACK}Your park has a cash flow problem" },
        { isArchived: false, month: 9, day: 2, type: "attraction", text: "Big Dipper has broken down" },
        { isArchived: true, month: 1, day: 5, type: "award", text: "Your park has received an award" },
        { isArchived: true, month: 9, day: 14, type: "guests", text: "archived same day" },
    ];

    return {
        park: {
            name: "Simon's Park", cash: 123456, bankLoan: 100000, maxBankLoan: 200000, rating: 642, guests: 3,
            suggestedGuestMaximum: 800, value: 456780, companyValue: 356780, entranceFee: 150,
            flags: { open: true, freeParkEntry: false, unlockAllPrices: false, noMoney: false },
            getFlag(f) { return !!this.flags[f]; },
            awards: [{ positive: true, text: "{WINDOW_COLOUR_2}Most tidy park" }, { positive: false, text: "Worst food" }],
            messages,
        },
        date: { year: 2, month: 1, day: 17, monthsElapsed: 9, ticksElapsed: 50000 },
        scenario: { name: "Forest Frontiers", status: "inProgress", objective: { type: "guestsBy", guests: 1200, year: 3, length: 0, excitement: 0, parkValue: 0, monthlyIncome: 0 } },
        climate: { current: { weather: "rain", temperature: 14 }, future: { weather: "sunny", temperature: 18 } },
        map: {
            rides,
            getRide(id) { return rides.find((r) => r.id === id) || null; },
            getAllEntities(type) {
                if (type === "guest") return guests;
                if (type === "staff") return staff;
                if (type === "litter") return [{}, {}, {}, {}, {}];
                throw new Error("unexpected entity type " + type);
            },
        },
    };
}

// ---------------------------------------------------------------- building
// A small map and a fake game-action engine for the building tools. Argument checks, error
// texts, costs and refunds follow what the real game did in docs/ride-placement-spike.md.
// Callback timing (queries answer at once, executes later) is the harness's job.

const LAND_Z = 112;
const STALL_TRACK = 262;
const TRACK_COST = { 28: 3000, 30: 3000, 32: 2000, 33: 4600 };   // internal units, per ride type
const STALL_TYPES = [28, 30, 32];
const FACILITY_TYPES = [35, 36, 45, 48];

const RIDE_OBJECTS = [
    ["rct2.ride.burgb", "Burger Bar", 28], ["rct2.ride.hotds", "Hot Dog Stall", 28],
    ["rct2.ride.cndyf", "Cotton Candy Stall", 28, false], ["rct2.ride.drnks", "Drinks Stall", 30],
    ["rct2.ride.balln", "Balloon Stall", 32], ["rct2.ride.tshrt", "T-Shirt Stall", 32],
    ["rct2.ride.infok", "Information Kiosk", 35], ["rct2.ride.tlt1", "Restroom", 36],
    ["rct2.ride.atm1", "ATM", 45, false], ["rct2.ride.faid1", "First Aid Room", 48],
    ["rct2.ride.mgr1", "Merry-Go-Round", 33],
];

const err = (error, errorMessage, title = "Can’t construct this here…") => ({ error, errorTitle: title, errorMessage, cost: 0 });

/**
 * Add a map and building actions to a park from makePark(). Map legend, one character per
 * tile, rows are y (keep a border of "u", the game never builds on the map edge):
 *   .  owned flat land    #  footpath     =  queue path    ~  water    /  slope
 *   u  unowned land       t  tree         E  park entrance (centre)    ^  owned land one step up
 *   0-9  a track tile of the park's ride with that id (also its station start)
 * opts.guests: [[x, y, count]] puts guests in the park on those tiles.
 * Returns {actions, calls, failOnExecute}: pass `actions` to loadPlugin; `calls` records every
 * query/execute; set failOnExecute[name] = result to make the next execute of that action fail.
 */
function addWorld(g, rows, opts = {}) {
    const tiles = [];
    const size = { x: rows[0].length, y: rows.length };
    const at = (x, y) => (x >= 0 && y >= 0 && x < size.x && y < size.y ? tiles[x][y] : null);
    for (let x = 0; x < size.x; x++) {
        tiles.push([]);
        for (let y = 0; y < size.y; y++) {
            const c = rows[y][x];
            const surface = {
                type: "surface", baseZ: c === "^" ? LAND_Z + 16 : c === "~" ? LAND_Z - 16 : LAND_Z,
                slope: c === "/" ? 14 : 0, waterHeight: c === "~" ? LAND_Z : 0, hasOwnership: c !== "u",
            };
            const els = [surface];
            if (c === "#" || c === "=" || c === "E") {
                els.push({ type: "footpath", baseZ: LAND_Z, slopeDirection: null, isQueue: c === "=", edges: 0 });
            }
            if (c === "E") els.push({ type: "entrance", baseZ: LAND_Z, object: 2, ride: 0, sequence: 0 });
            if (c === "t") els.push({ type: "small_scenery", baseZ: LAND_Z });
            if (/\d/.test(c)) {
                const r = g.map.getRide(Number(c));
                els.push({ type: "track", baseZ: LAND_Z, ride: r.id, trackType: STALL_TRACK, direction: 0 });
                r.stations[0].start = { x: x * 32, y: y * 32, z: LAND_Z };
            }
            tiles[x].push(els);
        }
    }
    // Path edges join neighbouring paths, like the game's auto-connect.
    const DELTA = [[-1, 0], [0, 1], [1, 0], [0, -1]];
    const pathAt = (x, y) => (at(x, y) || []).find((e) => e.type === "footpath");
    for (let x = 0; x < size.x; x++) {
        for (let y = 0; y < size.y; y++) {
            const p = pathAt(x, y);
            if (p) p.edges = DELTA.reduce((m, [dx, dy], d) => m | (pathAt(x + dx, y + dy) ? 1 << d : 0), 0);
        }
    }

    const objects = RIDE_OBJECTS.map(([identifier, name, type, researched = true], index) =>
        ({ index, identifier, name, rideType: [type, 255, 255], researched }));
    g.objectManager = { getAllObjects: (type) => (type === "ride" ? objects : []) };
    g.park.research = { isObjectResearched: (type, i) => type === "ride" && !!objects[i] && objects[i].researched };
    g.map.size = size;
    g.map.getTile = (x, y) => ({ x, y, elements: at(x, y) || [] });

    const placed = [];
    for (const [x, y, n] of opts.guests || []) {
        for (let i = 0; i < n; i++) placed.push({ ...guestAt(x, y), id: 1000 + placed.length });
    }
    const entities = g.map.getAllEntities;
    g.map.getAllEntities = (type) => (type === "guest" ? entities(type).concat(placed) : entities(type));

    const rides = g.map.rides;
    const calls = [];
    const failOnExecute = {};
    const trackCost = (type) => TRACK_COST[type] || 3000;

    function check(name, a) {
        const target = g.map.getRide(a.ride);
        switch (name) {
            case "ridecreate": {
                if (!objects[a.rideObject]) return err(1, "Unknown object type", "Can’t create new ride/attraction…");
                if (a.colour1 > 2) return err(1, "Invalid color", "Can’t create new ride/attraction…");
                let id = 0;
                while (g.map.getRide(id)) id++;
                return { error: 0, cost: 0, ride: id };
            }
            case "trackplace": {
                if (!target) return err(1, "Ride not found");
                if (target.type !== a.rideType) return err(1, "");
                const tx = a.x / 32, ty = a.y / 32;
                const els = at(tx, ty);
                if (!els || !els[0].hasOwnership) return err(2, "Land not owned by park!");
                const s = els[0];
                if (s.waterHeight) return err(9, "Cannot build partly above and partly below water!");
                if (s.slope || a.z < s.baseZ) return err(9, "Raise or lower land first");
                const block = els.find((e) => e.type !== "surface" && e.type !== "small_scenery");
                if (block) {
                    return err(9, block.type === "track" ? g.map.getRide(block.ride).name + " in the way"
                        : block.type === "footpath" ? "Footpath in the way" : "Something in the way");
                }
                const cost = trackCost(a.rideType) + (els.some((e) => e.type === "small_scenery") ? 120 : 0);
                if (!g.park.getFlag("noMoney") && cost > g.park.cash) {
                    return { ...err(4, `Not enough cash - requires £${(cost / 10).toFixed(2)}`), cost };
                }
                return { error: 0, cost, position: { x: a.x + 16, y: a.y + 16, z: a.z }, expenditureType: "ride_construction" };
            }
            case "ridesetprice":
                if (!target) return err(1, "Ride not found", "Can’t change price…");
                if (!(a.price >= 0 && a.price <= 200)) return err(1, "", "Can’t change price…");
                return { error: 0, cost: 0 };
            case "ridesetstatus":
                if (!target) return err(1, "Ride not found", "Can’t open…");
                return { error: 0, cost: 0 };
            case "ridedemolish":
                if (!target) return err(1, "Ride not found", "Can’t demolish ride/attraction…");
                return { error: 0, cost: 0 };
            default:
                return err(1, "harness: unsupported action " + name, "");
        }
    }

    function apply(name, a, res) {
        const target = g.map.getRide(a.ride);
        if (name === "ridecreate") {
            const obj = objects[a.rideObject];
            const type = a.rideType;
            const same = rides.filter((r) => r.object.identifier === obj.identifier).length;
            rides.push(ride({
                id: res.ride, name: `${obj.name} ${same + 1}`, type, object: { name: obj.name, identifier: obj.identifier },
                classification: STALL_TYPES.includes(type) ? "stall" : FACILITY_TYPES.includes(type) ? "facility" : "ride",
                status: "closed", price: [0], stations: [{ queueTime: 0, start: null, entrance: null }],
            }));
        } else if (name === "trackplace") {
            const els = at(a.x / 32, a.y / 32);
            els.splice(1, els.length, { type: "track", baseZ: a.z, ride: a.ride, trackType: a.trackType, direction: a.direction });
            target.stations[0].start = { x: a.x, y: a.y, z: a.z };
            target.trackCost = res.cost;
            g.park.cash -= res.cost;
        } else if (name === "ridesetprice") {
            target.price[0] = a.price;
        } else if (name === "ridesetstatus") {
            target.status = ["closed", "open", "testing", "simulating"][a.status];
        } else if (name === "ridedemolish") {
            for (const col of tiles) for (const els of col) {
                const i = els.findIndex((e) => e.type === "track" && e.ride === target.id);
                if (i >= 0) els.splice(i, 1);
            }
            rides.splice(rides.indexOf(target), 1);
            // Like the game: about 70% of the construction cost comes back.
            res.cost = -Math.round((target.trackCost || 0) * 0.7);
            g.park.cash -= res.cost;
        }
    }

    const actions = {
        query(name, a) {
            calls.push({ kind: "query", name, args: plain(a) });
            return check(name, a);
        },
        execute(name, a) {
            calls.push({ kind: "execute", name, args: plain(a) });
            if (failOnExecute[name]) {
                const res = failOnExecute[name];
                delete failOnExecute[name];
                return res;
            }
            const res = check(name, a);
            if (!res.error) apply(name, a, res);
            return res;
        },
    };
    return { actions, calls, failOnExecute, tiles: at };
}

// Plain copy of an object made inside the plugin's sandbox, for deepStrictEqual.
const plain = (o) => JSON.parse(JSON.stringify(o));

function guestAt(x, y) {
    return { id: 0, isInPark: true, isLost: false, happiness: 128, energy: 80, hunger: 128, thirst: 128,
        nausea: 32, toilet: 64, cash: 200, thoughts: [], x: x * 32 + 16, y: y * 32 + 16, z: LAND_Z };
}

module.exports = { makePark, ride, addWorld, MONEY_UNDEFINED, LAND_Z };
