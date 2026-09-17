"use strict";

const { normalizeDate, normalizeMonthFirstDate, sheetDateMatches } = require("./time");

const HEADER = [
  "Name",
  "Office Location",
  "Date",
  "Day of Week",
  "IN",
  "OUT",
  "Status",
  "Remarks",
  "Late",
  "Employee ID",
  "Last Message SID",
];
const ACTIONS = new Set(["IN", "OUT"]);
const LATE_IN_AFTER = "10:15";
const HALF_DAY_IN_AFTER = "11:00";
const HALF_DAY_OUT_BEFORE = "17:00";

function statusFor(inTime, outTime) {
  if (inTime && outTime) return "Present";
  if (inTime) return "Present (no OUT)";
  return "Absent";
}

function minutesSinceMidnight(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ""));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function remarksFor(inTime, outTime = "") {
  const inMinutes = minutesSinceMidnight(inTime);
  const outMinutes = minutesSinceMidnight(outTime);
  const inCutoff = minutesSinceMidnight(HALF_DAY_IN_AFTER);
  const outCutoff = minutesSinceMidnight(HALF_DAY_OUT_BEFORE);

  if (inMinutes !== null && inMinutes > inCutoff) return "Half Day";
  if (outMinutes !== null && outMinutes < outCutoff) return "Half Day";
  return "";
}

function lateFor(inTime, remarks = "") {
  if (remarks === "Half Day") return "";
  const inMinutes = minutesSinceMidnight(inTime);
  const lateCutoff = minutesSinceMidnight(LATE_IN_AFTER);

  if (inMinutes !== null && inMinutes > lateCutoff) return "Late";
  return "";
}

function isHeader(row) {
  const first = String(row?.[0] || "").trim().toLowerCase();
  return first === "name" || first === "employee name";
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function moneyNumber(value) {
  if (value === undefined || value === null || value === "") return 0;
  const cleaned = String(value).replace(/[₹,\s]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function headerMap(rows) {
  const header = rows[0] || [];
  const result = new Map();
  header.forEach((name, index) => {
    const key = normalizeText(name);
    if (key) result.set(key, index);
  });
  return result;
}

function firstHeaderIndex(headers, names) {
  for (const name of names) {
    const index = headers.get(normalizeText(name));
    if (index !== undefined) return index;
  }
  return -1;
}

function cellByHeaders(row, headers, names) {
  const index = firstHeaderIndex(headers, names);
  return index === -1 ? "" : row[index] || "";
}

function rowMatchesEmployeeByHeaders(row, headers, employee) {
  const rowEmployeeId = normalizeText(cellByHeaders(row, headers, ["Employee ID", "WhatsApp", "Whatsapp", "Phone", "Mobile", "Mobile Number"]));
  const employeeId = normalizeText(employee.id);
  if (rowEmployeeId && employeeId) return rowEmployeeId === employeeId;

  const rowName = cellByHeaders(row, headers, ["Name", "Employee Name", "Staff Name"]);
  return normalizeText(rowName) === normalizeText(employee.name);
}

function attendanceNotesFor(employee, inTime, outTime = "") {
  if (employee.timeExempt) return { remarks: "", late: "" };
  const remarks = remarksFor(inTime, outTime);
  return { remarks, late: lateFor(inTime, remarks) };
}

function colLetter(count) {
  let s = "";
  let n = count;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s || "K";
}

function resolveAttendanceCols(rows) {
  const headers = headerMap(rows);
  const hasHeaders = isHeader(rows[0]);

  let nameCol = hasHeaders ? firstHeaderIndex(headers, ["Name", "Employee Name", "Staff Name"]) : 0;
  let locationCol = hasHeaders ? firstHeaderIndex(headers, ["Office Location", "Location", "Office"]) : 1;
  let dateCol = hasHeaders ? firstHeaderIndex(headers, ["Date"]) : 2;
  let dayOfWeekCol = hasHeaders ? firstHeaderIndex(headers, ["Day of Week", "Day", "Weekday"]) : -1;
  let inCol = hasHeaders ? firstHeaderIndex(headers, ["IN", "In Time", "Time In"]) : -1;
  let outCol = hasHeaders ? firstHeaderIndex(headers, ["OUT", "Out Time", "Time Out"]) : -1;
  let statusCol = hasHeaders ? firstHeaderIndex(headers, ["Status"]) : -1;
  let remarksCol = hasHeaders ? firstHeaderIndex(headers, ["Remarks", "Notes"]) : -1;
  let lateCol = hasHeaders ? firstHeaderIndex(headers, ["Late", "Late/On Time"]) : -1;
  let employeeIdCol = hasHeaders ? firstHeaderIndex(headers, ["Employee ID", "WhatsApp", "Whatsapp", "Phone", "Mobile", "Mobile Number"]) : -1;
  let messageSidCol = hasHeaders ? firstHeaderIndex(headers, ["Last Message SID", "Message SID", "SID"]) : -1;

  if (nameCol === -1) nameCol = 0;
  if (locationCol === -1) locationCol = 1;
  if (dateCol === -1) dateCol = 2;

  if (dayOfWeekCol !== -1) {
    if (inCol === -1) inCol = 4;
    if (outCol === -1) outCol = 5;
    if (statusCol === -1) statusCol = 6;
    if (remarksCol === -1) remarksCol = 7;
    if (lateCol === -1) lateCol = 8;
    if (employeeIdCol === -1) employeeIdCol = 9;
    if (messageSidCol === -1) messageSidCol = 10;
  } else {
    if (inCol === -1) inCol = 3;
    if (outCol === -1) outCol = 4;
    if (statusCol === -1) statusCol = 5;
    if (remarksCol === -1) remarksCol = 6;
    if (lateCol === -1) lateCol = 7;
    if (employeeIdCol === -1) employeeIdCol = 8;
    if (messageSidCol === -1) messageSidCol = 9;
  }

  const headerLength = rows[0]?.length || (dayOfWeekCol !== -1 ? 11 : 10);

  return {
    headers,
    nameCol,
    locationCol,
    dateCol,
    dayOfWeekCol,
    inCol,
    outCol,
    statusCol,
    remarksCol,
    lateCol,
    employeeIdCol,
    messageSidCol,
    headerLength,
  };
}

function buildAttendanceRow({
  cols,
  employee,
  dateKey,
  inTime = "",
  outTime = "",
  status = "",
  remarks = "",
  late = "",
  messageSid = "",
  sheetRowNumber = null,
}) {
  const effectiveStatus = status || statusFor(inTime, outTime);
  const length = Math.max(cols.headerLength, cols.dayOfWeekCol !== -1 ? 11 : 10);
  const row = new Array(length).fill("");

  if (cols.nameCol !== -1) row[cols.nameCol] = employee.name;
  if (cols.locationCol !== -1) row[cols.locationCol] = employee.location || "";
  if (cols.dateCol !== -1) row[cols.dateCol] = dateKey;
  if (cols.dayOfWeekCol !== -1) {
    row[cols.dayOfWeekCol] = sheetRowNumber !== null ? `=IF(C${sheetRowNumber}="","",TEXT(C${sheetRowNumber},"DDDD"))` : "";
  }
  if (cols.inCol !== -1) row[cols.inCol] = inTime;
  if (cols.outCol !== -1) row[cols.outCol] = outTime;
  if (cols.statusCol !== -1) row[cols.statusCol] = effectiveStatus;
  if (cols.remarksCol !== -1) row[cols.remarksCol] = remarks;
  if (cols.lateCol !== -1) row[cols.lateCol] = late;
  if (cols.employeeIdCol !== -1) row[cols.employeeIdCol] = employee.id;
  if (cols.messageSidCol !== -1) row[cols.messageSidCol] = messageSid;

  return row;
}

class AttendanceStore {
  constructor({ sheets, spreadsheetId, sheetName, cacheTtlMs = 5000 }) {
    this.sheets = sheets;
    this.spreadsheetId = spreadsheetId;
    this.sheetName = sheetName;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = null;
    this.sheetId = null;
    this.writeQueue = Promise.resolve();
  }

  serialize(task) {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  invalidate() {
    this.cache = null;
  }

  async getRows({ fresh = false, sheetName = this.sheetName, ensureAttendanceHeader = sheetName === this.sheetName } = {}) {
    const canUseCache = sheetName === this.sheetName;
    if (canUseCache && !fresh && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.rows;
    }

    const result = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${sheetName}!A:Z`,
    });
    const rows = result.data.values || [];

    if (ensureAttendanceHeader && rows.length === 0) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1:${colLetter(HEADER.length)}1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] },
      });
      rows.push([...HEADER]);
    } else if (ensureAttendanceHeader && isHeader(rows[0]) && rows[0].length < 10) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1:${colLetter(HEADER.length)}1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] },
      });
      rows[0] = [...HEADER];
    }

    if (canUseCache) this.cache = { rows, at: Date.now() };
    return rows;
  }

  dataStart(rows) {
    return isHeader(rows[0]) ? 1 : 0;
  }

  rowMatchesEmployee(row, employee, cols = null) {
    const idCol = cols ? cols.employeeIdCol : (row.length >= 11 ? 9 : 8);
    const nameCol = cols ? cols.nameCol : 0;
    const rowEmployeeId = idCol !== -1 ? normalizeText(row[idCol]) : "";
    const employeeId = normalizeText(employee.id);
    if (rowEmployeeId && employeeId && rowEmployeeId === employeeId) return true;

    const rowName = normalizeText(row[nameCol]);
    return rowName === normalizeText(employee.name);
  }

  findAttendanceRow(rows, employee, dateKey, cols = null) {
    const c = cols || resolveAttendanceCols(rows);
    let fallbackIndex = -1;

    for (let index = this.dataStart(rows); index < rows.length; index += 1) {
      const row = rows[index];
      if (
        this.rowMatchesEmployee(row, employee, c) &&
        sheetDateMatches(row[c.dateCol], dateKey)
      ) {
        if (fallbackIndex === -1) fallbackIndex = index;
        const inVal = c.inCol !== -1 ? row[c.inCol] : "";
        const outVal = c.outCol !== -1 ? row[c.outCol] : "";
        if (inVal || outVal) return index;
      }
    }

    return fallbackIndex;
  }

  findLatestOpenInRow(rows, employee, cols = null) {
    const c = cols || resolveAttendanceCols(rows);
    for (let index = this.dataStart(rows); index < rows.length; index += 1) {
      const row = rows[index];
      const inVal = c.inCol !== -1 ? row[c.inCol] : "";
      const outVal = c.outCol !== -1 ? row[c.outCol] : "";
      if (this.rowMatchesEmployee(row, employee, c) && inVal && !outVal) {
        return index;
      }
    }
    return -1;
  }

  findOpenInRowForDate(rows, employee, dateKey, cols = null) {
    const c = cols || resolveAttendanceCols(rows);
    for (let index = this.dataStart(rows); index < rows.length; index += 1) {
      const row = rows[index];
      const inVal = c.inCol !== -1 ? row[c.inCol] : "";
      const outVal = c.outCol !== -1 ? row[c.outCol] : "";
      if (
        this.rowMatchesEmployee(row, employee, c) &&
        sheetDateMatches(row[c.dateCol], dateKey) &&
        inVal &&
        !outVal
      ) {
        return index;
      }
    }
    return -1;
  }

  async getSheetId() {
    if (this.sheetId !== null) return this.sheetId;

    const result = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "sheets.properties(sheetId,title)",
    });
    const sheet = result.data.sheets.find((item) => item.properties.title === this.sheetName);
    if (!sheet) throw new Error(`Sheet not found: ${this.sheetName}`);

    this.sheetId = sheet.properties.sheetId;
    return this.sheetId;
  }

  async insertRowsAtTop(rowsToInsert) {
    if (!rowsToInsert.length) return;

    const sheetId = await this.getSheetId();
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: 1,
                endIndex: 1 + rowsToInsert.length,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });

    const maxCols = Math.max(...rowsToInsert.map((r) => r.length), HEADER.length);
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A2:${colLetter(maxCols)}${1 + rowsToInsert.length}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rowsToInsert },
    });
  }

  async markAttendance({ employee, action, dateKey, time, messageSid = "" }) {
    if (!employee?.id || !employee?.name) {
      throw new Error("A stable employee id and name are required");
    }
    if (!ACTIONS.has(action)) throw new Error(`Unsupported attendance action: ${action}`);
    if (!normalizeDate(dateKey)) throw new Error(`Invalid attendance date: ${dateKey}`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new Error(`Invalid attendance time: ${time}`);
    }

    return this.serialize(async () => {
      const rows = await this.getRows({ fresh: true });
      const cols = resolveAttendanceCols(rows);
      const start = this.dataStart(rows);

      if (messageSid && cols.messageSidCol !== -1) {
        const duplicateIndex = rows.findIndex((row, index) => index >= start && row[cols.messageSidCol] === messageSid);
        if (duplicateIndex !== -1) {
          const duplicateRow = rows[duplicateIndex];
          return {
            ok: false,
            reason: "already_processed",
            time: action === "IN" ? (cols.inCol !== -1 ? duplicateRow[cols.inCol] : "") : (cols.outCol !== -1 ? duplicateRow[cols.outCol] : ""),
          };
        }
      }

      let rowIndex = this.findAttendanceRow(rows, employee, dateKey, cols);
      if (rowIndex === -1 && action === "OUT") {
        rowIndex = this.findOpenInRowForDate(rows, employee, dateKey, cols);
      }

      if (rowIndex === -1) {
        if (action === "OUT") return { ok: false, reason: "out_before_in" };

        const notes = attendanceNotesFor(employee, time);
        const row = buildAttendanceRow({
          cols,
          employee,
          dateKey,
          inTime: time,
          outTime: "",
          status: statusFor(time, ""),
          remarks: notes.remarks,
          late: notes.late,
          messageSid,
          sheetRowNumber: 2,
        });
        await this.insertRowsAtTop([row]);
        this.invalidate();
        return { ok: true, action };
      }

      const existing = rows[rowIndex];
      const inTime = cols.inCol !== -1 ? existing[cols.inCol] || "" : "";
      const outTime = cols.outCol !== -1 ? existing[cols.outCol] || "" : "";

      if (action === "IN" && inTime) {
        return { ok: false, reason: "already_marked", action, time: inTime };
      }
      if (action === "OUT" && !inTime) return { ok: false, reason: "out_before_in" };
      if (action === "OUT" && outTime) {
        return { ok: false, reason: "already_marked", action, time: outTime };
      }

      const newIn = action === "IN" ? time : inTime;
      const newOut = action === "OUT" ? time : outTime;
      const notes = attendanceNotesFor(employee, newIn, newOut);
      const rowNumber = rowIndex + 1;

      const updated = [...existing];
      while (updated.length < cols.headerLength) updated.push("");
      if (cols.nameCol !== -1) updated[cols.nameCol] = employee.name;
      if (cols.locationCol !== -1) updated[cols.locationCol] = employee.location || existing[cols.locationCol] || "";
      if (cols.dateCol !== -1) updated[cols.dateCol] = dateKey;
      if (cols.dayOfWeekCol !== -1) {
        updated[cols.dayOfWeekCol] = existing[cols.dayOfWeekCol] || `=IF(C${rowNumber}="","",TEXT(C${rowNumber},"DDDD"))`;
      }
      if (cols.inCol !== -1) updated[cols.inCol] = newIn;
      if (cols.outCol !== -1) updated[cols.outCol] = newOut;
      if (cols.statusCol !== -1) updated[cols.statusCol] = statusFor(newIn, newOut);
      if (cols.remarksCol !== -1) updated[cols.remarksCol] = notes.remarks;
      if (cols.lateCol !== -1) updated[cols.lateCol] = notes.late;
      if (cols.employeeIdCol !== -1) updated[cols.employeeIdCol] = employee.id;
      if (cols.messageSidCol !== -1) updated[cols.messageSidCol] = messageSid;

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A${rowNumber}:${colLetter(updated.length)}${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [updated] },
      });
      this.invalidate();
      return { ok: true, action };
    });
  }

  async getStatus(employee, dateKey) {
    const rows = await this.getRows();
    const cols = resolveAttendanceCols(rows);
    const index = this.findAttendanceRow(rows, employee, dateKey, cols);
    if (index === -1) return { exists: false, found: false };

    const row = rows[index];
    const inTime = cols.inCol !== -1 ? row[cols.inCol] || "" : "";
    const outTime = cols.outCol !== -1 ? row[cols.outCol] || "" : "";
    return {
      exists: true,
      found: true,
      inTime,
      outTime,
      status: (cols.statusCol !== -1 && row[cols.statusCol]) || statusFor(inTime, outTime),
    };
  }

  async getMonthlyReport(employee, monthKey) {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error(`Invalid month: ${monthKey}`);

    const rows = await this.getRows();
    const cols = resolveAttendanceCols(rows);
    let present = 0;
    let absent = 0;
    let noOut = 0;
    const reportRows = [];

    for (let index = this.dataStart(rows); index < rows.length; index += 1) {
      const row = rows[index];
      const dateVal = cols.dateCol !== -1 ? row[cols.dateCol] : "";
      const candidateDateKey = normalizeMonthFirstDate(dateVal) || normalizeDate(dateVal);
      if (!this.rowMatchesEmployee(row, employee, cols) || !candidateDateKey?.startsWith(monthKey)) continue;

      const inTime = cols.inCol !== -1 ? row[cols.inCol] || "" : "";
      const outTime = cols.outCol !== -1 ? row[cols.outCol] || "" : "";
      const status = (cols.statusCol !== -1 && row[cols.statusCol]) || statusFor(inTime, outTime);

      if (inTime && outTime) present += 1;
      else if (inTime) noOut += 1;
      else absent += 1;

      reportRows.push({
        dateKey: candidateDateKey,
        inTime,
        outTime,
        status,
      });
    }

    const total = present + absent + noOut;
    return {
      present,
      absent,
      noOut,
      total,
      presentDays: present + noOut,
      absentDays: absent,
      missedOutDays: noOut,
      pct: total ? Math.round(((present + noOut) / total) * 100) : 0,
      rows: reportRows,
    };
  }

  async getDailyMap(employees, dateKey) {
    const rows = await this.getRows();
    const cols = resolveAttendanceCols(rows);
    const result = new Map();

    for (const [id, name] of Object.entries(employees)) {
      const employee = { id, name };
      const index = this.findAttendanceRow(rows, employee, dateKey, cols);
      if (index !== -1) {
        const row = rows[index];
        const inTime = cols.inCol !== -1 ? row[cols.inCol] || "" : "";
        const outTime = cols.outCol !== -1 ? row[cols.outCol] || "" : "";
        const status = (cols.statusCol !== -1 && row[cols.statusCol]) || statusFor(inTime, outTime);
        const remarks = cols.remarksCol !== -1 ? row[cols.remarksCol] || "" : "";
        const late = cols.lateCol !== -1 ? row[cols.lateCol] || "" : "";
        const officeLocation = cols.locationCol !== -1 ? row[cols.locationCol] || "" : "";

        result.set(id, {
          name,
          inTime,
          outTime,
          status,
          remarks,
          late,
          officeLocation,
        });
      }
    }

    return result;
  }

  async getDailyOfficeReport(employees, employeeLocations, dateKey) {
    const daily = await this.getDailyMap(employees, dateKey);
    const offices = new Map();

    function officeBucket(office) {
      if (!offices.has(office)) {
        offices.set(office, { office, absent: [], noOut: [], late: [], halfDay: [] });
      }
      return offices.get(office);
    }

    for (const [id, name] of Object.entries(employees)) {
      const office = employeeLocations[id] || "Unassigned";
      if (/corbett/i.test(office)) continue;
      const bucket = officeBucket(office);
      const record = daily.get(id);

      if (!record || !record.inTime || record.remarks === "Absent" || record.status === "Absent") {
        bucket.absent.push(name);
        continue;
      }

      if (!record.outTime) {
        bucket.noOut.push({ name, inTime: record.inTime });
      }
      if (record.late === "Late") {
        bucket.late.push({ name, inTime: record.inTime, outTime: record.outTime || "" });
      }
      if (record.remarks === "Half Day") {
        bucket.halfDay.push({ name, inTime: record.inTime, outTime: record.outTime || "" });
      }
    }

    return [...offices.values()];
  }

  async getSalaryReport({ employees, employeeLocations = {}, employeeSalaries = {}, employeeFines = {}, salarySheetName, startDateKey, endDateKey }) {
    const attendanceRows = await this.getRows();
    const salaryRows = salarySheetName && salarySheetName !== this.sheetName
      ? await this.getRows({ sheetName: salarySheetName, ensureAttendanceHeader: false })
      : attendanceRows;
    const attendanceHeaders = headerMap(attendanceRows);
    const salaryHeaders = headerMap(salaryRows);
    const attendanceCols = resolveAttendanceCols(attendanceRows);
    const hasSalaryColumns =
      firstHeaderIndex(salaryHeaders, ["Present Days", "Half Days", "Absent Days", "Per Day Salary", "Maximum Allowed Leaves", "Final Payout"]) !== -1;
    const cycleDays = Math.floor((new Date(`${endDateKey}T00:00:00Z`) - new Date(`${startDateKey}T00:00:00Z`)) / 86400000) + 1;
    const reports = [];

    for (const [id, name] of Object.entries(employees)) {
      let presentDays = 0;
      let halfDays = 0;
      let absentDays = 0;
      let noOutDays = 0;
      let lateDays = 0;
      let maxLeaves = 0;
      let salary = Number(employeeSalaries[id] || 0);
      let fine = Number(employeeFines[id] || 0);
      let configuredPerDaySalary = 0;
      let finalPayout = null;
      let foundSalaryRow = false;

      for (let index = this.dataStart(salaryRows); hasSalaryColumns && index < salaryRows.length; index += 1) {
        const row = salaryRows[index];
        if (!rowMatchesEmployeeByHeaders(row, salaryHeaders, { id, name })) continue;

        foundSalaryRow = true;
        presentDays = moneyNumber(cellByHeaders(row, salaryHeaders, ["Present Days", "Present"]));
        halfDays = moneyNumber(cellByHeaders(row, salaryHeaders, ["Half Days", "Half Day"]));
        absentDays = moneyNumber(cellByHeaders(row, salaryHeaders, ["Absent Days", "Absent"]));
        noOutDays = moneyNumber(cellByHeaders(row, salaryHeaders, ["No OUT Marked Days", "No Out Marked Days", "No OUT Days", "No Out Days"]));
        lateDays = moneyNumber(cellByHeaders(row, salaryHeaders, ["Late", "Late Days"]));
        maxLeaves = moneyNumber(cellByHeaders(row, salaryHeaders, ["Maximum Allowed Leaves", "Max Leaves", "Allowed Leaves", "Leave Allowed", "Max Allowed Leaves"]));
        configuredPerDaySalary = moneyNumber(cellByHeaders(row, salaryHeaders, ["Per Day Salary", "Per-Day Salary", "Daily Salary"]));
        salary = salary || moneyNumber(cellByHeaders(row, salaryHeaders, ["Salary", "Monthly Salary", "Gross Salary"]));
        fine = Math.max(fine, moneyNumber(cellByHeaders(row, salaryHeaders, ["Fine", "Penalty"])));
        finalPayout = moneyNumber(cellByHeaders(row, salaryHeaders, ["Final Payout", "Total Payout", "Net Payable", "Payable"]));
        break;
      }

      if (!foundSalaryRow) {
        for (let index = this.dataStart(attendanceRows); index < attendanceRows.length; index += 1) {
          const row = attendanceRows[index];
          const dateVal = attendanceCols.dateCol !== -1 ? row[attendanceCols.dateCol] : "";
          const candidateDateKey = normalizeMonthFirstDate(dateVal) || normalizeDate(dateVal);
          if (!this.rowMatchesEmployee(row, { id, name }, attendanceCols) || !candidateDateKey) continue;
          if (candidateDateKey < startDateKey || candidateDateKey > endDateKey) continue;

          maxLeaves = Math.max(
            maxLeaves,
            moneyNumber(cellByHeaders(row, attendanceHeaders, ["Maximum Allowed Leaves", "Max Leaves", "Allowed Leaves", "Leave Allowed", "Max Allowed Leaves"])),
          );
          salary = salary || moneyNumber(cellByHeaders(row, attendanceHeaders, ["Salary", "Monthly Salary", "Gross Salary"]));
          configuredPerDaySalary =
            configuredPerDaySalary || moneyNumber(cellByHeaders(row, attendanceHeaders, ["Per Day Salary", "Per-Day Salary", "Daily Salary"]));
          fine = Math.max(fine, moneyNumber(cellByHeaders(row, attendanceHeaders, ["Fine", "Penalty"])));

          const inTime = attendanceCols.inCol !== -1 ? row[attendanceCols.inCol] || "" : "";
          const outTime = attendanceCols.outCol !== -1 ? row[attendanceCols.outCol] || "" : "";
          const remarks = attendanceCols.remarksCol !== -1 ? row[attendanceCols.remarksCol] || "" : "";
          const late = attendanceCols.lateCol !== -1 ? row[attendanceCols.lateCol] || "" : "";

          if (!inTime) absentDays += 1;
          else if (!outTime) noOutDays += 1;
          else if (remarks === "Half Day") halfDays += 1;
          else presentDays += 1;

          if (late === "Late") lateDays += 1;
        }
      } else if (!noOutDays) {
        for (let index = this.dataStart(attendanceRows); index < attendanceRows.length; index += 1) {
          const row = attendanceRows[index];
          const dateVal = attendanceCols.dateCol !== -1 ? row[attendanceCols.dateCol] : "";
          const candidateDateKey = normalizeMonthFirstDate(dateVal) || normalizeDate(dateVal);
          if (!this.rowMatchesEmployee(row, { id, name }, attendanceCols) || !candidateDateKey) continue;
          if (candidateDateKey < startDateKey || candidateDateKey > endDateKey) continue;

          const inTime = attendanceCols.inCol !== -1 ? row[attendanceCols.inCol] || "" : "";
          const outTime = attendanceCols.outCol !== -1 ? row[attendanceCols.outCol] || "" : "";
          if (inTime && !outTime) noOutDays += 1;
        }
      }

      if (!salary && configuredPerDaySalary && cycleDays > 0) {
        salary = configuredPerDaySalary * cycleDays;
      }

      const perDaySalary = configuredPerDaySalary || (cycleDays > 0 ? salary / cycleDays : 0);
      const unpaidAbsentDays = Math.max(absentDays - maxLeaves, 0);
      const deductionDays = unpaidAbsentDays + noOutDays + halfDays * 0.5;
      const grossPayable = Math.max(salary - deductionDays * perDaySalary, 0);
      const totalPayout = finalPayout !== null && finalPayout > 0 ? finalPayout : Math.max(grossPayable - fine, 0);

      reports.push({
        id,
        name,
        officeLocation: employeeLocations[id] || "",
        cycleDays,
        presentDays,
        halfDays,
        absentDays,
        noOutDays,
        lateDays,
        maxLeaves,
        unpaidAbsentDays,
        deductionDays,
        salary,
        perDaySalary,
        fine,
        totalPayout,
      });
    }

    return reports;
  }

  async markAbsent(employees, dateKey, employeeLocations = {}) {
    return this.serialize(async () => {
      const rows = await this.getRows({ fresh: true });
      const cols = resolveAttendanceCols(rows);
      const absentRows = [];

      for (const [id, name] of Object.entries(employees)) {
        const location = employeeLocations[id] || "";
        if (/corbett/i.test(location)) continue;
        const employee = { id, name, location };
        if (this.findAttendanceRow(rows, employee, dateKey, cols) === -1) {
          absentRows.push(
            buildAttendanceRow({
              cols,
              employee,
              dateKey,
              inTime: "",
              outTime: "",
              status: "Absent",
              remarks: "",
              late: "",
              messageSid: "",
              sheetRowNumber: null,
            }),
          );
        }
      }

      if (absentRows.length) {
        if (cols.dayOfWeekCol !== -1) {
          absentRows.forEach((r, idx) => {
            r[cols.dayOfWeekCol] = `=IF(C${idx + 2}="","",TEXT(C${idx + 2},"DDDD"))`;
          });
        }
        await this.insertRowsAtTop(absentRows);
        this.invalidate();
      }

      return absentRows.length;
    });
  }
}

module.exports = {
  AttendanceStore,
  statusFor,
  remarksFor,
  lateFor,
  attendanceNotesFor,
  resolveAttendanceCols,
  buildAttendanceRow,
  HEADER,
};
