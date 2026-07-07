"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AttendanceStore, HEADER } = require("../src/attendance");
const { createFakeSheets } = require("./helpers/fakeSheets");

const employee = { id: "whatsapp:+910000000000", name: "Avi Kumar" };

function createStore(rows = [[...HEADER]]) {
  const sheets = createFakeSheets(rows);
  const store = new AttendanceStore({
    sheets,
    spreadsheetId: "sheet-id",
    sheetName: "Attendance",
    cacheTtlMs: 0,
  });
  return { sheets, store };
}

test("markAttendance creates header and marks first IN", async () => {
  const { sheets, store } = createStore([]);

  const result = await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-06",
    time: "10:30",
    messageSid: "SM1",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sheets.rows[0], HEADER);
  assert.deepEqual(sheets.rows[1], [
    "Avi Kumar",
    "2026-07-06",
    "10:30",
    "",
    "Present (no OUT)",
    "whatsapp:+910000000000",
    "SM1",
  ]);
});

test("markAttendance prevents OUT before IN", async () => {
  const { store } = createStore();

  const result = await store.markAttendance({
    employee,
    action: "OUT",
    dateKey: "2026-07-06",
    time: "18:30",
    messageSid: "SM2",
  });

  assert.deepEqual(result, { ok: false, reason: "out_before_in" });
});

test("markAttendance updates OUT on the same row", async () => {
  const { sheets, store } = createStore();
  await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-06",
    time: "10:30",
    messageSid: "SM1",
  });

  const result = await store.markAttendance({
    employee,
    action: "OUT",
    dateKey: "2026-07-06",
    time: "18:30",
    messageSid: "SM2",
  });

  assert.equal(result.ok, true);
  assert.equal(sheets.rows.length, 2);
  assert.deepEqual(sheets.rows[1], [
    "Avi Kumar",
    "2026-07-06",
    "10:30",
    "18:30",
    "Present",
    "whatsapp:+910000000000",
    "SM2",
  ]);
});

test("markAttendance inserts newest rows directly below the header", async () => {
  const { sheets, store } = createStore([
    [...HEADER],
    ["Older Employee", "2026-07-05", "10:00", "", "Present (no OUT)", "whatsapp:+910000000001", "OLD"],
  ]);

  await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-06",
    time: "10:30",
    messageSid: "SM1",
  });

  assert.equal(sheets.rows.length, 3);
  assert.equal(sheets.rows[1][0], "Avi Kumar");
  assert.equal(sheets.rows[2][0], "Older Employee");
});

test("markAttendance is idempotent by Twilio message SID", async () => {
  const { sheets, store } = createStore();

  await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-06",
    time: "10:30",
    messageSid: "SM1",
  });
  const duplicate = await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-06",
    time: "10:31",
    messageSid: "SM1",
  });

  assert.equal(duplicate.reason, "already_processed");
  assert.equal(sheets.rows.length, 2);
  assert.equal(sheets.rows[1][2], "10:30");
});

test("getMonthlyReport counts present, absent, and missed OUT rows", async () => {
  const { store } = createStore([
    [...HEADER],
    [employee.name, "2026-07-01", "10:00", "18:00", "Present", employee.id, "SM1"],
    [employee.name, "2026-07-02", "10:00", "", "Present (no OUT)", employee.id, "SM2"],
    [employee.name, "2026-07-03", "", "", "Absent", employee.id, ""],
  ]);

  const report = await store.getMonthlyReport(employee, "2026-07");

  assert.equal(report.present, 1);
  assert.equal(report.noOut, 1);
  assert.equal(report.absent, 1);
  assert.equal(report.presentDays, 2);
  assert.equal(report.rows.length, 3);
});
