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
        ride({ id: 7, name: "Burger Bar 1", object: { name: "Burger Bar" }, classification: "stall", price: [15], totalCustomers: 300, totalProfit: 1200, satisfaction: 40, runningCost: 25 }),
        ride({ id: 8, name: "Toilets 1", object: { name: "Toilets" }, classification: "facility", price: [0] }),
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
        date: { year: 2, month: 1, day: 17, monthsElapsed: 9 },
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

module.exports = { makePark, ride, MONEY_UNDEFINED };
