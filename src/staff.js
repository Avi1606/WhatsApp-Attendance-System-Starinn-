"use strict";

const { normalizeDate } = require("./time");

const OFFICE_MAP = {
  "south ex": "South Ex Office",
  "south ex office": "South Ex Office",
  "noida": "Noida Office",
  "noida office": "Noida Office",
  "jasola": "Jasola Office",
  "jasola office": "Jasola Office",
  "opc": "OPC",
  "blr": "BLR",
  "jim corbett": "JIM Corbett",
};

function normalizeOfficeLocation(value = "") {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();
  if (OFFICE_MAP[lower]) return OFFICE_MAP[lower];
  return raw;
}

function isExcludedLocation(value = "") {
  return /corbett/i.test(String(value || ""));
}

function normalizeWhatsAppNumber(value = "") {
  const str = String(value || "").trim();
  if (!str) return "";

  // If already whatsapp:+...
  if (/^whatsapp:\+\d{10,15}$/.test(str)) {
    return str;
  }

  // Extract digits
  const digits = str.replace(/\D/g, "");
  if (!digits) return "";

  if (digits.length === 10) {
    return `whatsapp:+91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    return `whatsapp:+${digits}`;
  }
  if (str.startsWith("+")) {
    return `whatsapp:+${digits}`;
  }
  return `whatsapp:+${digits}`;
}

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase();
}

function parseMoney(value) {
  if (value === undefined || value === null || value === "") return 0;
  const cleaned = String(value).replace(/[₹,\s]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isLeftFromRemarks(remarks = "") {
  const text = String(remarks || "").toLowerCase();
  if (!text) return false;
  return /\b(left|resigned|terminated|relieved)\b/i.test(text);
}

function extractLeftDate(text = "", currentYear = new Date().getFullYear()) {
  const str = String(text || "").trim();
  if (!str) return null;

  // Try standard YYYY-MM-DD or DD/MM/YYYY
  const normalized = normalizeDate(str);
  if (normalized) return normalized;

  // Match e.g. "10th September", "8 sep", "3 sept"
  const match = str.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/i);
  if (match) {
    const day = Number(match[1]);
    const monthStr = match[2].toLowerCase();
    const year = match[3] ? Number(match[3]) : currentYear;
    const months = {
      jan: 1, january: 1,
      feb: 2, february: 2,
      mar: 3, march: 3,
      apr: 4, april: 4,
      may: 5,
      jun: 6, june: 6,
      jul: 7, july: 7,
      aug: 8, august: 8,
      sep: 9, sept: 9, september: 9,
      oct: 10, october: 10,
      nov: 11, november: 11,
      dec: 12, december: 12,
    };
    const month = months[monthStr];
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return null;
}

class StaffStore {
  constructor({
    sheets,
    spreadsheetId,
    sheetName = "Master Staff Data",
    cacheTtlMs = 120000,
    fallbackConfig = null,
    logger = console,
  }) {
    this.sheets = sheets;
    this.spreadsheetId = spreadsheetId;
    this.sheetName = sheetName;
    this.cacheTtlMs = cacheTtlMs;
    this.fallbackConfig = fallbackConfig;
    this.logger = logger;
    this.cache = null;
    this.cachedAt = 0;
  }

  invalidate() {
    this.cache = null;
    this.cachedAt = 0;
  }

  async ensureHeaders(headers = []) {
    if (!this.sheets || !this.spreadsheetId) return;

    const lowerHeaders = headers.map(h => normalizeText(h));
    const needed = ["Status", "Left Date", "Time Exempt"];
    const toAdd = [];
    needed.forEach(col => {
      if (!lowerHeaders.includes(normalizeText(col))) {
        toAdd.push(col);
      }
    });

    if (toAdd.length > 0) {
      try {
        const startColIndex = headers.length;
        const startColLetter = String.fromCharCode(65 + startColIndex);
        const endColLetter = String.fromCharCode(65 + startColIndex + toAdd.length - 1);
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `'${this.sheetName}'!${startColLetter}1:${endColLetter}1`,
          valueInputOption: "RAW",
          requestBody: { values: [toAdd] },
        });
        this.logger.log(`Added missing columns ${toAdd.join(", ")} to '${this.sheetName}'`);
      } catch (err) {
        this.logger.warn(`Could not ensure headers on '${this.sheetName}':`, err.message);
      }
    }
  }

  async getStaffData({ fresh = false, targetDateKey = null } = {}) {
    const now = Date.now();
    if (!fresh && this.cache && now - this.cachedAt < this.cacheTtlMs) {
      return this.deriveView(this.cache, targetDateKey);
    }

    if (!this.sheets || !this.spreadsheetId) {
      return this.getFallbackView(targetDateKey);
    }

    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${this.sheetName}'!A1:Z`,
      });

      const rows = response.data.values || [];
      if (rows.length <= 1) {
        this.logger.warn(`Sheet '${this.sheetName}' has no data rows. Using fallback config.`);
        return this.getFallbackView(targetDateKey);
      }

      const headerRow = rows[0] || [];
      const colMap = {};
      headerRow.forEach((h, idx) => {
        const key = normalizeText(h);
        if (key) colMap[key] = idx;
      });

      // Find column indices
      const nameCol = colMap["name"] ?? colMap["employee name"] ?? colMap["staff name"] ?? 0;
      const phoneCol = colMap["phone"] ?? colMap["mobile"] ?? colMap["whatsapp"] ?? colMap["mobile number"] ?? 6;
      const locationCol = colMap["office location"] ?? colMap["location"] ?? colMap["office"] ?? 7;
      const roleCol = colMap["role"] ?? colMap["designation"] ?? 5;
      const salaryCol = colMap["salary"] ?? colMap["monthly salary"] ?? 8;
      const remarksCol = colMap["remarks"] ?? colMap["notes"] ?? 9;
      const statusCol = colMap["status"] ?? 10;
      const leftDateCol = colMap["left date"] ?? colMap["date left"] ?? 11;
      const timeExemptCol = colMap["time exempt"] ?? colMap["exempt"] ?? 12;

      // Check if Status / Left Date headers exist; if not, ensure them asynchronously
      if (colMap["status"] === undefined) {
        this.ensureHeaders(headerRow).catch(() => {});
      }

      const employeesList = [];

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const name = String(row[nameCol] || "").trim();
        const rawPhone = String(row[phoneCol] || "").trim();
        if (!name || !rawPhone) continue;

        const phone = normalizeWhatsAppNumber(rawPhone);
        if (!phone) continue;

        const office = normalizeOfficeLocation(row[locationCol]);
        const role = String(row[roleCol] || "").trim();
        const salary = parseMoney(row[salaryCol]);
        const remarks = String(row[remarksCol] || "").trim();

        // Status checking
        const rawStatus = normalizeText(row[statusCol]);
        let isLeft = false;
        let leftDate = null;

        if (rawStatus === "left" || rawStatus === "inactive" || rawStatus === "resigned") {
          isLeft = true;
        }

        // Left date from column
        const rawLeftDate = String(row[leftDateCol] || "").trim();
        if (rawLeftDate) {
          leftDate = extractLeftDate(rawLeftDate);
          if (leftDate) isLeft = true;
        }

        // Left from remarks fallback
        if (!isLeft && isLeftFromRemarks(remarks)) {
          isLeft = true;
          if (!leftDate) {
            leftDate = extractLeftDate(remarks);
          }
        }

        // Time exempt checking
        const rawTimeExempt = normalizeText(row[timeExemptCol]);
        let isTimeExempt = false;
        if (rawTimeExempt === "yes" || rawTimeExempt === "true" || rawTimeExempt === "1") {
          isTimeExempt = true;
        } else if (
          Array.isArray(this.fallbackConfig?.timeExemptEmployees)
            ? this.fallbackConfig.timeExemptEmployees.includes(phone)
            : Boolean(this.fallbackConfig?.timeExemptEmployees?.has?.(phone))
        ) {
          isTimeExempt = true;
        } else if (/opc/i.test(role) && office === "OPC") {
          isTimeExempt = true;
        }

        employeesList.push({
          rowIndex: r + 1, // 1-based row index for Google Sheets
          id: phone,
          phone,
          name,
          location: office,
          role,
          salary,
          remarks,
          isLeft,
          status: isLeft ? "Left" : "Active",
          leftDate,
          timeExempt: isTimeExempt,
        });
      }

      this.cache = {
        employeesList,
        colMap: {
          nameCol,
          phoneCol,
          locationCol,
          roleCol,
          salaryCol,
          remarksCol,
          statusCol,
          leftDateCol,
          timeExemptCol,
        },
      };
      this.cachedAt = now;

      return this.deriveView(this.cache, targetDateKey);
    } catch (error) {
      this.logger.error(`Failed to load staff from '${this.sheetName}':`, error.message);
      return this.getFallbackView(targetDateKey);
    }
  }

  deriveView(cachedData, targetDateKey = null) {
    const { employeesList } = cachedData;
    const activeEmployeesMap = {};
    const allEmployeesMap = {};
    const employeeLocations = {};
    const timeExemptEmployees = new Set();
    const employeeSalaries = {};
    const officeManagers = {};

    for (const emp of employeesList) {
      allEmployeesMap[emp.id] = emp.name;
      if (emp.location) {
        employeeLocations[emp.id] = emp.location;
      }
      if (emp.timeExempt) {
        timeExemptEmployees.add(emp.id);
      }
      if (emp.salary > 0) {
        employeeSalaries[emp.id] = emp.salary;
      }

      // Check if employee was active on targetDateKey (or today)
      let active = !emp.isLeft;
      if (emp.isLeft && emp.leftDate && targetDateKey) {
        // If employee left on or after targetDateKey, they were active on that date
        if (targetDateKey <= emp.leftDate) {
          active = true;
        }
      }

      // Corbett staff are for in-data reference only: do not mark absent, send reports, or send reminders
      if (isExcludedLocation(emp.location)) {
        active = false;
      }

      if (active) {
        activeEmployeesMap[emp.id] = emp.name;
      }
    }

    // Office managers must come strictly from configuration, not inferred from employee roles
    if (this.fallbackConfig?.officeManagers) {
      for (const [loc, managers] of Object.entries(this.fallbackConfig.officeManagers)) {
        officeManagers[loc] = Array.isArray(managers) ? [...managers] : [managers];
      }
    }

    return {
      employees: activeEmployeesMap, // drop-in for config.employees
      allEmployees: allEmployeesMap,
      employeesList,
      employeeLocations,
      timeExemptEmployees,
      employeeSalaries,
      officeManagers,
    };
  }

  getFallbackView(targetDateKey = null) {
    if (!this.fallbackConfig) {
      return {
        employees: {},
        allEmployees: {},
        employeesList: [],
        employeeLocations: {},
        timeExemptEmployees: new Set(),
        employeeSalaries: {},
        officeManagers: {},
      };
    }

    const employees = { ...this.fallbackConfig.employees };
    const employeesList = Object.entries(employees).map(([id, name]) => ({
      rowIndex: -1,
      id,
      phone: id,
      name,
      location: this.fallbackConfig.employeeLocations?.[id] || "",
      role: "Staff",
      salary: this.fallbackConfig.employeeSalaries?.[id] || 0,
      remarks: "",
      isLeft: false,
      status: "Active",
      leftDate: null,
      timeExempt: Array.isArray(this.fallbackConfig?.timeExemptEmployees)
        ? this.fallbackConfig.timeExemptEmployees.includes(id)
        : Boolean(this.fallbackConfig?.timeExemptEmployees?.has?.(id)),
    }));

    return {
      employees,
      allEmployees: employees,
      employeesList,
      employeeLocations: { ...this.fallbackConfig.employeeLocations },
      timeExemptEmployees: new Set(this.fallbackConfig.timeExemptEmployees),
      employeeSalaries: { ...this.fallbackConfig.employeeSalaries },
      officeManagers: { ...this.fallbackConfig.officeManagers },
    };
  }

  async getEmployee(phone) {
    const normalizedPhone = normalizeWhatsAppNumber(phone);
    const staffData = await this.getStaffData();
    const emp = staffData.employeesList.find(e => e.id === normalizedPhone);
    if (!emp) return null;

    return {
      id: emp.id,
      name: emp.name,
      location: emp.location,
      timeExempt: emp.timeExempt,
      isLeft: emp.isLeft,
      status: emp.status,
      leftDate: emp.leftDate,
      rowIndex: emp.rowIndex,
    };
  }

  async findEmployeeByName(name) {
    const targetName = normalizeText(name);
    if (!targetName) return null;

    const staffData = await this.getStaffData();
    const emp = staffData.employeesList.find(e => normalizeText(e.name) === targetName);
    if (!emp) return null;

    return {
      id: emp.id,
      name: emp.name,
      location: emp.location,
      timeExempt: emp.timeExempt,
      isLeft: emp.isLeft,
      status: emp.status,
      leftDate: emp.leftDate,
      rowIndex: emp.rowIndex,
    };
  }

  async markEmployeeLeft(nameOrPhone, leftDateInput = null) {
    const staffData = await this.getStaffData({ fresh: true });
    const query = normalizeText(nameOrPhone);
    const normalizedQueryPhone = normalizeWhatsAppNumber(nameOrPhone);

    const emp = staffData.employeesList.find(
      e => e.id === normalizedQueryPhone || normalizeText(e.name) === query || normalizeText(e.name).includes(query)
    );

    if (!emp) {
      return { ok: false, error: `Employee not found: ${nameOrPhone}` };
    }

    if (emp.rowIndex <= 1) {
      return { ok: false, error: `Cannot update row index for ${emp.name}` };
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const leftDate = leftDateInput ? (normalizeDate(leftDateInput) || leftDateInput) : todayIso;

    if (this.sheets && this.spreadsheetId) {
      const colMap = this.cache?.colMap || {};
      const statusCol = colMap.statusCol ?? 10;
      const leftDateCol = colMap.leftDateCol ?? 11;

      const statusLetter = String.fromCharCode(65 + statusCol);
      const leftDateLetter = String.fromCharCode(65 + leftDateCol);

      // Update Status and Left Date columns
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `'${this.sheetName}'!${statusLetter}${emp.rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [["Left"]] },
      });

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `'${this.sheetName}'!${leftDateLetter}${emp.rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [[leftDate]] },
      });
    }

    this.invalidate();
    return {
      ok: true,
      employee: {
        id: emp.id,
        name: emp.name,
        location: emp.location,
        status: "Left",
        leftDate,
      },
    };
  }
}

module.exports = {
  StaffStore,
  normalizeWhatsAppNumber,
  normalizeOfficeLocation,
  isLeftFromRemarks,
  extractLeftDate,
  isExcludedLocation,
};
