"use strict";

const { normalizeDate, normalizeMonthFirstDate, sheetDateMatches } = require("./time");

const HEADER = ["Name", "Date", "IN", "OUT", "Status", "Employee ID", "Last Message SID"];
const ACTIONS = new Set(["IN", "OUT"]);

function statusFor(inTime, outTime) {
  if (inTime && outTime) return "Present";
  if (inTime) return "Present (no OUT)";
  return "Absent";
}

function isHeader(row) {
  const first = String(row?.[0] || "").trim().toLowerCase();
  return first === "name" || first === "employee name";
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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

  async getRows({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.rows;
    }

    const result = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.sheetName}!A:G`,
    });
    const rows = result.data.values || [];

    if (rows.length === 0) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A1:G1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADER] },
      });
      rows.push([...HEADER]);
    }

    this.cache = { rows, at: Date.now() };
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
      range: `${this.sheetName}!A2:G${1 + rowsToInsert.length}`,
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

        const row = [employee.name, dateKey, time, "", statusFor(time, ""), employee.id, messageSid];
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
      const updated = [
        employee.name,
        dateKey,
        newIn,
        newOut,
        statusFor(newIn, newOut),
        employee.id,
        messageSid,
      ];

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${this.sheetName}!A${rowIndex + 1}:G${rowIndex + 1}`,
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
        });
      }
    }

    return result;
  }

  async markAbsent(employees, dateKey) {
    return this.serialize(async () => {
      const rows = await this.getRows({ fresh: true });
      const absentRows = [];

      for (const [id, name] of Object.entries(employees)) {
        const employee = { id, name };
        if (this.findAttendanceRow(rows, employee, dateKey) === -1) {
          absentRows.push([name, dateKey, "", "", statusFor("", ""), id, ""]);
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

module.exports = { AttendanceStore, statusFor, HEADER };
