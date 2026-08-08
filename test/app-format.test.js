"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSendMessage, formatAttendanceMarked, formatTime12, formatWelcome } = require("../src/app");

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

test("createSendMessage uses a WhatsApp content template when configured", async () => {
  const calls = [];
  const sendMessage = createSendMessage({
    twilioClient: {
      messages: {
        create: async (options) => {
          calls.push(options);
          return { sid: "SM123" };
        },
      },
    },
    fromNumber: "whatsapp:+10000000000",
    contentSid: "HX1234567890",
    logger: { log() {} },
  });

  await sendMessage("whatsapp:+910000000001", "Daily Attendance Report - Noida Office");

  assert.deepEqual(calls[0], {
    from: "whatsapp:+10000000000",
    to: "whatsapp:+910000000001",
    contentSid: "HX1234567890",
    contentVariables: JSON.stringify({ 1: "Daily Attendance Report - Noida Office" }),
  });
});
