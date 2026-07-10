// Google Apps Script backend for the Perth -> Europe route finder.
//
// SETUP (see the setup guide for full step-by-step instructions):
// 1. Create a Google Sheet with a tab literally named "flights", whose first
//    row is exactly these headers (same schema as flights.csv):
//    id, direction, leg_order, splittable, origin, destination,
//    departure_date, departure_time, arrival_date, arrival_time, cabin,
//    airline, points, taxes_aud, ticket_aud, active, notes
// 2. Format the departure_date/arrival_date/departure_time/arrival_time
//    columns as Plain Text (Format > Number > Plain text) BEFORE pasting in
//    data, so dates like "25/09/2026" stay as text instead of becoming a
//    Sheets Date value.
// 3. Extensions > Apps Script, delete the default content, paste this file.
// 4. Fill in ALLOWED_EMAILS below with your and your wife's Google account
//    emails.
// 5. Deploy > New deployment > type "Web app".
//      Execute as: Me
//      Who has access: Anyone
//    (Access control is enforced by this script's own ID-token check below,
//    NOT by Apps Script's built-in access setting - "Anyone" avoids relying
//    on cross-site Google session cookies, which some mobile browsers block.)
// 6. Copy the deployment's Web app URL into CONFIG.appsScriptUrl in app.js.

const ALLOWED_EMAILS = [
  "mvbc85@gmail.com",
  "isabel.azzalin@gmail.com",
];

const SHEET_NAME = "flights";

const HEADER = [
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
  "active",
  "notes",
];

function doGet(e) {
  return withAuth(e.parameter.token, function () {
    return textOutput(sheetToCsv());
  });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || "{}");
  return withAuth(body.token, function () {
    appendRows(body.rows || []);
    return jsonOutput({ ok: true });
  });
}

// Verifies the Google ID token server-side and only proceeds if it belongs
// to one of ALLOWED_EMAILS. This is the real access-control boundary - the
// Apps Script deployment itself is reachable by anyone with the URL, but
// every request must carry a valid token for an allowed account.
function withAuth(token, action) {
  const email = verifyIdToken(token);
  if (!email || ALLOWED_EMAILS.indexOf(email) === -1) {
    return jsonOutput({ error: "Not authorised for " + (email || "unknown account") });
  }
  try {
    return action();
  } catch (err) {
    return jsonOutput({ error: String(err) });
  }
}

function verifyIdToken(token) {
  if (!token) return null;
  const response = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) return null;
  const info = JSON.parse(response.getContentText());
  const verified = info.email_verified === "true" || info.email_verified === true;
  return verified ? info.email : null;
}

function getSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab "' + SHEET_NAME + '" not found');
  return sheet;
}

// Reads every row (including the header) using display values, so dates and
// numbers come back exactly as shown in the sheet rather than as Date/number
// objects, and re-serialises it all as CSV text for the app to parse as-is.
function sheetToCsv() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getDisplayValues();
  return values.map(function (row) {
    return row.map(csvEscape).join(",");
  }).join("\n");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

// Appends one row per item in `rows` (each a plain object keyed by the
// column names in HEADER) to the bottom of the sheet.
function appendRows(rows) {
  if (!rows.length) return;
  const sheet = getSheet();
  const values = rows.map(function (row) {
    return HEADER.map(function (key) {
      return row[key] !== undefined ? row[key] : "";
    });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, HEADER.length).setValues(values);
}

function textOutput(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.CSV);
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
