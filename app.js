const APP = {
  travelLegs: [],
  warnings: [],
  trips: [],
  selectedTripId: null,
};

// ====== ONE-TIME SETUP: fill these in after following the setup guide ======
// googleClientId: OAuth 2.0 Client ID from Google Cloud Console (Credentials).
// appsScriptUrl: the "Web app" URL from your Apps Script deployment.
const CONFIG = {
  googleClientId: "207333796897-6dpk4045vvgf1f8lii0e9heved7u63ea.apps.googleusercontent.com",
  appsScriptUrl:
    "https://script.google.com/macros/s/AKfycbwimfV20OmdTaI1fSliNmshaEYpza0W06JFGE-Qj5wCaEZ2bBWYBuDfY9VoIvevQybI/exec",
};

// The Google ID token for whoever is currently signed in. Kept in memory only
// (never persisted) - every request to the Apps Script backend includes it,
// and the backend verifies it server-side against the allow-list of the two
// of you before reading/writing the shared Google Sheet.
let idToken = null;

const EUROPE_CITIES = ["Madrid", "Barcelona"];
const ORIGIN_CITY = "Perth";
const CABIN_RANK = {
  Economy: 1,
  "Premium Economy": 2,
  Business: 3,
  First: 4,
};

// Mirrors the --cabin-* custom properties in styles.css so cabin colour can
// be computed for SVG circle attributes (which can't reference CSS vars).
const CABIN_COLORS = {
  Economy: "#6c7680",
  "Premium Economy": "#4fa3a8",
  Business: "#d98e3f",
  First: "#c96ac0",
};
const CABIN_COLOR_FALLBACK = "#9aa0a6";

// AUD value of one loyalty point, derived from the bundled data (every
// points_value entry in the original sheet divided out to ~0.0053 AUD/point).
// Used to calculate the cash-equivalent value of points automatically instead
// of requiring it to be entered by hand.
const POINTS_VALUE_RATE_AUD = 0.0053;

// IANA timezone for each city in the data set. Used to convert each leg's
// local departure/arrival wall-clock time into a real UTC instant, so
// durations and layovers can be calculated automatically (correctly
// handling daylight saving changes) instead of requiring anyone to work
// them out and type them in by hand.
const CITY_TIMEZONES = {
  Perth: "Australia/Perth",
  Adelaide: "Australia/Adelaide",
  Rome: "Europe/Rome",
  Madrid: "Europe/Madrid",
  Barcelona: "Europe/Madrid",
  Amsterdam: "Europe/Amsterdam",
  Brisbane: "Australia/Brisbane",
};

const refs = {
  loadError: document.getElementById("loadError"),
  mainLayout: document.getElementById("mainLayout"),
  signInGate: document.getElementById("signInGate"),
  googleSignInButton: document.getElementById("googleSignInButton"),
  signInError: document.getElementById("signInError"),
  signedInAs: document.getElementById("signedInAs"),
  filterDestination: document.getElementById("filterDestination"),
  filterCabin: document.getElementById("filterCabin"),
  sortBy: document.getElementById("sortBy"),
  filterToggle: document.getElementById("filterToggle"),
  toolbarFilters: document.getElementById("toolbarFilters"),
  resultCount: document.getElementById("resultCount"),
  clearSelection: document.getElementById("clearSelection"),
  viewToggle: document.getElementById("viewToggle"),
  resultsLayout: document.getElementById("resultsLayout"),
  tripGrid: document.getElementById("tripGrid"),
  scatterChart: document.getElementById("scatterChart"),
  chartEmpty: document.getElementById("chartEmpty"),
  addLegForm: document.getElementById("addLegForm"),
  addLegStatus: document.getElementById("addLegStatus"),
  addLegToggle: document.getElementById("addLegToggle"),
  addLegBody: document.getElementById("addLegBody"),
  tripType: document.getElementById("tripType"),
  onewayFields: document.getElementById("onewayFields"),
  returnFields: document.getElementById("returnFields"),
  downloadCsv: document.getElementById("downloadCsv"),
};

let legSeqCounter = 0;
function nextLegSeq() {
  legSeqCounter += 1;
  return legSeqCounter;
}

wireEvents();
waitForGoogleIdentity();

function wireEvents() {
  refs.filterDestination.addEventListener("change", renderTrips);
  refs.filterCabin.addEventListener("change", renderTrips);
  refs.sortBy.addEventListener("change", renderTrips);
  refs.addLegForm.addEventListener("submit", handleAddLegSubmit);
  refs.addLegForm.addEventListener("input", handlePointsPreviewInput);
  refs.tripType.addEventListener("change", updateTripTypeVisibility);
  refs.downloadCsv.addEventListener("click", exportCsv);
  refs.clearSelection.addEventListener("click", () => selectTrip(null));
  refs.tripGrid.addEventListener("mouseover", handleTripCardHover);
  refs.tripGrid.addEventListener("mouseout", handleTripCardHover);
  refs.viewToggle.addEventListener("click", handleViewToggleClick);
  refs.filterToggle.addEventListener("click", handleFilterToggleClick);
  refs.addLegToggle.addEventListener("click", handleAddLegToggleClick);
  updateTripTypeVisibility();
}

// Mobile-only: the Destination/Cabin/Sort by row is collapsed behind a
// "Filter" button (see .filter-toggle-btn / .toolbar-filters in
// styles.css); above the 760px breakpoint the filters are always visible
// and this button is hidden, so this handler simply has no visible effect.
function handleFilterToggleClick() {
  const isExpanded = refs.toolbarFilters.classList.toggle("is-expanded");
  refs.filterToggle.setAttribute("aria-expanded", String(isExpanded));
}

// "Add a flight option" used to be a native <details>/<summary>; it's now a
// plain button + hidden div so the toggle can sit side by side with the
// Filter button in the same row on mobile (see .panel-actions in
// styles.css). This handler drives the open/closed state on both desktop
// and mobile.
function handleAddLegToggleClick() {
  const isOpen = !refs.addLegBody.hidden;
  refs.addLegBody.hidden = isOpen;
  refs.addLegToggle.setAttribute("aria-expanded", String(!isOpen));
}

// On narrow viewports, the trip list and chart are shown one at a time via
// the Chart/List toggle (see .view-toggle in styles.css); above the 760px
// breakpoint both stay visible side by side and this toggle has no effect.
function handleViewToggleClick(event) {
  const button = event.target.closest(".view-toggle-btn");
  if (!button) return;
  setMobileView(button.dataset.view);
}

function setMobileView(view) {
  refs.resultsLayout.dataset.activeView = view;
  refs.viewToggle.querySelectorAll(".view-toggle-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 760px)").matches;
}

// Google's gsi/client script loads asynchronously, so this polls briefly
// until window.google is available before wiring up the sign-in button -
// avoids a race between script load order and this file's execution.
function waitForGoogleIdentity(retriesLeft = 30) {
  if (window.google && google.accounts && google.accounts.id) {
    initGoogleSignIn();
    return;
  }
  if (retriesLeft <= 0) {
    refs.signInError.hidden = false;
    refs.signInError.textContent = "Could not load Google Sign-In. Check your connection and reload.";
    return;
  }
  setTimeout(() => waitForGoogleIdentity(retriesLeft - 1), 150);
}

function initGoogleSignIn() {
  if (CONFIG.googleClientId.startsWith("YOUR_")) {
    refs.signInError.hidden = false;
    refs.signInError.textContent =
      "Google Sign-In isn't configured yet - set CONFIG.googleClientId in app.js.";
    return;
  }
  google.accounts.id.initialize({
    client_id: CONFIG.googleClientId,
    callback: handleCredentialResponse,
  });
  google.accounts.id.renderButton(refs.googleSignInButton, {
    theme: "outline",
    size: "large",
  });
  google.accounts.id.prompt();
}

function handleCredentialResponse(response) {
  idToken = response.credential;
  const claims = decodeJwtPayload(idToken);
  refs.signInGate.hidden = true;
  refs.signedInAs.hidden = false;
  refs.signedInAs.textContent = claims && claims.email ? `Signed in as ${claims.email}` : "Signed in";
  loadFromSheet();
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded);
  } catch (error) {
    return null;
  }
}

async function loadFromSheet() {
  if (CONFIG.appsScriptUrl.startsWith("YOUR_")) {
    refs.loadError.hidden = false;
    refs.loadError.textContent =
      "The shared Sheet backend isn't configured yet - set CONFIG.appsScriptUrl in app.js.";
    return;
  }
  try {
    const url = `${CONFIG.appsScriptUrl}?token=${encodeURIComponent(idToken)}`;
    const response = await fetch(url);
    const text = await response.text();
    const asJsonError = tryParseErrorResponse(text);
    if (asJsonError) {
      throw new Error(asJsonError);
    }
    hydrateFromCsv(text);
  } catch (error) {
    refs.loadError.hidden = false;
    refs.loadError.textContent = `Could not load flight data: ${error.message}`;
  }
}

// The backend always returns CSV text on success, and a small JSON object
// (e.g. { "error": "..." }) on failure - Apps Script web apps can't set a
// real HTTP error status, so this is how failures are told apart from data.
function tryParseErrorResponse(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed.error || null;
  } catch (error) {
    return null;
  }
}

function hydrateFromCsv(csvText) {
  const parsed = parseCsv(csvText);
  const normalized = normalizeRows(parsed.rows);
  APP.travelLegs = normalized.travelLegs;
  APP.warnings = [...parsed.warnings, ...normalized.warnings];
  rebuildTrips();
}

// Recomputes packages, routes and trips from the current APP.travelLegs and
// re-renders. Called on initial load, and again every time a flight option
// is added through the "Add a flight option" form, so new legs/routes/trips
// show up immediately without needing to edit the CSV file by hand.
function rebuildTrips() {
  if (APP.travelLegs.length === 0) {
    refs.loadError.hidden = false;
    refs.loadError.textContent = "No usable flight legs were found in the flight data.";
    return;
  }
  refs.loadError.hidden = true;

  // An id is a fixed, non-splittable package when any of its rows says so
  // (splittable = FALSE) - its outbound and return legs must stay together
  // and can't be recombined with any other option.
  const packageIds = new Set(
    APP.travelLegs.filter((leg) => !leg.splittable).map((leg) => leg.id)
  );
  const packageLegsById = new Map();
  for (const leg of APP.travelLegs) {
    if (!packageIds.has(leg.id)) continue;
    if (!packageLegsById.has(leg.id)) packageLegsById.set(leg.id, []);
    packageLegsById.get(leg.id).push(leg);
  }
  const mixableLegs = APP.travelLegs.filter((leg) => !packageIds.has(leg.id));

  const outboundRoutes = generateRoutes({ legs: mixableLegs, direction: "outbound" });
  const returnRoutes = generateRoutes({ legs: mixableLegs, direction: "return" });

  const trips = buildAllTrips(outboundRoutes, returnRoutes);

  for (const [id, legs] of packageLegsById.entries()) {
    const packageOutbound = findBestRouteForDirection(legs, "outbound");
    const packageReturn = findBestRouteForDirection(legs, "return");
    if (packageOutbound && packageReturn) {
      trips.unshift(makeTrip(packageOutbound, packageReturn, id === "1"));
    }
  }

  APP.trips = trips;

  populateCabinFilter();
  refs.mainLayout.hidden = false;
  renderTrips();
}

function populateCabinFilter() {
  const cabins = new Set();
  for (const leg of APP.travelLegs) {
    cabins.add(leg.flightClass);
  }
  const ordered = [...cabins].sort((a, b) => (CABIN_RANK[a] || 0) - (CABIN_RANK[b] || 0));

  refs.filterCabin.innerHTML = '<option value="all">Any cabin</option>';
  for (const cabin of ordered) {
    const opt = document.createElement("option");
    opt.value = cabin;
    opt.textContent = cabin;
    refs.filterCabin.appendChild(opt);
  }
}

function updateTripTypeVisibility() {
  const isReturn = refs.tripType.value === "return";
  refs.onewayFields.hidden = isReturn;
  refs.returnFields.hidden = !isReturn;
  // A hidden section's required fields must not block submitting the other
  // section, so required is toggled off/on to match visibility.
  setRequiredWithin(refs.onewayFields, !isReturn);
  setRequiredWithin(refs.returnFields, isReturn);
}

function setRequiredWithin(container, isRequired) {
  container.querySelectorAll("[data-required-when-visible]").forEach((el) => {
    el.required = isRequired;
  });
}

// Fields tagged with data-preview live-update a "points value (calculated)"
// output as the user types, so the AUD equivalent of a points balance is
// always shown but never entered by hand.
function handlePointsPreviewInput(event) {
  const input = event.target;
  if (!input.matches("input[data-preview]")) {
    return;
  }
  const output = document.getElementById(input.dataset.preview);
  if (output) {
    output.textContent = `$${calculatePointsValueAud(toNum(input.value))}`;
  }
}

function resetPointsPreviews() {
  refs.addLegForm.querySelectorAll("input[data-preview]").forEach((input) => {
    const output = document.getElementById(input.dataset.preview);
    if (output) {
      output.textContent = "$0";
    }
  });
}

function handleAddLegSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const get = (name) => String(data.get(name) || "").trim();

  if (get("tripType") === "return") {
    handleAddReturnTrip(get);
  } else {
    handleAddOneWayLeg(get);
  }

  form.reset();
  updateTripTypeVisibility();
  resetPointsPreviews();
}

function handleAddOneWayLeg(get) {
  const fields = readLegFields(get, "ow_");
  fields.id = nextAutoId();
  fields.leg_order = "1";
  // A lone one-way option is never a locked package by itself - it's always
  // available to mix with other outbound/return options.
  fields.splittable = "TRUE";

  const result = buildLegFromFields(fields);
  if (result.error) {
    showAddLegFeedback(`Couldn't add that leg: ${result.error}.`, true);
    return;
  }

  APP.travelLegs.push(result.leg);
  rebuildTrips();
  showAddLegFeedback(
    `Added a one-way ${result.leg.direction} option (id ${result.leg.id}): ${result.leg.origin} \u2192 ${result.leg.destination}.`,
    false
  );
  persistLegsToSheet([result.leg]);
}

function handleAddReturnTrip(get) {
  const outboundFields = readLegFields(get, "out_");
  outboundFields.direction = "outbound";
  outboundFields.leg_order = "1";

  const returnFields = readLegFields(get, "ret_");
  returnFields.direction = "return";
  returnFields.leg_order = "1";

  // A round trip that departs Perth, stops in a single Europe gateway city
  // (Madrid or Barcelona), and returns to Perth from that same city is a
  // fixed return-ticket package - its two legs can't be split apart or
  // recombined with any other option. Anything else (e.g. flying home from
  // a different city, or via a different gateway) stays mixable.
  const isFixedPackage =
    normalizeCity(outboundFields.origin) === ORIGIN_CITY &&
    normalizeCity(returnFields.destination) === ORIGIN_CITY &&
    normalizeCity(outboundFields.destination) === normalizeCity(returnFields.origin) &&
    EUROPE_CITIES.includes(normalizeCity(outboundFields.destination));

  const id = nextAutoId();
  outboundFields.id = id;
  returnFields.id = id;
  outboundFields.splittable = isFixedPackage ? "FALSE" : "TRUE";
  returnFields.splittable = isFixedPackage ? "FALSE" : "TRUE";

  const outboundResult = buildLegFromFields(outboundFields);
  if (outboundResult.error) {
    showAddLegFeedback(`Couldn't add the outbound leg: ${outboundResult.error}.`, true);
    return;
  }
  const returnResult = buildLegFromFields(returnFields);
  if (returnResult.error) {
    showAddLegFeedback(`Couldn't add the return leg: ${returnResult.error}.`, true);
    return;
  }

  APP.travelLegs.push(outboundResult.leg, returnResult.leg);
  rebuildTrips();
  showAddLegFeedback(
    `Added a return trip (id ${id}): ${outboundResult.leg.origin} \u2192 ${outboundResult.leg.destination} and ` +
      `${returnResult.leg.origin} \u2192 ${returnResult.leg.destination}. ` +
      (isFixedPackage
        ? "Marked as a fixed package (can't be mixed with other options)."
        : "Marked as mixable with other options."),
    false
  );
  persistLegsToSheet([outboundResult.leg, returnResult.leg]);
}

// Converts an internal leg object back into a plain row keyed by the same
// column names as the CSV/Sheet schema, so it can be appended remotely.
function legToRow(leg) {
  return {
    id: leg.id,
    direction: leg.direction,
    leg_order: leg.legOrder,
    splittable: leg.splittable ? "TRUE" : "FALSE",
    origin: leg.origin,
    destination: leg.destination,
    departure_date: leg.departureDateText,
    departure_time: leg.departureTimeText,
    arrival_date: leg.arrivalDateText,
    arrival_time: leg.arrivalTimeText,
    cabin: leg.flightClass,
    airline: leg.airline,
    points: leg.points,
    taxes_aud: leg.taxesAud,
    ticket_aud: leg.ticketAud,
    notes: leg.notes,
  };
}

// Sends newly added legs to the shared Apps Script backend so your wife (or
// you, on another device) sees them on next load. The leg is already in
// APP.travelLegs and rendered locally regardless of whether this succeeds -
// if it fails, the change just isn't shared yet, so it's surfaced as a
// warning rather than blocking the (already-completed) local add.
async function persistLegsToSheet(legs) {
  if (CONFIG.appsScriptUrl.startsWith("YOUR_")) return;
  try {
    const response = await fetch(CONFIG.appsScriptUrl, {
      method: "POST",
      // text/plain avoids a CORS preflight request, which Apps Script web
      // apps can't respond to - the body is still JSON, just parsed
      // manually as text server-side.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: idToken, rows: legs.map(legToRow) }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
  } catch (error) {
    showAddLegFeedback(
      `Added locally, but couldn't save to the shared sheet yet: ${error.message}. Try reloading and re-adding it later.`,
      true
    );
  }
}

function readLegFields(get, prefix) {
  return {
    origin: get(`${prefix}origin`),
    destination: get(`${prefix}destination`),
    departure_date: get(`${prefix}departure_date`),
    departure_time: get(`${prefix}departure_time`),
    arrival_date: get(`${prefix}arrival_date`),
    arrival_time: get(`${prefix}arrival_time`),
    cabin: get(`${prefix}cabin`),
    airline: get(`${prefix}airline`),
    points: get(`${prefix}points`),
    taxes_aud: get(`${prefix}taxes_aud`),
    ticket_aud: get(`${prefix}ticket_aud`),
    notes: get(`${prefix}notes`),
    direction: get(`${prefix}direction`),
  };
}

function nextAutoId() {
  const numericIds = APP.travelLegs
    .map((leg) => Number(leg.id))
    .filter((n) => Number.isFinite(n));
  const max = numericIds.length ? Math.max(...numericIds) : 0;
  return String(max + 1);
}

function showAddLegFeedback(message, isError) {
  refs.addLegStatus.textContent = message;
  refs.addLegStatus.classList.toggle("is-error", isError);
  refs.addLegStatus.classList.toggle("is-success", !isError);
  refs.addLegStatus.hidden = false;
}

// Serialises the current in-memory legs (bundled CSV plus anything added
// through the form) back into the same CSV schema, so changes made in the
// browser can be saved back to disk and picked up next time.
function buildCsvText() {
  const header = [
    "id",
    "direction",
    "leg_order",
    "splittable",
    "origin",
    "destination",
    "departure_date",
    "departure_time",
    "arrival_date",
    "arrival_time",
    "cabin",
    "airline",
    "points",
    "taxes_aud",
    "ticket_aud",
    "notes",
  ];

  const lines = [header.join(",")];
  for (const leg of APP.travelLegs) {
    lines.push(
      [
        leg.id,
        leg.direction,
        leg.legOrder,
        leg.splittable ? "TRUE" : "FALSE",
        leg.origin,
        leg.destination,
        leg.departureDateText,
        leg.departureTimeText,
        leg.arrivalDateText,
        leg.arrivalTimeText,
        leg.flightClass,
        leg.airline,
        leg.points,
        leg.taxesAud,
        leg.ticketAud,
        leg.notes,
      ]
        .map(csvField)
        .join(",")
    );
  }
  return lines.join("\n");
}

function csvField(value) {
  const text = String(value == null ? "" : value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function exportCsv() {
  downloadTextFile(buildCsvText(), "flights.csv");
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function parseCsv(text) {
  const warnings = [];
  const rows = [];

  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    warnings.push("CSV has no data rows.");
    return { rows, warnings };
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());

  for (let i = 1; i < lines.length; i += 1) {
    const raw = splitCsvLine(lines[i]);
    if (raw.length === 1 && raw[0].trim() === "") {
      continue;
    }

    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = raw[j] == null ? "" : raw[j].trim();
    }
    row.__line = i + 1;
    rows.push(row);
  }

  return { rows, warnings };
}

function splitCsvLine(line) {
  const out = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cell);
      cell = "";
      continue;
    }

    cell += ch;
  }

  out.push(cell);
  return out;
}

function normalizeRows(rows) {
  const warnings = [];
  const travelLegs = [];

  for (const row of rows) {
    const result = buildLegFromFields(row);
    if (result.error) {
      warnings.push(`Line ${row.__line}: ${result.error}, row skipped.`);
      continue;
    }
    for (const warning of result.warnings) {
      warnings.push(`Line ${row.__line}: ${warning}`);
    }
    travelLegs.push(result.leg);
  }

  return { travelLegs, warnings };
}

// Builds a single travel-leg object from a plain object of field values using
// the same column names as the CSV (origin, destination, departure_date,
// etc.). Shared by CSV parsing (normalizeRows) and the "Add a flight option"
// form, so both paths validate and compute duration/points-value identically.
// Returns { leg, warnings } on success, or { error } if the fields can't be
// turned into a usable leg.
function buildLegFromFields(fields) {
  const warnings = [];
  const origin = normalizeCity(fields.origin);
  const destination = normalizeCity(fields.destination);
  const direction = normalizeDirection(fields.direction);

  if (!origin || !destination) {
    return { error: "missing origin or destination" };
  }

  if (direction !== "outbound" && direction !== "return") {
    return { error: `unrecognised direction "${fields.direction}"` };
  }

  const departure = parseZonedDateTime(fields.departure_date, fields.departure_time, origin, warnings);
  const arrival = parseZonedDateTime(fields.arrival_date, fields.arrival_time, destination, warnings);

  if (!departure || !arrival) {
    return { error: `missing or invalid timestamp for travel leg ${origin} -> ${destination}` };
  }

  if (departure > arrival) {
    return { error: `departure after arrival for ${origin} -> ${destination}` };
  }

  const ticket = toNum(fields.ticket_aud);
  const taxes = toNum(fields.taxes_aud);
  const points = toNum(fields.points);
  const giftCardValue = calculatePointsValueAud(points);
  const cashCost = ticket + taxes;

  const leg = {
    key: `leg-${nextLegSeq()}`,
    id: normalizeId(fields.id),
    direction,
    splittable: normalizeSplittable(fields.splittable),
    legOrder: toNum(fields.leg_order),
    origin,
    destination,
    departure,
    arrival,
    departureDateText: formatDateDDMMYYYY(fields.departure_date),
    departureTimeText: String(fields.departure_time || "").trim(),
    arrivalDateText: formatDateDDMMYYYY(fields.arrival_date),
    arrivalTimeText: String(fields.arrival_time || "").trim(),
    departureDisplay: formatLocalDisplay(fields.departure_date, fields.departure_time),
    arrivalDisplay: formatLocalDisplay(fields.arrival_date, fields.arrival_time),
    durationHours: Math.max(0, (arrival - departure) / 36e5),
    ticketAud: ticket,
    taxesAud: taxes,
    cashCost,
    giftCardValue,
    totalCost: cashCost + giftCardValue,
    points,
    flightClass: String(fields.cabin || "").trim() || "Unknown",
    airline: String(fields.airline || "Unknown").trim() || "Unknown",
    notes: String(fields.notes || "").trim(),
  };

  return { leg, warnings };
}

// The AUD-equivalent value of a points balance is always derived from the
// points themselves (points * rate), never entered by hand, so it can't ever
// drift out of sync with the number of points on a leg.
function calculatePointsValueAud(points) {
  return Math.round(points * POINTS_VALUE_RATE_AUD);
}

function normalizeId(rawId) {
  const v = String(rawId || "").trim();
  return v || "Unknown";
}

function normalizeDirection(rawDirection) {
  return String(rawDirection || "").trim().toLowerCase();
}

function normalizeSplittable(rawSplittable) {
  const v = String(rawSplittable || "").trim().toLowerCase();
  return v !== "false";
}

function normalizeCity(rawCity) {
  return String(rawCity || "").trim();
}

// Accepts either "DD/MM/YYYY" (the CSV format) or the native <input
// type="date"> format "YYYY-MM-DD", so the add-leg form can use a real date
// picker while the CSV keeps its existing format.
function parseDateParts(rawDate) {
  const date = String(rawDate || "").trim();
  const dmy = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    return { day: Number(dmy[1]), month: Number(dmy[2]), year: Number(dmy[3]) };
  }
  const iso = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return { day: Number(iso[3]), month: Number(iso[2]), year: Number(iso[1]) };
  }
  return null;
}

function formatDateDDMMYYYY(rawDate) {
  const parts = parseDateParts(rawDate);
  if (!parts) {
    return String(rawDate || "").trim();
  }
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}/${parts.year}`;
}

function formatLocalDisplay(rawDate, rawTime) {
  const time = String(rawTime || "").trim();
  const parts = parseDateParts(rawDate);
  if (!parts) {
    return `${String(rawDate || "").trim()} ${time}`.trim();
  }
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")} ${time}`;
}

function parseZonedDateTime(rawDate, rawTime, city, warnings) {
  const time = String(rawTime || "").trim();
  const parts = parseDateParts(rawDate);
  const tm = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!parts || !tm) {
    return null;
  }

  const timeZone = CITY_TIMEZONES[city];
  if (!timeZone) {
    warnings.push(`no known timezone for "${city}", treating its local time as UTC.`);
  }

  const hour = Number(tm[1]);
  const minute = Number(tm[2]);

  const ms = zonedTimeToUtcMs(parts.year, parts.month, parts.day, hour, minute, timeZone || "UTC");
  return new Date(ms);
}

// Converts a wall-clock date/time in a given IANA timezone into the correct
// UTC instant, using the "guess and correct" technique: interpret the wall
// clock as if it were UTC, see what that instant actually looks like when
// formatted in the target zone, then correct for the difference. This lets
// the browser's own timezone database (which already knows every DST rule)
// do all the work, so nobody has to manually calculate flight durations or
// layover times across timezones.
function zonedTimeToUtcMs(year, month, day, hour, minute, timeZone) {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = {};
  for (const part of formatter.formatToParts(new Date(guessUtcMs))) {
    parts[part.type] = part.value;
  }

  const shownAsUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  const offsetMs = shownAsUtcMs - guessUtcMs;
  return guessUtcMs - offsetMs;
}

function toNum(value) {
  const n = Number(String(value || "").trim());
  return Number.isFinite(n) ? n : 0;
}

function findBestRouteForDirection(legs, direction) {
  const routes = generateRoutes({ legs, direction, maxHops: 6 });
  if (routes.length === 0) {
    return null;
  }
  return routes.sort((a, b) => a.duration - b.duration)[0];
}

function generateRoutes({ legs, direction, maxHops = 6 }) {
  const validLegs = legs.filter(
    (leg) => leg.direction === direction && leg.departure && leg.arrival
  );

  const adjacency = new Map();
  const hasIncoming = new Set();
  for (const leg of validLegs) {
    if (!adjacency.has(leg.origin)) {
      adjacency.set(leg.origin, []);
    }
    adjacency.get(leg.origin).push(leg);
    hasIncoming.add(leg.destination);
  }

  for (const [city, cityLegs] of adjacency.entries()) {
    cityLegs.sort((a, b) => a.departure - b.departure);
    adjacency.set(city, cityLegs);
  }

  const routes = [];

  if (direction === "outbound") {
    dfsRoutes({
      adjacency,
      city: ORIGIN_CITY,
      targetCities: new Set(EUROPE_CITIES),
      legs: [],
      routes,
      maxHops,
      visited: new Set([ORIGIN_CITY]),
      direction,
    });
  } else {
    // A valid return start is Madrid/Barcelona, or any city that nothing
    // else in the return-only graph flies into (a genuine chain head, not
    // an interior connection like Brisbane, which only exists downstream
    // of Amsterdam).
    const candidateStarts = new Set(EUROPE_CITIES);
    for (const city of adjacency.keys()) {
      if (city !== ORIGIN_CITY && !hasIncoming.has(city)) {
        candidateStarts.add(city);
      }
    }
    candidateStarts.delete(ORIGIN_CITY);

    for (const start of candidateStarts) {
      dfsRoutes({
        adjacency,
        city: start,
        targetCities: new Set([ORIGIN_CITY]),
        legs: [],
        routes,
        maxHops,
        visited: new Set([start]),
        direction,
      });
    }
  }

  return dedupeRoutes(routes);
}

function dfsRoutes({
  adjacency,
  city,
  targetCities,
  legs,
  routes,
  maxHops,
  visited,
  direction,
}) {
  if (legs.length > maxHops) {
    return;
  }

  if (targetCities.has(city) && legs.length > 0) {
    routes.push(buildRouteObject(legs, direction));
    return;
  }

  const options = adjacency.get(city) || [];
  const prev = legs[legs.length - 1] || null;

  for (const option of options) {
    if (visited.has(option.destination)) {
      continue;
    }

    if (prev && option.departure < prev.arrival) {
      continue;
    }

    const nextLegs = legs.concat(option);
    const nextVisited = new Set(visited);
    nextVisited.add(option.destination);

    dfsRoutes({
      adjacency,
      city: option.destination,
      targetCities,
      legs: nextLegs,
      routes,
      maxHops,
      visited: nextVisited,
      direction,
    });
  }
}

function buildRouteObject(legs, direction) {
  const destination = direction === "outbound" ? legs[legs.length - 1].destination : legs[0].origin;
  const routeId = `${direction}-${legs.map((l) => l.key).join("|")}`;
  const layovers = computeLayovers(legs);
  const layoverHours = sum(layovers, "hours");
  // Every departure/arrival is stored as a real UTC instant (converted from
  // its own city's local time), so total elapsed time is a plain subtraction
  // between the first departure and the last arrival - timezone changes are
  // already accounted for.
  const duration = (legs[legs.length - 1].arrival - legs[0].departure) / 36e5;

  return {
    routeId,
    direction,
    destination,
    legs,
    duration,
    layovers,
    layoverHours,
    stopCount: Math.max(0, legs.length - 1),
    cashCost: sum(legs, "cashCost"),
    totalCost: sum(legs, "totalCost"),
    points: sum(legs, "points"),
    airlinesUsed: [...new Set(legs.map((l) => l.airline))],
    cabinsUsed: [...new Set(legs.map((l) => l.flightClass))],
    bestCabin: bestCabinForLegs(legs),
  };
}

// When a route is made of several legs (e.g. a splittable itinerary with a
// stopover), the highest cabin flown on any leg is treated as that
// direction's representative cabin for colour-coding purposes.
function bestCabinForLegs(legs) {
  return legs.reduce((best, leg) => {
    const legRank = CABIN_RANK[leg.flightClass] || 0;
    const bestRank = CABIN_RANK[best] || 0;
    return legRank > bestRank ? leg.flightClass : best;
  }, legs[0] ? legs[0].flightClass : "Economy");
}

function computeLayovers(legs) {
  const layovers = [];
  for (let i = 1; i < legs.length; i += 1) {
    layovers.push({
      city: legs[i].origin,
      hours: (legs[i].departure - legs[i - 1].arrival) / 36e5,
    });
  }
  return layovers;
}

function dedupeRoutes(routes) {
  const seen = new Set();
  const out = [];
  for (const route of routes) {
    const key = route.legs.map((l) => l.key).join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(route);
  }
  return out;
}

function sum(items, field) {
  return items.reduce((acc, item) => acc + (Number(item[field]) || 0), 0);
}

function buildAllTrips(outboundRoutes, returnRoutes) {
  const trips = [];

  // Returns may start from a different city than the outbound arrival (e.g.
  // arrive into Madrid, but fly home from Amsterdam), so every outbound is
  // paired with every return rather than requiring matching cities.
  for (const outbound of outboundRoutes) {
    for (const ret of returnRoutes) {
      trips.push(makeTrip(outbound, ret, false));
    }
  }

  return trips;
}

function makeTrip(outbound, ret, isCurrentBooking) {
  return {
    tripId: `${outbound.routeId}::${ret.routeId}`,
    destination: outbound.destination,
    returnOrigin: ret.legs[0].origin,
    outboundLegs: outbound.legs,
    returnLegs: ret.legs,
    outboundDuration: outbound.duration,
    returnDuration: ret.duration,
    outboundLayovers: outbound.layovers,
    returnLayovers: ret.layovers,
    duration: outbound.duration + ret.duration,
    stopCount: outbound.stopCount + ret.stopCount,
    cashCost: outbound.cashCost + ret.cashCost,
    totalCost: outbound.totalCost + ret.totalCost,
    points: outbound.points + ret.points,
    cabinsUsed: [...new Set(outbound.cabinsUsed.concat(ret.cabinsUsed))],
    outboundCabin: outbound.bestCabin,
    returnCabin: ret.bestCabin,
    isCurrentBooking,
  };
}

function bestCabinRank(trip) {
  return trip.cabinsUsed.reduce((max, cabin) => Math.max(max, CABIN_RANK[cabin] || 0), 0);
}

function renderTrips() {
  const destinationFilter = refs.filterDestination.value;
  const cabinFilter = refs.filterCabin.value;
  const sortBy = refs.sortBy.value;

  let trips = APP.trips.filter((trip) =>
    destinationFilter === "all" ? true : trip.destination === destinationFilter
  );

  trips = trips.filter((trip) =>
    cabinFilter === "all" ? true : trip.cabinsUsed.includes(cabinFilter)
  );

  trips = trips.slice().sort((a, b) => {
    if (sortBy === "total") {
      return a.totalCost - b.totalCost || a.duration - b.duration;
    }
    if (sortBy === "cash") {
      return a.cashCost - b.cashCost || a.duration - b.duration;
    }
    if (sortBy === "cabin") {
      return bestCabinRank(b) - bestCabinRank(a) || a.duration - b.duration;
    }
    return a.duration - b.duration || a.totalCost - b.totalCost;
  });

  // A trip picked on the scatter chart stays selected across filter/sort
  // changes, but if it's since been filtered out entirely the selection is
  // dropped so the list doesn't get stuck empty for no visible reason.
  if (APP.selectedTripId && !trips.some((trip) => trip.tripId === APP.selectedTripId)) {
    APP.selectedTripId = null;
  }

  const listTrips = APP.selectedTripId
    ? trips.filter((trip) => trip.tripId === APP.selectedTripId)
    : trips;

  refs.resultCount.textContent = APP.selectedTripId
    ? `Showing 1 of ${trips.length} route${trips.length === 1 ? "" : "s"}`
    : `${trips.length} route${trips.length === 1 ? "" : "s"}`;
  refs.clearSelection.hidden = !APP.selectedTripId;

  refs.tripGrid.innerHTML = listTrips.length
    ? listTrips.map(tripCardHtml).join("")
    : '<p class="empty-note">No routes match these filters.</p>';

  renderScatterChart(trips);
}

// Selecting a dot on the scatter chart narrows the list on the left down to
// that single trip; clicking the same dot again (or the "show all" button)
// clears the selection and restores the full filtered list. On mobile,
// where only one of chart/list is visible at a time, newly selecting a trip
// also switches the view to the list so the isolated card is visible.
function selectTrip(tripId) {
  const wasSelected = APP.selectedTripId === tripId;
  APP.selectedTripId = wasSelected ? null : tripId;
  renderTrips();
  if (!wasSelected && APP.selectedTripId && isMobileViewport()) {
    setMobileView("list");
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_WIDTH = 760;
const CHART_HEIGHT = 720;
const CHART_MARGIN = { top: 24, right: 32, bottom: 60, left: 84 };
const CHART_TICKS = 5;

// Plots every currently-filtered trip as a dot: x = total travel time,
// y = total cost, dot radius = cash cost. Each dot is split into two
// coloured halves - left = outbound cabin, right = return cabin - so mixed
// cabin trips are obviously two-toned instead of relying on a thin (and
// easily missed) border colour. Clicking a dot narrows the list on the left
// down to that one trip; clicking it again restores the full list.
function renderScatterChart(trips) {
  if (!refs.scatterChart) {
    return;
  }

  refs.scatterChart.innerHTML = "";
  refs.scatterChart.setAttribute("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);

  if (refs.chartEmpty) {
    refs.chartEmpty.hidden = trips.length > 0;
  }

  if (!trips.length) {
    return;
  }

  const plotLeft = CHART_MARGIN.left;
  const plotTop = CHART_MARGIN.top;
  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;

  const durations = trips.map((t) => t.duration);
  const costs = trips.map((t) => t.totalCost);
  const cashCosts = trips.map((t) => t.cashCost);

  const xDomain = niceDomain(Math.min(...durations), Math.max(...durations));
  const yDomain = niceDomain(Math.min(...costs), Math.max(...costs));
  const cashMin = Math.min(...cashCosts);
  const cashMax = Math.max(...cashCosts);

  const xScale = (value) => plotLeft + ratio(value, xDomain) * plotWidth;
  const yScale = (value) => plotTop + plotHeight - ratio(value, yDomain) * plotHeight;
  const rScale = (value) => {
    const minR = 10;
    const maxR = 36;
    if (cashMax === cashMin) {
      return (minR + maxR) / 2;
    }
    // Square-root scale so a dot's visual area (not just radius) is
    // proportional to its cash cost.
    return minR + Math.sqrt((value - cashMin) / (cashMax - cashMin)) * (maxR - minR);
  };

  const svg = refs.scatterChart;
  svg.appendChild(
    chartGridAndAxes(xDomain, yDomain, xScale, yScale, plotLeft, plotTop, plotWidth, plotHeight)
  );

  // Draw larger dots first so small/cheap trips never get hidden behind big ones.
  const ordered = trips.slice().sort((a, b) => b.cashCost - a.cashCost);

  for (const trip of ordered) {
    svg.appendChild(scatterDot(trip, xScale, yScale, rScale));
  }
}

// Rounds a [min, max] data range out to friendlier tick boundaries and pads
// both ends by a fraction of the range, so the smallest/largest values are
// plotted with visible clearance instead of sitting right on an axis line.
function niceDomain(min, max) {
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.12;
  return { min: min - pad, max: max + pad };
}

function ratio(value, domain) {
  return (value - domain.min) / (domain.max - domain.min);
}

function chartGridAndAxes(xDomain, yDomain, xScale, yScale, left, top, width, height) {
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "chart-axes");

  for (let i = 0; i <= CHART_TICKS; i += 1) {
    const t = i / CHART_TICKS;

    const xValue = xDomain.min + t * (xDomain.max - xDomain.min);
    const x = xScale(xValue);
    group.appendChild(svgLine(x, top, x, top + height, "chart-gridline"));
    group.appendChild(svgText(x, top + height + 18, `${xValue.toFixed(0)}h`, "chart-tick-label chart-tick-x"));

    const yValue = yDomain.min + t * (yDomain.max - yDomain.min);
    const y = yScale(yValue);
    group.appendChild(svgLine(left, y, left + width, y, "chart-gridline"));
    group.appendChild(svgText(left - 10, y + 4, `$${yValue.toFixed(0)}`, "chart-tick-label chart-tick-y"));
  }

  group.appendChild(svgLine(left, top, left, top + height, "chart-axis-line"));
  group.appendChild(svgLine(left, top + height, left + width, top + height, "chart-axis-line"));

  group.appendChild(
    svgText(left + width / 2, top + height + 38, "Total travel time", "chart-axis-title")
  );

  const yTitle = svgText(0, 0, "Total cost (AUD)", "chart-axis-title chart-axis-title-y");
  yTitle.setAttribute("transform", `translate(${left - 40}, ${top + height / 2}) rotate(-90)`);
  group.appendChild(yTitle);

  return group;
}

function svgLine(x1, y1, x2, y2, className) {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", x1.toFixed(1));
  line.setAttribute("y1", y1.toFixed(1));
  line.setAttribute("x2", x2.toFixed(1));
  line.setAttribute("y2", y2.toFixed(1));
  line.setAttribute("class", className);
  return line;
}

function svgText(x, y, text, className) {
  const el = document.createElementNS(SVG_NS, "text");
  el.setAttribute("x", x.toFixed(1));
  el.setAttribute("y", y.toFixed(1));
  el.setAttribute("class", className);
  el.textContent = text;
  return el;
}

function scatterDot(trip, xScale, yScale, rScale) {
  const cx = xScale(trip.duration);
  const cy = yScale(trip.totalCost);
  const r = rScale(trip.cashCost);
  const isSelected = trip.tripId === APP.selectedTripId;

  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute(
    "class",
    `scatter-dot${trip.isCurrentBooking ? " is-current" : ""}${isSelected ? " is-selected" : ""}`
  );
  group.setAttribute("data-trip-id", trip.tripId);
  group.setAttribute("tabindex", "0");
  group.setAttribute("role", "button");

  const outboundHalf = document.createElementNS(SVG_NS, "path");
  outboundHalf.setAttribute("d", halfCirclePath(cx, cy, r, "left"));
  outboundHalf.setAttribute("fill", CABIN_COLORS[trip.outboundCabin] || CABIN_COLOR_FALLBACK);
  outboundHalf.setAttribute("class", "scatter-half");

  const returnHalf = document.createElementNS(SVG_NS, "path");
  returnHalf.setAttribute("d", halfCirclePath(cx, cy, r, "right"));
  returnHalf.setAttribute("fill", CABIN_COLORS[trip.returnCabin] || CABIN_COLOR_FALLBACK);
  returnHalf.setAttribute("class", "scatter-half");

  const outline = document.createElementNS(SVG_NS, "circle");
  outline.setAttribute("cx", cx.toFixed(1));
  outline.setAttribute("cy", cy.toFixed(1));
  outline.setAttribute("r", r.toFixed(1));
  outline.setAttribute("class", "scatter-outline");

  const sameGateway = trip.returnOrigin === trip.destination;
  const routeLabel = sameGateway
    ? `PER \u2194 ${cityCode(trip.destination)}`
    : `PER \u2192 ${cityCode(trip.destination)} \u00b7\u00b7\u00b7 ${cityCode(trip.returnOrigin)} \u2192 PER`;

  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = [
    routeLabel,
    `Total cost: $${trip.totalCost.toFixed(0)}`,
    `Cash cost: $${trip.cashCost.toFixed(0)}`,
    `Total travel: ${trip.duration.toFixed(1)}h`,
    `Outbound cabin: ${trip.outboundCabin}`,
    `Return cabin: ${trip.returnCabin}`,
    "Click to isolate this trip in the list",
  ].join("\n");

  group.appendChild(outboundHalf);
  group.appendChild(returnHalf);
  group.appendChild(outline);
  group.appendChild(title);

  group.addEventListener("click", () => selectTrip(trip.tripId));
  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTrip(trip.tripId);
    }
  });

  return group;
}

// Builds the path for one half of a circle split along its vertical
// diameter, so two adjacent paths can each be filled with their own colour.
function halfCirclePath(cx, cy, r, side) {
  const top = `${cx.toFixed(2)} ${(cy - r).toFixed(2)}`;
  const bottom = `${cx.toFixed(2)} ${(cy + r).toFixed(2)}`;
  const sweep = side === "right" ? 1 : 0;
  return `M ${top} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 ${sweep} ${bottom} Z`;
}

const CITY_CODES = {
  Perth: "PER",
  Madrid: "MAD",
  Barcelona: "BCN",
  Amsterdam: "AMS",
  Rome: "ROM",
  Adelaide: "ADL",
  Brisbane: "BNE",
};

function cityCode(city) {
  return CITY_CODES[city] || String(city || "").slice(0, 3).toUpperCase();
}

// Hovering a trip card highlights its matching dot on the scatter chart.
// Delegated on the grid container so it keeps working after every re-render.
function handleTripCardHover(event) {
  const card = event.target.closest(".trip");
  if (!card) return;
  const related = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest(".trip") : null;
  if (related === card) return;
  setDotHighlight(card.dataset.tripId, event.type === "mouseover");
}

function setDotHighlight(tripId, isHighlighted) {
  const dot = refs.scatterChart.querySelector(`g.scatter-dot[data-trip-id="${CSS.escape(tripId)}"]`);
  if (!dot) return;
  dot.classList.toggle("is-hovered", isHighlighted);
  if (isHighlighted) {
    dot.parentNode.appendChild(dot);
  }
}

function tripCardHtml(trip) {
  const currentTag = trip.isCurrentBooking
    ? '<span class="current-tag">Currently booked</span>'
    : "";

  const sameGateway = trip.returnOrigin === trip.destination;
  const routeTitle = sameGateway
    ? `PER <span class="arrow">&#8646;</span> ${cityCode(trip.destination)}`
    : `PER <span class="arrow">&rarr;</span> ${cityCode(trip.destination)}` +
      `<span class="route-gap">&middot;&middot;&middot;</span>` +
      `${cityCode(trip.returnOrigin)} <span class="arrow">&rarr;</span> PER`;

  return `
    <article class="trip ${trip.isCurrentBooking ? "is-current" : ""}" data-trip-id="${trip.tripId}">
      <div class="trip-top">
        <div class="trip-route">${routeTitle}</div>
        ${currentTag}
      </div>
      <div class="trip-body">
        <div class="leg-block">
          <span class="leg-group-label">Outbound <span class="leg-group-duration">${trip.outboundDuration.toFixed(1)}h</span></span>
          ${layoverNoteHtml(trip.outboundLayovers)}
          <ol class="leg-list">${legListHtml(trip.outboundLegs)}</ol>
        </div>
        <div class="leg-block">
          <span class="leg-group-label">Return <span class="leg-group-duration">${trip.returnDuration.toFixed(1)}h</span></span>
          ${layoverNoteHtml(trip.returnLayovers)}
          <ol class="leg-list">${legListHtml(trip.returnLegs)}</ol>
        </div>
      </div>
      <div class="trip-foot">
        <div class="stat">
          <span class="stat-value">$${trip.totalCost.toFixed(0)}</span>
          <span class="stat-label">Total cost</span>
        </div>
        <div class="stat">
          <span class="stat-value">$${trip.cashCost.toFixed(0)}</span>
          <span class="stat-label">Cash cost</span>
        </div>
        ${
          trip.points > 0
            ? `<div class="stat">
                <span class="stat-value">${formatPoints(trip.points)}</span>
                <span class="stat-label">Points used</span>
              </div>`
            : ""
        }
        <div class="stat">
          <span class="stat-value">${trip.duration.toFixed(1)}h</span>
          <span class="stat-label">Total travel</span>
        </div>
        <div class="stat">
          <span class="stat-value">${trip.stopCount}</span>
          <span class="stat-label">Stop${trip.stopCount === 1 ? "" : "s"}</span>
        </div>
      </div>
    </article>
  `;
}

function legListHtml(legs) {
  return legs
    .map(
      (leg) => `
      <li class="leg-row">
        <span class="leg-route">${leg.origin} &rarr; ${leg.destination}</span>
        <div class="leg-meta">
          <span class="cabin-tag ${cabinClassName(leg.flightClass)}">${leg.flightClass}</span>
          <span>${leg.airline}</span>
          <span>&middot;</span>
          <span>${leg.departureDisplay}</span>
        </div>
      </li>`
    )
    .join("");
}

function layoverNoteHtml(layovers) {
  if (!layovers || layovers.length === 0) {
    return "";
  }
  const text = layovers
    .map((l) => `${l.hours.toFixed(1)}h in ${l.city}`)
    .join(", ");
  return `<div class="layover-note">Layover: ${text}</div>`;
}

function cabinClassName(cabin) {
  return `cabin-${String(cabin || "unknown").toLowerCase().replace(/\s+/g, "-")}`;
}

function formatPoints(points) {
  if (points >= 1000) {
    return `${(points / 1000).toFixed(1)}k`;
  }
  return `${points}`;
}

