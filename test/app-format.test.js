"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSendMessage, chunkMessage, formatAttendanceMarked, formatTime12, formatWelcome } = require("../src/app");

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

test("chunkMessage splits messages exceeding 1500 chars cleanly with part tags", () => {
  const header = "Daily Attendance Report - South Ex Office Date: 15/08/2026";
  const lines = Array.from({ length: 50 }, (_, i) => `${i + 1}. Employee ${i + 1} - IN 10:50, OUT 19:25`);
  const longBody = `${header}\n${lines.join("\n")}`;

  const chunks = chunkMessage(longBody, 1500);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1500);
  }
  assert.match(chunks[0], /\(Part 1\/\d+\)/);
  assert.match(chunks[1], /\(Part 2\/\d+\)/);
});

test("createSendMessage sends multi-part messages when body exceeds 1500 chars", async () => {
  const calls = [];
  const sendMessage = createSendMessage({
    twilioClient: {
      messages: {
        create: async (options) => {
          calls.push(options);
          return { sid: `SM${calls.length}` };
        },
      },
    },
    fromNumber: "whatsapp:+10000000000",
    logger: { log() {} },
  });

  const header = "Daily Attendance Report - South Ex Office Date: 15/08/2026";
  const lines = Array.from({ length: 60 }, (_, i) => `${i + 1}. Employee ${i + 1} - IN 10:50, OUT 19:25`);
  const longBody = `${header}\n${lines.join("\n")}`;

  const result = await sendMessage("whatsapp:+910000000001", longBody);

  assert.ok(Array.isArray(result));
  assert.ok(result.length > 1);
  assert.equal(calls.length, result.length);
  assert.match(calls[0].body, /\(Part 1\/\d+\)/);
});

test("createSendMessage retries with contentSid if plain text fails with Error 63016", async () => {
  const calls = [];
  const sendMessage = createSendMessage({
    twilioClient: {
      messages: {
        create: async (options) => {
          calls.push(options);
          if (!options.contentSid) {
            const err = new Error("Error 63016: Outside messaging window. For WhatsApp, use a Message Template instead");
            err.code = 63016;
            throw err;
          }
          return { sid: "SM_TEMPLATE_SUCCESS" };
        },
      },
    },
    fromNumber: "whatsapp:+10000000000",
    contentSid: "HX1234567890",
    logger: { log() {}, warn() {} },
  });

  const result = await sendMessage("whatsapp:+910000000001", "Daily Attendance Report - Jasola Office");

  assert.equal(calls.length, 1);
  assert.equal(result.sid, "SM_TEMPLATE_SUCCESS");
});

