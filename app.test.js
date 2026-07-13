const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadAppApi() {
  const elements = new Map();

  function makeElement(id = "") {
    const element = {
      id,
      hidden: false,
      value: id === "tripType" ? "oneway" : "",
      textContent: "",
      innerHTML: "",
      dataset: {},
      parentElement: null,
      classList: {
        add() {},
        remove() {},
        contains() { return false; },
        toggle() { return false; },
      },
      addEventListener() {},
      appendChild(child) {
        child.parentElement = element;
        return child;
      },
      setAttribute() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    return element;
  }

  const document = {
    title: "",
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    createElement: () => makeElement(),
    createElementNS: () => makeElement(),
  };

  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  window.window = window;

  const sandbox = {
    console,
    document,
    window,
    location: { protocol: "file:" },
    fetch: () => new Promise(() => {}),
  };
  vm.createContext(sandbox);

  const appPath = path.join(__dirname, "app.js");
  const source = fs.readFileSync(appPath, "utf8");
  const exportsForTest = `\n;globalThis.__appTest = {
    generateRoutes,
    makeTrip,
    tripCardHtml,
    collectRouteCities: typeof collectRouteCities === "function" ? collectRouteCities : undefined,
    updateCitySelection: typeof updateCitySelection === "function" ? updateCitySelection : undefined,
    DEFAULT_DATE_RANGES: typeof DEFAULT_DATE_RANGES === "object" ? DEFAULT_DATE_RANGES : undefined,
    tripMatchesDateRange: typeof tripMatchesDateRange === "function" ? tripMatchesDateRange : undefined,
    handleDatePickerPointerDown: typeof handleDatePickerPointerDown === "function" ? handleDatePickerPointerDown : undefined,
    handleDatePickerKeyDown: typeof handleDatePickerKeyDown === "function" ? handleDatePickerKeyDown : undefined
  };`;
  vm.runInContext(source + exportsForTest, sandbox, { filename: appPath });
  return sandbox.__appTest;
}

function leg(key, direction, origin, destination, departureHour = 0) {
  const departure = new Date(Date.UTC(2026, 0, 1, departureHour));
  const arrival = new Date(Date.UTC(2026, 0, 1, departureHour + 2));
  return {
    key,
    id: key,
    direction,
    origin,
    destination,
    departure,
    arrival,
    departureDateText: "01/01/2026",
    departureDisplay: "01/01 00:00",
    arrivalDisplay: "01/01 02:00",
    durationHours: 2,
    cashCost: 100,
    totalCost: 100,
    points: 0,
    airline: "Test Air",
    flightClass: "Economy",
    splittable: true,
  };
}

function route(routeId, direction, legs) {
  return {
    routeId,
    direction,
    destination: direction === "outbound" ? legs.at(-1).destination : legs[0].origin,
    legs,
    duration: 2,
    layovers: [],
    layoverHours: 0,
    stopCount: Math.max(0, legs.length - 1),
    cashCost: 100,
    totalCost: 100,
    points: 0,
    airlinesUsed: ["Test Air"],
    cabinsUsed: ["Economy"],
    bestCabin: "Economy",
  };
}

const api = loadAppApi();

test("outbound route generation uses the selected origin and destination", () => {
  const routes = api.generateRoutes({
    legs: [leg("out", "outbound", "Rome", "Paris")],
    direction: "outbound",
    originCity: "Rome",
    destinationCity: "Paris",
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].legs[0].origin, "Rome");
  assert.equal(routes[0].destination, "Paris");
});

test("outbound route generation accepts multiple selected origins and destinations", () => {
  const routes = api.generateRoutes({
    legs: [
      leg("perth-madrid", "outbound", "Perth", "Madrid"),
      leg("perth-barcelona", "outbound", "Perth", "Barcelona"),
      leg("adelaide-madrid", "outbound", "Adelaide", "Madrid"),
      leg("adelaide-barcelona", "outbound", "Adelaide", "Barcelona"),
    ],
    direction: "outbound",
    originCities: ["Perth", "Adelaide"],
    destinationCities: ["Madrid", "Barcelona"],
  });

  assert.equal(routes.length, 4);
  assert.deepEqual(
    Array.from(routes, (item) => `${item.legs[0].origin}-${item.destination}`).sort(),
    ["Adelaide-Barcelona", "Adelaide-Madrid", "Perth-Barcelona", "Perth-Madrid"]
  );
});

test("city selection toggles individual cities without replacing existing choices", () => {
  assert.equal(typeof api.updateCitySelection, "function");

  const withBarcelona = api.updateCitySelection(["Madrid"], "Barcelona", true);
  const withoutMadrid = api.updateCitySelection(withBarcelona, "Madrid", false);

  assert.deepEqual(Array.from(withBarcelona).sort(), ["Barcelona", "Madrid"]);
  assert.deepEqual(Array.from(withoutMadrid), ["Barcelona"]);
});

test("return route generation reverses the selected city pair", () => {
  const routes = api.generateRoutes({
    legs: [leg("ret", "return", "Paris", "Rome")],
    direction: "return",
    originCity: "Rome",
    destinationCity: "Paris",
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].legs[0].origin, "Paris");
  assert.equal(routes[0].legs.at(-1).destination, "Rome");
});

test("return routes start at the selected destination, not another city", () => {
  const routes = api.generateRoutes({
    legs: [
      leg("selected", "return", "Paris", "Rome"),
      leg("other", "return", "Berlin", "Rome"),
    ],
    direction: "return",
    originCity: "Rome",
    destinationCity: "Paris",
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].legs[0].origin, "Paris");
});

test("route city choices are unique and sorted from the loaded data", () => {
  assert.equal(typeof api.collectRouteCities, "function");
  assert.deepEqual(
    Array.from(api.collectRouteCities([
      leg("1", "outbound", "Rome", "Paris"),
      leg("2", "return", "Paris", "Rome"),
      leg("3", "outbound", "Berlin", "Rome"),
    ])),
    ["Berlin", "Paris", "Rome"]
  );
});

test("trip cards label the actual selected route instead of Perth", () => {
  const outboundLeg = leg("out", "outbound", "Rome", "Paris");
  const returnLeg = leg("ret", "return", "Paris", "Rome", 4);
  const trip = api.makeTrip(
    route("outbound-route", "outbound", [outboundLeg]),
    route("return-route", "return", [returnLeg]),
    false
  );

  const html = api.tripCardHtml(trip);
  assert.match(html, /<div class="trip-route">ROM/);
  assert.doesNotMatch(html, /<div class="trip-route">PER/);
});

test("date range options provide three configurable ranges with the two existing defaults", () => {
  assert.equal(typeof api.DEFAULT_DATE_RANGES, "object");
  assert.equal(api.DEFAULT_DATE_RANGES.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(api.DEFAULT_DATE_RANGES[0])), {
    id: "range-1",
    label: "Range 1",
    origin: "Perth",
    destination: "Madrid",
    departureStart: "2026-09-21",
    departureEnd: "2026-09-25",
    returnStart: "2026-10-01",
    returnEnd: "2026-10-14",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.DEFAULT_DATE_RANGES[1])), {
    id: "range-2",
    label: "Range 2",
    origin: "Perth",
    destination: "Madrid",
    departureStart: "2026-09-21",
    departureEnd: "2026-09-25",
    returnStart: "2026-10-15",
    returnEnd: "2026-11-05",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.DEFAULT_DATE_RANGES[2])), {
    id: "range-3",
    label: "Range 3",
    origin: "",
    destination: "",
    departureStart: "",
    departureEnd: "",
    returnStart: "",
    returnEnd: "",
  });
});

test("a trip matches a range only when both departure and return dates are inside it", () => {
  assert.equal(typeof api.tripMatchesDateRange, "function");
  const selectedRange = {
    departureStart: "2026-09-21",
    departureEnd: "2026-09-25",
    returnStart: "2026-10-01",
    returnEnd: "2026-10-14",
  };
  const matchingTrip = { departureDateKey: "2026-09-24", returnDepartureDateKey: "2026-10-07" };
  const wrongDeparture = { ...matchingTrip, departureDateKey: "2026-09-26" };
  const wrongReturn = { ...matchingTrip, returnDepartureDateKey: "2026-10-31" };

  assert.equal(api.tripMatchesDateRange(matchingTrip, selectedRange), true);
  assert.equal(api.tripMatchesDateRange(wrongDeparture, selectedRange), false);
  assert.equal(api.tripMatchesDateRange(wrongReturn, selectedRange), false);
});

test("date fields open the native picker and prevent typed date entry", () => {
  assert.equal(typeof api.handleDatePickerPointerDown, "function");
  assert.equal(typeof api.handleDatePickerKeyDown, "function");

  let pickerCalls = 0;
  let pointerDefaultPrevented = false;
  let keyDefaultPrevented = false;
  const dateInput = { showPicker: () => { pickerCalls += 1; } };

  api.handleDatePickerPointerDown({
    currentTarget: dateInput,
    preventDefault: () => { pointerDefaultPrevented = true; },
  });
  api.handleDatePickerKeyDown({
    currentTarget: dateInput,
    key: "2",
    preventDefault: () => { keyDefaultPrevented = true; },
  });
  api.handleDatePickerKeyDown({
    currentTarget: dateInput,
    key: "Enter",
    preventDefault() {},
  });

  assert.equal(pickerCalls, 2);
  assert.equal(pointerDefaultPrevented, true);
  assert.equal(keyDefaultPrevented, true);
});
