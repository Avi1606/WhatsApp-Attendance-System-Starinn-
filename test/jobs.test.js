"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createJobRunner, formatOfficeReport, formatSalaryReport, salaryCycleFor } = require("../src/jobs");

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
    officeManagers: {},
    employeeSalaries: {},
    employeeFines: {},
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

test("formatOfficeReport includes half day section", () => {
  const body = formatOfficeReport(
    {
      office: "Jasola Office",
      absent: ["Avi Kumar", "Suman"],
      noOut: [{ name: "Aditya Shankar", inTime: "10:20" }],
      halfDay: [{ name: "Muskan", inTime: "11:05", outTime: "18:00" }],
    },
    { dateKey: "2026-08-01" },
  );

  assert.match(body, /Daily Attendance Report - Jasola Office/);
  assert.match(body, /Half Day:\n1\. Muskan - IN 11:05, OUT 18:00/);
});

test("salaryCycleFor returns previous 20th to current 20th for payroll run after 20th", () => {
  assert.deepEqual(salaryCycleFor("2026-08-26"), {
    startDateKey: "2026-07-20",
    endDateKey: "2026-08-20",
  });
});

test("formatSalaryReport includes no OUT note and fine section", () => {
  const body = formatSalaryReport(
    {
      name: "Avi Kumar",
      presentDays: 20,
      halfDays: 1,
      absentDays: 2,
      noOutDays: 1,
      maxLeaves: 1,
      salary: 31000,
      perDaySalary: 1000,
      deductionDays: 2.5,
      fine: 500,
      totalPayout: 28000,
    },
    { startDateKey: "2026-07-20", endDateKey: "2026-08-20" },
  );

  assert.match(body, /No OUT marked days: 1/);
  assert.match(body, /Fine: Rs 500/);
  assert.match(body, /not counted as present/);
  assert.match(body, /counted as absent\/not payable/);
});

test("locationDailyReport sends office-wise reports to configured managers", async () => {
  const messages = [];
  const attendance = {
    async getDailyOfficeReport() {
      return [
        {
          office: "Jasola Office",
          absent: ["Avi Kumar"],
          noOut: [{ name: "Aditya Shankar", inTime: "10:20" }],
          halfDay: [{ name: "Muskan", inTime: "11:05", outTime: "" }],
        },
      ];
    },
  };
  const jobs = createJobRunner({
    config: createConfig({ officeManagers: { "Jasola Office": "whatsapp:+919999999999" } }),
    attendance,
    sendMessage: async (to, body) => messages.push({ to, body }),
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    logger: { info() {} },
  });

  const result = await jobs.locationDailyReport();

  assert.deepEqual(result, { sent: 1 });
  assert.equal(messages[0].to, "whatsapp:+919999999999");
  assert.match(messages[0].body, /Half Day:/);
});

test("salaryReport sends salary details to employees with salary configured", async () => {
  const messages = [];
  const attendance = {
    async getSalaryReport() {
      return [
        {
          id: "whatsapp:+910000000001",
          name: "Jasola Employee",
          presentDays: 20,
          halfDays: 1,
          absentDays: 2,
          noOutDays: 1,
          maxLeaves: 1,
          salary: 31000,
          perDaySalary: 968.75,
          deductionDays: 2.5,
          fine: 500,
          totalPayout: 28078.13,
        },
      ];
    },
  };
  const jobs = createJobRunner({
    config: createConfig({ employeeSalaries: { "whatsapp:+910000000001": 31000 } }),
    attendance,
    sendMessage: async (to, body) => messages.push({ to, body }),
    now: () => new Date("2026-08-26T12:00:00.000Z"),
    logger: { info() {} },
  });

  const result = await jobs.salaryReport();

  assert.deepEqual(result, { sent: 1 });
  assert.equal(messages[0].to, "whatsapp:+910000000001");
  assert.match(messages[0].body, /Cycle: 20\/07\/2026 to 20\/08\/2026/);
  assert.match(messages[0].body, /No OUT marked days: 1/);
});
