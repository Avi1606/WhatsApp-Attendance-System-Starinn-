"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { displayDate, normalizeDate, normalizeMonthFirstDate, sheetDateMatches, zonedDateTime } = require("../src/time");

test("normalizeDate accepts ISO and Indian display dates", () => {
  assert.equal(normalizeDate("2026-07-06"), "2026-07-06");
  assert.equal(normalizeDate("06/07/2026"), "2026-07-06");
  assert.equal(normalizeDate("6/7/2026"), "2026-07-06");
  assert.equal(normalizeDate("6-7-2026"), "2026-07-06");
});

test("sheetDateMatches accepts Google Sheets month/day display for current date matching", () => {
  assert.equal(normalizeMonthFirstDate("07/08/2026"), "2026-07-08");
  assert.equal(sheetDateMatches("07/08/2026", "2026-07-08"), true);
});

test("normalizeDate rejects impossible and malformed dates", () => {
  assert.equal(normalizeDate("31/02/2026"), null);
  assert.equal(normalizeDate("2026/07/06"), null);
  assert.equal(normalizeDate(""), null);
});

test("displayDate formats a normalized date", () => {
  assert.equal(displayDate("2026-07-06"), "06/07/2026");
});

test("zonedDateTime returns stable Asia/Kolkata values", () => {
  const value = zonedDateTime(new Date("2026-07-06T05:00:00.000Z"), "Asia/Kolkata");

  assert.equal(value.dateKey, "2026-07-06");
  assert.equal(value.displayDate, "06/07/2026");
  assert.equal(value.monthKey, "2026-07");
  assert.equal(value.time, "10:30");
  assert.equal(value.weekday, "Mon");
});
