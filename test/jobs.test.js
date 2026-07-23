"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createJobRunner } = require("../src/jobs");

function createConfig(overrides = {}) {
  return {
    employees: {
      "whatsapp:+910000000001": "Jasola Employee",
      "whatsapp:+910000000002": "Noida Employee",
      "whatsapp:+910000000003": "South Ex Employee",
      "whatsapp:+910000000004": "No Location Employee",
    },
    employeeLocations: {
      "whatsapp:+910000000001": "Jasola Office",
      "whatsapp:+910000000002": "Noida Office",
      "whatsapp:+910000000003": "South Ex Office",
    },
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]),
    holidays: new Set(),
    timezone: "Asia/Kolkata",
    adminNumber: "whatsapp:+910000000001",
    ...overrides,
  };
}

test("autoAbsent marks all employees on Sunday", async () => {
  let markedEmployees;
  const attendance = {
    async markAbsent(employees) {
      markedEmployees = employees;
      return Object.keys(employees).length;
    },
  };
  const jobs = createJobRunner({
    config: createConfig(),
    attendance,
    sendMessage: async () => undefined,
    now: () => new Date("2026-07-19T12:00:00.000Z"),
    logger: { info() {} },
  });

  const result = await jobs.autoAbsent();

  assert.equal(result.markedAbsent, 4);
  assert.deepEqual(Object.keys(markedEmployees).sort(), [
    "whatsapp:+910000000001",
    "whatsapp:+910000000002",
    "whatsapp:+910000000003",
    "whatsapp:+910000000004",
  ]);
});

test("autoAbsent marks all employees on normal working days", async () => {
  let markedEmployees;
  const attendance = {
    async markAbsent(employees) {
      markedEmployees = employees;
      return Object.keys(employees).length;
    },
  };
  const jobs = createJobRunner({
    config: createConfig(),
    attendance,
    sendMessage: async () => undefined,
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    logger: { info() {} },
  });

  const result = await jobs.autoAbsent();

  assert.equal(result.markedAbsent, 4);
  assert.deepEqual(Object.keys(markedEmployees).sort(), [
    "whatsapp:+910000000001",
    "whatsapp:+910000000002",
    "whatsapp:+910000000003",
    "whatsapp:+910000000004",
  ]);
});

test("autoAbsent still skips configured holidays", async () => {
  const attendance = {
    async markAbsent() {
      throw new Error("holiday should skip regular auto absent job");
    },
  };
  const jobs = createJobRunner({
    config: createConfig({ holidays: new Set(["2026-07-19"]) }),
    attendance,
    sendMessage: async () => undefined,
    now: () => new Date("2026-07-19T12:00:00.000Z"),
    logger: { info() {} },
  });

  const result = await jobs.autoAbsent();

  assert.deepEqual(result, { skipped: "holiday", sent: 0 });
});
