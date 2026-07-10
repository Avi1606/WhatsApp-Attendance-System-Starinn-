"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { formatAttendanceMarked, formatTime12, formatWelcome } = require("../src/app");

test("formatTime12 converts 24-hour time to readable WhatsApp time", () => {
  assert.equal(formatTime12("00:05"), "12:05 am");
  assert.equal(formatTime12("11:49"), "11:49 am");
  assert.equal(formatTime12("18:30"), "6:30 pm");
});

test("formatWelcome shows clear enabled commands", () => {
  const message = formatWelcome("Avi Kumar", { reportsEnabled: true });

  assert.match(message, /Hello Avi Kumar/);
  assert.match(message, /Reply \*in\* for Office IN/);
  assert.match(message, /Reply \*out\* for Office OUT/);
  assert.match(message, /Reply \*report\* for monthly report/);
  assert.doesNotMatch(message, /status/);
});

test("formatWelcome hides report command when reports are paused", () => {
  const message = formatWelcome("Avi Kumar", { reportsEnabled: false });

  assert.doesNotMatch(message, /report/);
});

test("formatAttendanceMarked creates plain attendance reply for admin usage", () => {
  const message = formatAttendanceMarked("IN", "Avi Kumar", "07/07/2026", "11:49");

  assert.equal(
    message,
    [
      "Office IN marked!",
      "Employee: Avi Kumar",
      "Date: 07/07/2026",
      "Time: 11:49 am",
    ].join("\n"),
  );
});
