"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  StaffStore,
  normalizeWhatsAppNumber,
  normalizeOfficeLocation,
  isLeftFromRemarks,
  extractLeftDate,
} = require("../src/staff");
const { createApp, parseStaffLeftCommand, parseSendDailyReportCommand } = require("../src/app");
const { createJobRunner } = require("../src/jobs");

function createMockSheets(rows) {
  const currentRows = JSON.parse(JSON.stringify(rows));
  const updates = [];
  return {
    rows: currentRows,
    updates,
    spreadsheets: {
      values: {
        get: async () => ({
          data: { values: currentRows },
        }),
        update: async ({ range, requestBody }) => {
          updates.push({ range, values: requestBody.values });
          return { data: { updatedRange: range } };
        },
      },
    },
  };
}

const SAMPLE_MASTER_ROWS = [
  ["Name", "ACCOUNT HOLDER NAME", "ACCOUNT NO", "IFSC CODE", "BANK NAME", "Role", "Phone", "Office Location", "Salary", "Remarks", "Status", "Left Date", "Time Exempt"],
  ["Raju Mishra", "RAJU MISHRA", "7316428495", "IDIB000S211", "INDIAN BANK", "Floor Manager", "9899242080", "SOUTH EX", "₹41,140.00", "", "Active", "", ""],
  ["Mukesh Bhatt", "MUKESH BHATT", "1047325972", "KKBK0004607", "KOTAK BANK", "Office Boy", "7533848039", "SOUTH EX", "₹12,000.00", "", "Active", "", ""],
  ["Shekhar", "SHEKHAR KUMAR", "5045170336", "KKBK0005033", "KOTAK BANK", "Office Boy", "8506078814", "NOIDA", "₹18,000.00", "", "Active", "", ""],
  ["Saraswati", "SARASWATI SHAKYA", "4346415238", "KKBK0004659", "KOTAK BANK", "Tme", "8287093965", "NOIDA", "₹26,000.00", "Left date 10th September", "Left", "2026-09-10", ""],
  ["Preeti", "PREETI", "1111111111", "KKBK0004659", "KOTAK BANK", "Tme", "7017939254", "NOIDA", "₹20,000.00", "DOJ: 24-06-2026, LEFT", "", "", ""],
];

test("normalizeWhatsAppNumber normalizes 10-digit Indian numbers and existing formats", () => {
  assert.equal(normalizeWhatsAppNumber("9899242080"), "whatsapp:+919899242080");
  assert.equal(normalizeWhatsAppNumber("+919899242080"), "whatsapp:+919899242080");
  assert.equal(normalizeWhatsAppNumber("919899242080"), "whatsapp:+919899242080");
  assert.equal(normalizeWhatsAppNumber("whatsapp:+919899242080"), "whatsapp:+919899242080");
  assert.equal(normalizeWhatsAppNumber(""), "");
});

test("normalizeOfficeLocation maps aliases to standard office names", () => {
  assert.equal(normalizeOfficeLocation("SOUTH EX"), "South Ex Office");
  assert.equal(normalizeOfficeLocation("NOIDA"), "Noida Office");
  assert.equal(normalizeOfficeLocation("JASOLA"), "Jasola Office");
  assert.equal(normalizeOfficeLocation("OPC"), "OPC");
  assert.equal(normalizeOfficeLocation("South Ex Office"), "South Ex Office");
  assert.equal(normalizeOfficeLocation("Custom Place"), "Custom Place");
});

test("isLeftFromRemarks detects resignation and left keywords", () => {
  assert.equal(isLeftFromRemarks("Left date 10th September"), true);
  assert.equal(isLeftFromRemarks("DOJ: 24-06-2026, LEFT"), true);
  assert.equal(isLeftFromRemarks("Resigned on Monday"), true);
  assert.equal(isLeftFromRemarks("Relieved from duties"), true);
  assert.equal(isLeftFromRemarks("Working fine in team"), false);
  assert.equal(isLeftFromRemarks(""), false);
});

test("extractLeftDate parses text and ISO dates from remarks", () => {
  assert.equal(extractLeftDate("Left date 10th September", 2026), "2026-09-10");
  assert.equal(extractLeftDate("left - 8 sep", 2026), "2026-09-08");
  assert.equal(extractLeftDate("2026-09-01"), "2026-09-01");
  assert.equal(extractLeftDate("01/09/2026"), "2026-09-01");
});

test("StaffStore parses Master Staff Data and separates active from left staff", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const store = new StaffStore({
    sheets: mockSheets,
    spreadsheetId: "test-id",
    sheetName: "Master Staff Data",
  });

  const staffData = await store.getStaffData();
  assert.equal(Object.keys(staffData.allEmployees).length, 5);
  // Raju, Mukesh, Shekhar are active; Saraswati and Preeti are left
  assert.equal(Object.keys(staffData.employees).length, 3);
  assert.equal(staffData.employees["whatsapp:+919899242080"], "Raju Mishra");
  assert.equal(staffData.employees["whatsapp:+917533848039"], "Mukesh Bhatt");
  assert.equal(staffData.employees["whatsapp:+918506078814"], "Shekhar");
  assert.equal(staffData.employees["whatsapp:+918287093965"], undefined); // Left
  assert.equal(staffData.employees["whatsapp:+917017939254"], undefined); // Left from remarks
});

test("StaffStore respects targetDateKey for staff left on or after that date", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const store = new StaffStore({
    sheets: mockSheets,
    spreadsheetId: "test-id",
    sheetName: "Master Staff Data",
  });

  // On 2026-09-08, Saraswati (left 2026-09-10) was still active!
  const pastData = await store.getStaffData({ targetDateKey: "2026-09-08" });
  assert.equal(pastData.employees["whatsapp:+918287093965"], "Saraswati");

  // On 2026-09-12, Saraswati was already left!
  const futureData = await store.getStaffData({ targetDateKey: "2026-09-12" });
  assert.equal(futureData.employees["whatsapp:+918287093965"], undefined);
});

test("StaffStore marks employee left and updates Google Sheet", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const store = new StaffStore({
    sheets: mockSheets,
    spreadsheetId: "test-id",
    sheetName: "Master Staff Data",
  });

  const result = await store.markEmployeeLeft("Shekhar", "2026-09-14");
  assert.equal(result.ok, true);
  assert.equal(result.employee.name, "Shekhar");
  assert.equal(result.employee.status, "Left");
  assert.equal(result.employee.leftDate, "2026-09-14");

  // Verify updates sent to sheets
  assert.equal(mockSheets.updates.length >= 2, true);
});

test("parseStaffLeftCommand parses staff left command variants", () => {
  assert.deepEqual(parseStaffLeftCommand("staff left Raju Mishra"), {
    name: "Raju Mishra",
    leftDate: null,
  });
  assert.deepEqual(parseStaffLeftCommand("staff left Mukesh Bhatt 14/09/2026"), {
    name: "Mukesh Bhatt",
    leftDate: "14/09/2026",
  });
  assert.deepEqual(parseStaffLeftCommand("staff left Shekhar 2026-09-14"), {
    name: "Shekhar",
    leftDate: "2026-09-14",
  });
  assert.equal(parseStaffLeftCommand("hello"), null);
});

function dispatch(app, { method = "POST", url = "/webhook", body = {} }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const querystring = require("querystring");
      const postData = querystring.stringify(body);
      const http = require("http");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: url,
          method,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            server.close(() => resolve({ status: res.statusCode, body: data }));
          });
        },
      );
      req.on("error", (err) => {
        server.close(() => reject(err));
      });
      req.write(postData);
      req.end();
    });
  });
}

test("Webhook blocks left/inactive staff from marking attendance", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const mockTwilioLib = () => ({ messages: { create: async () => ({}) } });
  const config = {
    spreadsheetId: "test-id",
    sheetName: "Attendance",
    staffSheetName: "Master Staff Data",
    twilioFromNumber: "whatsapp:+17543423324",
    adminNumber: "whatsapp:+918780901324",
    admins: new Set(["whatsapp:+918780901324"]),
    employees: {
      "whatsapp:+918287093965": "Saraswati",
    },
    employeeLocations: {},
    timeExemptEmployees: new Set(),
    officeManagers: {},
    timezone: "Asia/Kolkata",
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    holidays: new Set(),
    reportsEnabled: false,
    twilioSid: "mock-twilio-sid",
    twilioToken: "secret",
    cronSecret: "secret",
    validateTwilioSignature: false,
  };

  const app = createApp({
    config,
    sheets: mockSheets,
    twilioLib: mockTwilioLib,
    validateTwilioSignature: false,
  });

  // Test sending 'in' from Saraswati (who is Left in Master Staff Data)
  const res = await dispatch(app, {
    body: {
      From: "whatsapp:+918287093965",
      Body: "in",
      MessageSid: "TEST-INACTIVE-1",
    },
  });

  assert.match(res.body, /inactive/i);
});

test("Webhook handles admin refresh staff command", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const mockTwilioLib = () => ({ messages: { create: async () => ({}) } });
  const config = {
    spreadsheetId: "test-id",
    sheetName: "Attendance",
    staffSheetName: "Master Staff Data",
    twilioFromNumber: "whatsapp:+17543423324",
    adminNumber: "whatsapp:+918780901324",
    admins: new Set(["whatsapp:+918780901324"]),
    employees: { "whatsapp:+918780901324": "Admin User" },
    employeeLocations: {},
    timeExemptEmployees: new Set(),
    officeManagers: {},
    timezone: "Asia/Kolkata",
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    holidays: new Set(),
    reportsEnabled: false,
    twilioSid: "mock-twilio-sid",
    twilioToken: "secret",
    cronSecret: "secret",
    validateTwilioSignature: false,
  };

  const app = createApp({
    config,
    sheets: mockSheets,
    twilioLib: mockTwilioLib,
    validateTwilioSignature: false,
  });

  const res = await dispatch(app, {
    body: {
      From: "whatsapp:+918780901324",
      Body: "refresh staff",
      MessageSid: "TEST-REFRESH-1",
    },
  });

  assert.match(res.body, /Staff list refreshed from Google Sheets/i);
  assert.match(res.body, /Active staff:/i);
});

test("Webhook handles admin staff status command", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const mockTwilioLib = () => ({ messages: { create: async () => ({}) } });
  const config = {
    spreadsheetId: "test-id",
    sheetName: "Attendance",
    staffSheetName: "Master Staff Data",
    twilioFromNumber: "whatsapp:+17543423324",
    adminNumber: "whatsapp:+918780901324",
    admins: new Set(["whatsapp:+918780901324"]),
    employees: { "whatsapp:+918780901324": "Admin User" },
    employeeLocations: {},
    timeExemptEmployees: new Set(),
    officeManagers: {},
    timezone: "Asia/Kolkata",
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    holidays: new Set(),
    reportsEnabled: false,
    twilioSid: "mock-twilio-sid",
    twilioToken: "secret",
    cronSecret: "secret",
    validateTwilioSignature: false,
  };

  const app = createApp({
    config,
    sheets: mockSheets,
    twilioLib: mockTwilioLib,
    validateTwilioSignature: false,
  });

  const res = await dispatch(app, {
    body: {
      From: "whatsapp:+918780901324",
      Body: "staff status",
      MessageSid: "TEST-STATUS-1",
    },
  });

  assert.match(res.body, /Staff Status Summary/i);
  assert.match(res.body, /Total Active:/i);
  assert.match(res.body, /Inactive \/ Left:/i);
});

test("Webhook handles admin staff left command and updates sheet", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const mockTwilioLib = () => ({ messages: { create: async () => ({}) } });
  const config = {
    spreadsheetId: "test-id",
    sheetName: "Attendance",
    staffSheetName: "Master Staff Data",
    twilioFromNumber: "whatsapp:+17543423324",
    adminNumber: "whatsapp:+918780901324",
    admins: new Set(["whatsapp:+918780901324"]),
    employees: { "whatsapp:+918780901324": "Admin User" },
    employeeLocations: {},
    timeExemptEmployees: new Set(),
    officeManagers: {},
    timezone: "Asia/Kolkata",
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    holidays: new Set(),
    reportsEnabled: false,
    twilioSid: "mock-twilio-sid",
    twilioToken: "secret",
    cronSecret: "secret",
    validateTwilioSignature: false,
  };

  const app = createApp({
    config,
    sheets: mockSheets,
    twilioLib: mockTwilioLib,
    validateTwilioSignature: false,
  });

  const res = await dispatch(app, {
    body: {
      From: "whatsapp:+918780901324",
      Body: "staff left Mukesh Bhatt 14/09/2026",
      MessageSid: "TEST-STAFF-LEFT-1",
    },
  });

  assert.match(res.body, /Staff marked as Left in Google Sheets/i);
  assert.match(res.body, /Mukesh Bhatt/i);
});

test("Non-admin sender is blocked from admin staff commands", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const mockTwilioLib = () => ({ messages: { create: async () => ({}) } });
  const config = {
    spreadsheetId: "test-id",
    sheetName: "Attendance",
    staffSheetName: "Master Staff Data",
    twilioFromNumber: "whatsapp:+17543423324",
    adminNumber: "whatsapp:+918780901324",
    admins: new Set(["whatsapp:+918780901324"]),
    employees: { "whatsapp:+919899242080": "Raju Mishra" },
    employeeLocations: {},
    timeExemptEmployees: new Set(),
    officeManagers: {},
    timezone: "Asia/Kolkata",
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    holidays: new Set(),
    reportsEnabled: false,
    twilioSid: "mock-twilio-sid",
    twilioToken: "secret",
    cronSecret: "secret",
    validateTwilioSignature: false,
  };

  const app = createApp({
    config,
    sheets: mockSheets,
    twilioLib: mockTwilioLib,
    validateTwilioSignature: false,
  });

  const res = await dispatch(app, {
    body: {
      From: "whatsapp:+919899242080", // Raju is not admin
      Body: "refresh staff",
      MessageSid: "TEST-UNAUTH-1",
    },
  });

  assert.match(res.body, /Only admins can refresh the staff list/i);
});

test("createJobRunner with StaffStore excludes left employees from autoAbsent and morning", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const store = new StaffStore({
    sheets: mockSheets,
    spreadsheetId: "test-id",
    sheetName: "Master Staff Data",
  });

  const markedAbsentList = [];
  const fakeAttendance = {
    getDailyMap: async () => new Map(),
    markAbsent: async (employees) => {
      markedAbsentList.push(...Object.keys(employees));
      return Object.keys(employees).length;
    },
  };

  const sentMessages = [];
  const config = {
    timezone: "Asia/Kolkata",
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    holidays: new Set(),
    employees: {},
    employeeLocations: {},
    timeExemptEmployees: new Set(),
    officeManagers: {},
  };

  const jobs = createJobRunner({
    config,
    attendance: fakeAttendance,
    staffStore: store,
    sendMessage: async (to, body) => {
      sentMessages.push({ to, body });
    },
    now: () => new Date("2026-09-14T10:30:00Z"),
  });

  await jobs.autoAbsent();
  // Saraswati and Preeti should NOT be marked absent
  assert.equal(markedAbsentList.includes("whatsapp:+918287093965"), false);
  assert.equal(markedAbsentList.includes("whatsapp:+917017939254"), false);
  // Raju, Mukesh, Shekhar SHOULD be marked absent
  assert.equal(markedAbsentList.includes("whatsapp:+919899242080"), true);
});

test("StaffStore and AttendanceStore exclude Jim Corbett staff from active operations", async () => {
  const { AttendanceStore } = require("../src/attendance");
  const rowsWithCorbett = [
    ...SAMPLE_MASTER_ROWS,
    ["Devi Singh", "DEVI SINGH", "123456", "SBIN0001", "SBI", "Manager", "6397775099", "JIM CORBETT", "₹20,000.00", "", "Active", "", ""],
  ];
  const mockSheets = createMockSheets(rowsWithCorbett);
  const store = new StaffStore({
    sheets: mockSheets,
    spreadsheetId: "test-id",
    sheetName: "Master Staff Data",
    fallbackConfig: {
      officeManagers: {
        "South Ex Office": ["whatsapp:+919899242080"],
      },
    },
  });

  const staffData = await store.getStaffData();
  // Devi Singh is in allEmployees (data record)
  assert.equal(staffData.allEmployees["whatsapp:+916397775099"], "Devi Singh");
  // Devi Singh is NOT in active employees map (not counted / not reported)
  assert.equal(staffData.employees["whatsapp:+916397775099"], undefined);

  // Devi Singh role is 'Manager' but should NOT be in officeManagers
  assert.equal(staffData.officeManagers["JIM CORBETT"], undefined);
  assert.deepEqual(staffData.officeManagers["South Ex Office"], ["whatsapp:+919899242080"]);

  // AttendanceStore markAbsent skips Corbett
  const attMockSheets = createMockSheets([
    ["Name", "Location", "Date", "In Time", "Out Time", "Status", "Total Hours", "Late/On Time", "Phone", "Remarks"],
  ]);
  const attStore = new AttendanceStore({
    sheets: attMockSheets,
    spreadsheetId: "test-id",
    sheetName: "Attendance",
  });

  // Even if an employees object had Corbett passed, markAbsent skips it
  const marked = await attStore.markAbsent(
    { "whatsapp:+916397775099": "Devi Singh" },
    "2026-09-14",
    { "whatsapp:+916397775099": "JIM CORBETT" }
  );
  assert.equal(marked, 0);

  // getDailyOfficeReport skips Corbett
  const reports = await attStore.getDailyOfficeReport(
    { "whatsapp:+916397775099": "Devi Singh", "whatsapp:+919899242080": "Raju Mishra" },
    { "whatsapp:+916397775099": "JIM CORBETT", "whatsapp:+919899242080": "South Ex Office" },
    "2026-09-14"
  );
  assert.equal(reports.some((r) => /corbett/i.test(r.office)), false);
  assert.equal(reports.some((r) => r.office === "South Ex Office"), true);
});

test("Webhook allows office manager to request daily report and isolates office", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const mockTwilioLib = () => ({ messages: { create: async () => ({}) } });
  const config = {
    spreadsheetId: "test-id",
    sheetName: "Attendance",
    staffSheetName: "Master Staff Data",
    twilioFromNumber: "whatsapp:+17543423324",
    adminNumber: "whatsapp:+918780901324",
    admins: new Set(["whatsapp:+918780901324"]),
    employees: {
      "whatsapp:+919899242080": "Raju Mishra",
      "whatsapp:+917533848039": "Mukesh Bhatt",
    },
    employeeLocations: {
      "whatsapp:+919899242080": "South Ex Office",
      "whatsapp:+917533848039": "South Ex Office",
    },
    timeExemptEmployees: new Set(),
    officeManagers: {
      "South Ex Office": ["whatsapp:+919899242080"],
    },
    employeeSalaries: {},
    employeeFines: {},
    timezone: "Asia/Kolkata",
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    holidays: new Set(),
    reportsEnabled: false,
    twilioSid: "mock-twilio-sid",
    twilioToken: "mock-twilio-token",
    cronSecret: "secret",
  };

  const app = createApp({
    config,
    sheets: mockSheets,
    twilioLib: mockTwilioLib,
    now: () => new Date("2026-09-14T10:30:00Z"),
    logger: { log() {}, warn() {}, error() {}, info() {} },
    validateTwilioSignature: false,
  });

  // Manager Raju Mishra requests daily report
  const res = await dispatch(app, {
    body: {
      From: "whatsapp:+919899242080",
      Body: "daily report",
    },
  });

  assert.equal(res.status, 200);
  assert.match(res.body, /Daily Attendance Report - South Ex Office/);

  // Non-manager Mukesh Bhatt requests daily report -> rejected
  const nonMgrRes = await dispatch(app, {
    body: {
      From: "whatsapp:+917533848039",
      Body: "daily report",
    },
  });

  assert.equal(nonMgrRes.status, 200);
  assert.match(nonMgrRes.body, /Only office managers and admins can request the daily attendance report/);
});

test("parseSendDailyReportCommand parses all variants of send daily report commands", () => {
  assert.deepEqual(parseSendDailyReportCommand("send daily report"), {
    allOffices: true,
    office: null,
    rawOffice: "all",
    isToday: false,
  });
  assert.deepEqual(parseSendDailyReportCommand("send daily reports"), {
    allOffices: true,
    office: null,
    rawOffice: "all",
    isToday: false,
  });
  assert.deepEqual(parseSendDailyReportCommand("send daily report all"), {
    allOffices: true,
    office: null,
    rawOffice: "all",
    isToday: false,
  });
  assert.deepEqual(parseSendDailyReportCommand("send daily report today"), {
    allOffices: true,
    office: null,
    rawOffice: "all",
    isToday: true,
  });
  assert.deepEqual(parseSendDailyReportCommand("send daily report South Ex"), {
    allOffices: false,
    office: "South Ex Office",
    rawOffice: "South Ex",
    isToday: false,
  });
  assert.deepEqual(parseSendDailyReportCommand("send daily report South Ex today"), {
    allOffices: false,
    office: "South Ex Office",
    rawOffice: "South Ex",
    isToday: true,
  });
  assert.deepEqual(parseSendDailyReportCommand("send daily report opc"), {
    allOffices: false,
    office: "OPC",
    rawOffice: "opc",
    isToday: false,
  });
  assert.deepEqual(parseSendDailyReportCommand("send daily report Noida Office"), {
    allOffices: false,
    office: "Noida Office",
    rawOffice: "Noida Office",
    isToday: false,
  });
  assert.deepEqual(parseSendDailyReportCommand("send daily report jasola"), {
    allOffices: false,
    office: "Jasola Office",
    rawOffice: "jasola",
    isToday: false,
  });
  assert.equal(parseSendDailyReportCommand("daily report"), null);
  assert.equal(parseSendDailyReportCommand("hello"), null);
});

test("Webhook admin command send daily report sends to all or specific office managers", async () => {
  const mockSheets = createMockSheets(SAMPLE_MASTER_ROWS);
  const sentOutbound = [];
  const mockTwilioLib = () => ({
    messages: {
      create: async (opts) => {
        sentOutbound.push(opts);
        return { sid: "SMtest" };
      },
    },
  });

  const config = {
    spreadsheetId: "test-id",
    sheetName: "Attendance",
    staffSheetName: "Master Staff Data",
    twilioFromNumber: "whatsapp:+17543423324",
    adminNumber: "whatsapp:+918780901324",
    admins: new Set(["whatsapp:+918780901324"]),
    employees: {
      "whatsapp:+919899242080": "Raju Mishra",
      "whatsapp:+918780901324": "Jasola Manager",
      "whatsapp:+917042926825": "OPC Manager",
      "whatsapp:+917533848039": "Mukesh Bhatt",
    },
    employeeLocations: {
      "whatsapp:+919899242080": "South Ex Office",
      "whatsapp:+918780901324": "Jasola Office",
      "whatsapp:+917042926825": "OPC",
      "whatsapp:+917533848039": "South Ex Office",
    },
    timeExemptEmployees: new Set(),
    officeManagers: {
      "South Ex Office": ["whatsapp:+919899242080"],
      "OPC": ["whatsapp:+917042926825"],
      "Jasola Office": ["whatsapp:+918780901324"],
    },
    employeeSalaries: {},
    employeeFines: {},
    timezone: "Asia/Kolkata",
    workingWeekdays: new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    holidays: new Set(),
    reportsEnabled: false,
    twilioSid: "mock-twilio-sid",
    twilioToken: "mock-twilio-token",
    cronSecret: "secret",
  };

  const app = createApp({
    config,
    sheets: mockSheets,
    twilioLib: mockTwilioLib,
    now: () => new Date("2026-09-14T10:30:00Z"),
    logger: { log() {}, warn() {}, error() {}, info() {} },
    validateTwilioSignature: false,
  });

  // 1. Non-admin tries to send daily report -> blocked
  const nonAdminRes = await dispatch(app, {
    body: {
      From: "whatsapp:+917533848039",
      Body: "send daily report",
    },
  });
  assert.equal(nonAdminRes.status, 200);
  assert.match(nonAdminRes.body, /Only admins can trigger sending daily reports/);
  assert.equal(sentOutbound.length, 0);

  // 2. Admin sends to a specific office: South Ex
  const southExRes = await dispatch(app, {
    body: {
      From: "whatsapp:+918780901324",
      Body: "send daily report South Ex",
    },
  });
  assert.equal(southExRes.status, 200);
  assert.match(southExRes.body, /Daily Reports Sent/);
  assert.match(southExRes.body, /South Ex Office/);
  // Only South Ex manager got the outbound message
  assert.equal(sentOutbound.length, 1);
  assert.equal(sentOutbound[0].to, "whatsapp:+919899242080");
  assert.match(sentOutbound[0].body, /Daily Attendance Report - South Ex Office/);

  // 3. Admin sends to all offices
  sentOutbound.length = 0;
  const allRes = await dispatch(app, {
    body: {
      From: "whatsapp:+918780901324",
      Body: "send daily report",
    },
  });
  assert.equal(allRes.status, 200);
  assert.match(allRes.body, /Daily Reports Sent/);
  // Exactly 3 messages sent (one for each configured office manager)
  assert.equal(sentOutbound.length, 3);
  const recipients = sentOutbound.map((m) => m.to);
  assert.equal(recipients.includes("whatsapp:+919899242080"), true);
  assert.equal(recipients.includes("whatsapp:+917042926825"), true);
  assert.equal(recipients.includes("whatsapp:+918780901324"), true);

  // 4. Admin tries to send for Jim Corbett -> rejected
  sentOutbound.length = 0;
  const corbettRes = await dispatch(app, {
    body: {
      From: "whatsapp:+918780901324",
      Body: "send daily report jim corbett",
    },
  });
  assert.equal(corbettRes.status, 200);
  assert.match(corbettRes.body, /Jim Corbett staff are kept in records only/);
  assert.equal(sentOutbound.length, 0);
});
