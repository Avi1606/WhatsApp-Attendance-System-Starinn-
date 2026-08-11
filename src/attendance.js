"use strict";

const { normalizeDate, normalizeMonthFirstDate, sheetDateMatches } = require("./time");

const HEADER = ["Name", "Date", "IN", "OUT", "Status", "Employee ID", "Last Message SID", "Remarks", "Late", "Office Location"];
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
        range: `${sheetName}!A1:J1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] },
      });
      rows.push([...HEADER]);
    } else if (ensureAttendanceHeader && isHeader(rows[0]) && rows[0].length < HEADER.length) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1:J1`,
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

  rowMatchesEmployee(row, employee) {
    const rowEmployeeId = normalizeText(row[5]);
    const employeeId = normalizeText(employee.id);
    if (rowEmployeeId && employeeId) return rowEmployeeId === employeeId;

    return normalizeText(row[0]) === normalizeText(employee.name);
  }

  findAttendanceRow(rows, employee, dateKey) {
    let fallbackIndex = -1;

    for (let index = this.dataStart(rows); index < rows.length; index += 1) {
      if (
        this.rowMatchesEmployee(rows[index], employee) &&
        sheetDateMatches(rows[index][1], dateKey)
      ) {
        if (fallbackIndex === -1) fallbackIndex = index;
        if (rows[index][2] || rows[index][3]) return index;
      }
    }

    return fallbackIndex;
  }

  findLatestOpenInRow(rows, employee) {
    for (let index = this.dataStart(rows); index < rows.length; index += 1) {
      const row = rows[index];
      if (this.rowMatchesEmployee(row, employee) && row[2] && !row[3]) {
        return index;
      }
    }
    return -1;
  }

  findOpenInRowForDate(rows, employee, dateKey) {
    for (let index = this.dataStart(rows); index < rows.length; index += 1) {
      const row = rows[index];
      if (
        this.rowMatchesEmployee(row, employee) &&
        sheetDateMatches(row[1], dateKey) &&
        row[2] &&
        !row[3]
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

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A2:J${1 + rowsToInsert.length}`,
      valueInputOption: "RAW",
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
      const start = this.dataStart(rows);

      if (messageSid) {
        const duplicateIndex = rows.findIndex((row, index) => index >= start && row[6] === messageSid);
        if (duplicateIndex !== -1) {
          const duplicateRow = rows[duplicateIndex];
          return {
            ok: false,
            reason: "already_processed",
            time: action === "IN" ? duplicateRow[2] : duplicateRow[3],
          };
        }
      }

      let rowIndex = this.findAttendanceRow(rows, employee, dateKey);
      if (rowIndex === -1 && action === "OUT") {
        rowIndex = this.findOpenInRowForDate(rows, employee, dateKey);
      }

      if (rowIndex === -1) {
        if (action === "OUT") return { ok: false, reason: "out_before_in" };

        const notes = attendanceNotesFor(employee, time);
        const row = [employee.name, dateKey, time, "", statusFor(time, ""), employee.id, messageSid, notes.remarks, notes.late, employee.location || ""];
        await this.insertRowsAtTop([row]);
        this.invalidate();
        return { ok: true, action };
      }

      const existing = rows[rowIndex];
      const inTime = existing[2] || "";
      const outTime = existing[3] || "";

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
      const updated = [
        employee.name,
        dateKey,
        newIn,
        newOut,
        statusFor(newIn, newOut),
        employee.id,
        messageSid,
        notes.remarks,
        notes.late,
        employee.location || existing[9] || "",
      ];

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A${rowIndex + 1}:J${rowIndex + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [updated] },
      });
      this.invalidate();
      return { ok: true, action };
    });
  }

  async getStatus(employee, dateKey) {
    const rows = await this.getRows();
    const index = this.findAttendanceRow(rows, employee, dateKey);
    if (index === -1) return { exists: false, found: false };

    const row = rows[index];
    return {
      exists: true,
      found: true,
      inTime: row[2] || "",
      outTime: row[3] || "",
      status: statusFor(row[2] || "", row[3] || ""),
    };
  }

  async getMonthlyReport(employee, monthKey) {
    if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error(`Invalid month: ${monthKey}`);

    const rows = await this.getRows();
    let present = 0;
    let absent = 0;
    let noOut = 0;
    const reportRows = [];

    for (let index = this.dataStart(rows); index < rows.length; index += 1) {
      const row = rows[index];
      const candidateDateKey = normalizeMonthFirstDate(row[1]) || normalizeDate(row[1]);
      if (!this.rowMatchesEmployee(row, employee) || !candidateDateKey?.startsWith(monthKey)) continue;

      if (row[2] && row[3]) present += 1;
      else if (row[2]) noOut += 1;
      else absent += 1;

      reportRows.push({
        dateKey: candidateDateKey,
        inTime: row[2] || "",
        outTime: row[3] || "",
        status: statusFor(row[2] || "", row[3] || ""),
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
    const result = new Map();

    for (const [id, name] of Object.entries(employees)) {
      const employee = { id, name };
      const index = this.findAttendanceRow(rows, employee, dateKey);
      if (index !== -1) {
        const row = rows[index];
        result.set(id, {
          name,
          inTime: row[2] || "",
          outTime: row[3] || "",
          status: statusFor(row[2] || "", row[3] || ""),
          remarks: row[7] || "",
          late: row[8] || "",
          officeLocation: row[9] || "",
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
          const candidateDateKey = normalizeMonthFirstDate(row[1]) || normalizeDate(row[1]);
          if (!this.rowMatchesEmployee(row, { id, name }) || !candidateDateKey) continue;
          if (candidateDateKey < startDateKey || candidateDateKey > endDateKey) continue;

          maxLeaves = Math.max(
            maxLeaves,
            moneyNumber(cellByHeaders(row, attendanceHeaders, ["Maximum Allowed Leaves", "Max Leaves", "Allowed Leaves", "Leave Allowed", "Max Allowed Leaves"])),
          );
          salary = salary || moneyNumber(cellByHeaders(row, attendanceHeaders, ["Salary", "Monthly Salary", "Gross Salary"]));
          configuredPerDaySalary =
            configuredPerDaySalary || moneyNumber(cellByHeaders(row, attendanceHeaders, ["Per Day Salary", "Per-Day Salary", "Daily Salary"]));
          fine = Math.max(fine, moneyNumber(cellByHeaders(row, attendanceHeaders, ["Fine", "Penalty"])));

          const inTime = row[2] || "";
          const outTime = row[3] || "";
          const remarks = row[7] || "";
          const late = row[8] || "";

          if (!inTime) absentDays += 1;
          else if (!outTime) noOutDays += 1;
          else if (remarks === "Half Day") halfDays += 1;
          else presentDays += 1;

          if (late === "Late") lateDays += 1;
        }
      } else if (!noOutDays) {
        for (let index = this.dataStart(attendanceRows); index < attendanceRows.length; index += 1) {
          const row = attendanceRows[index];
          const candidateDateKey = normalizeMonthFirstDate(row[1]) || normalizeDate(row[1]);
          if (!this.rowMatchesEmployee(row, { id, name }) || !candidateDateKey) continue;
          if (candidateDateKey < startDateKey || candidateDateKey > endDateKey) continue;

          const inTime = row[2] || "";
          const outTime = row[3] || "";
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
      const absentRows = [];

      for (const [id, name] of Object.entries(employees)) {
        const employee = { id, name, location: employeeLocations[id] || "" };
        if (this.findAttendanceRow(rows, employee, dateKey) === -1) {
          absentRows.push([name, dateKey, "", "", statusFor("", ""), id, "", "", "", employee.location]);
        }
      }

      if (absentRows.length) {
        await this.insertRowsAtTop(absentRows);
        this.invalidate();
      }

      return absentRows.length;
    });
  }
}

module.exports = { AttendanceStore, statusFor, remarksFor, lateFor, attendanceNotesFor, HEADER };
