"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AttendanceStore, HEADER, remarksFor, lateFor, attendanceNotesFor } = require("../src/attendance");
const { createFakeSheets } = require("./helpers/fakeSheets");

const employee = { id: "whatsapp:+910000000000", name: "Avi Kumar", location: "Delhi Office" };

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
    "Late",
    "Delhi Office",
  ]);
});

test("remarksFor marks half day and lateFor marks late separately", () => {
  assert.equal(lateFor("10:15"), "");
  assert.equal(lateFor("10:16"), "Late");
  assert.equal(lateFor("11:00"), "Late");
  assert.equal(lateFor("11:01", "Half Day"), "");
  assert.equal(remarksFor("11:00"), "");
  assert.equal(remarksFor("11:01"), "Half Day");
  assert.equal(remarksFor("10:00", "17:00"), "");
  assert.equal(remarksFor("10:00", "16:59"), "Half Day");
});

test("attendanceNotesFor leaves remarks and late blank for time-exempt employees", () => {
  const notes = attendanceNotesFor({ ...employee, timeExempt: true }, "12:30", "16:00");

  assert.deepEqual(notes, { remarks: "", late: "" });
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
    "Late",
    "Delhi Office",
  ]);
});

test("markAttendance marks late for IN after 10:15 AM", async () => {
  const { sheets, store } = createStore();

  await store.markAttendance({
    employee,
    action: "IN",
    dateKey: "2026-07-06",
    time: "10:16",
    messageSid: "SM1",
  });

  assert.equal(sheets.rows[1][7], "");
  assert.equal(sheets.rows[1][8], "Late");
  assert.equal(sheets.rows[1][9], "Delhi Office");
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
  assert.equal(sheets.rows[1][8], "");
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
  assert.equal(sheets.rows[1][8], "");
});

test("markAttendance does not mark late or half day for time-exempt employees", async () => {
  const { sheets, store } = createStore();

  await store.markAttendance({
    employee: { ...employee, timeExempt: true },
    action: "IN",
    dateKey: "2026-07-06",
    time: "12:30",
    messageSid: "SM1",
  });
  await store.markAttendance({
    employee: { ...employee, timeExempt: true },
    action: "OUT",
    dateKey: "2026-07-06",
    time: "16:00",
    messageSid: "SM2",
  });

  assert.equal(sheets.rows[1][7], "");
  assert.equal(sheets.rows[1][8], "");
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
    {
      [employee.id]: employee.location,
      "whatsapp:+910000000001": "Noida Office",
    },
  );

  assert.equal(marked, 1);
  assert.equal(sheets.rows.filter((row) => row[0] === employee.name).length, 1);
  assert.equal(sheets.rows.some((row) => row[0] === "Other Employee" && row[4] === "Absent"), true);
  assert.equal(sheets.rows.find((row) => row[0] === "Other Employee")[9], "Noida Office");
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

test("getDailyOfficeReport groups absent, no OUT, late, and half day by office", async () => {
  const employees = {
    [employee.id]: employee.name,
    "whatsapp:+910000000001": "Aditya Shankar",
    "whatsapp:+910000000002": "Muskan",
    "whatsapp:+910000000003": "Ritika",
  };
  const locations = {
    [employee.id]: "Jasola Office",
    "whatsapp:+910000000001": "Jasola Office",
    "whatsapp:+910000000002": "Jasola Office",
    "whatsapp:+910000000003": "Jasola Office",
  };
  const { store } = createStore([
    [...HEADER],
    ["Aditya Shankar", "2026-08-01", "10:20", "", "Present (no OUT)", "whatsapp:+910000000001", "SM1", "", "Late", "Jasola Office"],
    ["Ritika", "2026-08-01", "10:30", "18:00", "Present", "whatsapp:+910000000003", "SM3", "", "Late", "Jasola Office"],
    ["Muskan", "2026-08-01", "11:05", "18:00", "Present", "whatsapp:+910000000002", "SM2", "Half Day", "", "Jasola Office"],
  ]);

  const [report] = await store.getDailyOfficeReport(employees, locations, "2026-08-01");

  assert.equal(report.office, "Jasola Office");
  assert.deepEqual(report.absent, ["Avi Kumar"]);
  assert.deepEqual(report.noOut, [{ name: "Aditya Shankar", inTime: "10:20" }]);
  assert.deepEqual(report.late, [{ name: "Aditya Shankar", inTime: "10:20", outTime: "" }, { name: "Ritika", inTime: "10:30", outTime: "18:00" }]);
  assert.deepEqual(report.halfDay, [{ name: "Muskan", inTime: "11:05", outTime: "18:00" }]);
});

test("getSalaryReport counts no OUT as unpaid and reads max leaves, salary, and fine columns", async () => {
  const salaryHeader = [...HEADER, "Max Leaves", "Salary", "Fine"];
  const { store } = createStore([
    salaryHeader,
    [employee.name, "2026-07-20", "10:00", "18:00", "Present", employee.id, "SM1", "", "", "Delhi Office", "1", "31000", "500"],
    [employee.name, "2026-07-21", "10:00", "", "Present (no OUT)", employee.id, "SM2", "", "", "Delhi Office", "1", "31000", "500"],
    [employee.name, "2026-07-22", "", "", "Absent", employee.id, "", "", "", "Delhi Office", "1", "31000", "500"],
    [employee.name, "2026-07-23", "", "", "Absent", employee.id, "", "", "", "Delhi Office", "1", "31000", "500"],
  ]);

  const [report] = await store.getSalaryReport({
    employees: { [employee.id]: employee.name },
    employeeLocations: { [employee.id]: employee.location },
    startDateKey: "2026-07-20",
    endDateKey: "2026-08-20",
  });

  assert.equal(report.cycleDays, 32);
  assert.equal(report.presentDays, 1);
  assert.equal(report.noOutDays, 1);
  assert.equal(report.absentDays, 2);
  assert.equal(report.maxLeaves, 1);
  assert.equal(report.unpaidAbsentDays, 1);
  assert.equal(report.deductionDays, 2);
  assert.equal(report.salary, 31000);
  assert.equal(report.fine, 500);
  assert.equal(report.totalPayout, 28562.5);
});

test("getSalaryReport reads already-calculated salary sheet columns", async () => {
  const salaryHeader = [
    "Name",
    "Employee ID",
    "Present Days",
    "Half Days",
    "Absent Days",
    "Per Day Salary",
    "Maximum Allowed Leaves",
    "Final Payout",
    "Late",
  ];
  const sheets = createFakeSheets({
    Attendance: [
      [...HEADER],
      [employee.name, "2026-07-21", "10:00", "", "Present (no OUT)", employee.id, "SM1", "", "", employee.location],
    ],
    Salary: [
      salaryHeader,
      [employee.name, employee.id, "20", "2", "3", "1000", "4", "27000", "5"],
    ],
  });
  const store = new AttendanceStore({
    sheets,
    spreadsheetId: "sheet-id",
    sheetName: "Attendance",
    cacheTtlMs: 0,
  });

  const [report] = await store.getSalaryReport({
    employees: { [employee.id]: employee.name },
    employeeLocations: { [employee.id]: employee.location },
    salarySheetName: "Salary",
    startDateKey: "2026-07-20",
    endDateKey: "2026-08-20",
  });

  assert.equal(report.presentDays, 20);
  assert.equal(report.halfDays, 2);
  assert.equal(report.absentDays, 3);
  assert.equal(report.noOutDays, 1);
  assert.equal(report.perDaySalary, 1000);
  assert.equal(report.maxLeaves, 4);
  assert.equal(report.totalPayout, 27000);
  assert.equal(report.lateDays, 5);
});
