"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AttendanceStore, HEADER, dayTypeFor } = require("../src/attendance");
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
    "",
  ]);
});

test("dayTypeFor marks half day after 11 AM or before 5 PM", () => {
  assert.equal(dayTypeFor("11:00"), "");
  assert.equal(dayTypeFor("11:01"), "Half Day");
  assert.equal(dayTypeFor("10:00", "17:00"), "");
  assert.equal(dayTypeFor("10:00", "16:59"), "Half Day");
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
    "",
  ]);
});

test("markAttendance marks half day for late IN after 11 AM", async () => {
  const { sheets, store } = createStore();

  await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-06",
    time: "11:01",
    messageSid: "SM1",
  });

  assert.equal(sheets.rows[1][7], "Half Day");
});

test("markAttendance marks half day for OUT before 5 PM", async () => {
  const { sheets, store } = createStore();
  await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-06",
    time: "10:00",
    messageSid: "SM1",
  });
  await store.markAttendance({
    employee,
    action: "OUT",
    dateKey: "2026-07-06",
    time: "16:59",
    messageSid: "SM2",
  });

  assert.equal(sheets.rows[1][7], "Half Day");
});

test("markAttendance finds IN rows even when Google formats date without leading zero", async () => {
  const { sheets, store } = createStore([
    [...HEADER],
    [employee.name, "8/7/2026", "10:30", "", "Present (no OUT)", employee.id, "SM1"],
  ]);

  const result = await store.markAttendance({
    employee,
    action: "OUT",
    dateKey: "2026-07-08",
    time: "18:30",
    messageSid: "SM2",
  });

  assert.equal(result.ok, true);
  assert.equal(sheets.rows[1][3], "18:30");
});

test("markAttendance matches old rows with trimmed lowercase employee names", async () => {
  const { sheets, store } = createStore([
    [...HEADER],
    [" avi kumar ", "2026-07-08", "10:30", "", "Present (no OUT)", "", "SM1"],
  ]);

  const result = await store.markAttendance({
    employee,
    action: "OUT",
    dateKey: "2026-07-08",
    time: "18:30",
    messageSid: "SM2",
  });

  assert.equal(result.ok, true);
  assert.equal(sheets.rows[1][3], "18:30");
});

test("markAttendance does not close another date's open IN row", async () => {
  const { sheets, store } = createStore([
    [...HEADER],
    [employee.name, "2026-07-07", "10:30", "", "Present (no OUT)", employee.id, "SM1"],
  ]);

  const result = await store.markAttendance({
    employee,
    action: "OUT",
    dateKey: "2026-07-08",
    time: "18:30",
    messageSid: "SM2",
  });

  assert.deepEqual(result, { ok: false, reason: "out_before_in" });
  assert.equal(sheets.rows[1][3], "");
});

test("markAttendance never overwrites an existing IN or OUT for the same date", async () => {
  const { sheets, store } = createStore([
    [...HEADER],
    [employee.name, "2026-07-08", "10:30", "18:30", "Present", employee.id, "SM1"],
  ]);

  const duplicateIn = await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-08",
    time: "10:45",
    messageSid: "SM2",
  });
  const duplicateOut = await store.markAttendance({
    employee,
    action: "OUT",
    dateKey: "2026-07-08",
    time: "19:00",
    messageSid: "SM3",
  });

  assert.equal(duplicateIn.reason, "already_marked");
  assert.equal(duplicateOut.reason, "already_marked");
  assert.equal(sheets.rows.length, 2);
  assert.equal(sheets.rows[1][2], "10:30");
  assert.equal(sheets.rows[1][3], "18:30");
});

test("markAttendance prefers real attendance row over duplicate absent row for the same date", async () => {
  const { sheets, store } = createStore([
    [...HEADER],
    [employee.name, "07/08/2026", "", "", "Absent", employee.id, ""],
    [employee.name, "07/08/2026", "12:23", "", "Present (no OUT)", employee.id, "SM1"],
  ]);

  const duplicateIn = await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-08",
    time: "12:30",
    messageSid: "SM2",
  });
  const out = await store.markAttendance({
    employee,
    action: "OUT",
    dateKey: "2026-07-08",
    time: "18:30",
    messageSid: "SM3",
  });

  assert.equal(duplicateIn.reason, "already_marked");
  assert.equal(out.ok, true);
  assert.equal(sheets.rows[1][2], "");
  assert.equal(sheets.rows[2][2], "12:23");
  assert.equal(sheets.rows[2][3], "18:30");
});

test("markAbsent skips employees whose present row is displayed as month/day/year", async () => {
  const { sheets, store } = createStore([
    [...HEADER],
    [employee.name, "07/08/2026", "12:23", "18:30", "Present", employee.id, "SM1"],
  ]);

  const marked = await store.markAbsent(
    {
      [employee.id]: employee.name,
      "whatsapp:+910000000001": "Other Employee",
    },
    "2026-07-08",
  );

  assert.equal(marked, 1);
  assert.equal(sheets.rows.filter((row) => row[0] === employee.name).length, 1);
  assert.equal(sheets.rows.some((row) => row[0] === "Other Employee" && row[4] === "Absent"), true);
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
