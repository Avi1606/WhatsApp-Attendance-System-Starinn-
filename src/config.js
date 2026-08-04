"use strict";

const fs = require("node:fs");
const path = require("node:path");

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireWhatsAppNumber(value, label) {
  const number = requireString(value, label);
  if (!/^whatsapp:\+\d{8,15}$/.test(number)) {
    throw new Error(`${label} must use the format whatsapp:+<country code><number>`);
  }
  return number;
}

function optionalMoneyMap(rawMap, normalizedEmployees, label) {
  const result = {};
  if (rawMap === undefined) return result;
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    throw new Error(`${label} must be an object mapping WhatsApp numbers to numbers`);
  }

  for (const [phone, value] of Object.entries(rawMap)) {
    const normalizedPhone = requireWhatsAppNumber(phone, `${label} employee phone`);
    if (!normalizedEmployees[normalizedPhone]) {
      throw new Error(`${label} configured for unknown employee: ${normalizedPhone}`);
    }

    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`${label} must be a non-negative number for ${normalizedPhone}`);
    }
    result[normalizedPhone] = amount;
  }

  return result;
}

function loadConfig(env = process.env, cwd = process.cwd()) {
  const configPath = path.resolve(cwd, env.CONFIG_PATH || "config.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load CONFIG_PATH (${configPath}): ${error.message}`);
  }

  const employees = raw.employees;
  if (!employees || typeof employees !== "object" || Array.isArray(employees)) {
    throw new Error("employees must be an object mapping WhatsApp numbers to names");
  }

  const normalizedEmployees = {};
  const seenNames = new Set();
  for (const [phone, employeeName] of Object.entries(employees)) {
    const normalizedPhone = requireWhatsAppNumber(phone, "employee phone");
    const name = requireString(employeeName, `employee name for ${normalizedPhone}`);
    const nameKey = name.toLocaleLowerCase("en-IN");
    if (seenNames.has(nameKey)) {
      throw new Error(`Duplicate employee name is not allowed: ${name}`);
    }
    seenNames.add(nameKey);
    normalizedEmployees[normalizedPhone] = name;
  }

  if (Object.keys(normalizedEmployees).length === 0) {
    throw new Error("At least one employee must be configured");
  }

  const employeeLocations = {};
  if (raw.employeeLocations !== undefined) {
    if (!raw.employeeLocations || typeof raw.employeeLocations !== "object" || Array.isArray(raw.employeeLocations)) {
      throw new Error("employeeLocations must be an object mapping WhatsApp numbers to office location");
    }

    for (const [phone, location] of Object.entries(raw.employeeLocations)) {
      const normalizedPhone = requireWhatsAppNumber(phone, "location employee phone");
      if (!normalizedEmployees[normalizedPhone]) {
        throw new Error(`Location configured for unknown employee: ${normalizedPhone}`);
      }
      employeeLocations[normalizedPhone] = requireString(location, `office location for ${normalizedPhone}`);
    }
  }

  const timeExemptEmployees = new Set((raw.timeExemptEmployees || []).map((phone) => requireWhatsAppNumber(phone, "time exempt employee phone")));
  for (const phone of timeExemptEmployees) {
    if (!normalizedEmployees[phone]) throw new Error(`Time exempt employee is not configured: ${phone}`);
  }

  const officeManagers = {};
  if (raw.officeManagers !== undefined) {
    if (!raw.officeManagers || typeof raw.officeManagers !== "object" || Array.isArray(raw.officeManagers)) {
      throw new Error("officeManagers must be an object mapping office location to WhatsApp number");
    }

    for (const [office, phone] of Object.entries(raw.officeManagers)) {
      officeManagers[requireString(office, "office manager location")] = requireWhatsAppNumber(phone, `manager phone for ${office}`);
    }
  }

  const employeeSalaries = optionalMoneyMap(raw.employeeSalaries, normalizedEmployees, "employeeSalaries");
  const employeeFines = optionalMoneyMap(raw.employeeFines, normalizedEmployees, "employeeFines");

  const admins = new Set((raw.admins || []).map((phone) => requireWhatsAppNumber(phone, "admin phone")));
  for (const phone of admins) {
    if (!normalizedEmployees[phone]) throw new Error(`Admin is not an employee: ${phone}`);
  }

  const adminNumber = requireWhatsAppNumber(raw.adminNumber, "adminNumber");
  if (!normalizedEmployees[adminNumber]) throw new Error("adminNumber must belong to a configured employee");

  const timezone = requireString(raw.timezone || "Asia/Kolkata", "timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }

  const workingWeekdays = raw.workingWeekdays || ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (!Array.isArray(workingWeekdays) || workingWeekdays.some((day) => !["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(day))) {
    throw new Error("workingWeekdays must contain three-letter weekday names such as Mon");
  }
  const holidays = new Set(raw.holidays || []);
  for (const date of holidays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Holiday must use YYYY-MM-DD: ${date}`);
  }

  return Object.freeze({
    spreadsheetId: requireString(raw.spreadsheetId, "spreadsheetId"),
    sheetName: requireString(raw.sheetName || "Attendance", "sheetName"),
    salarySheetName: requireString(raw.salarySheetName || raw.sheetName || "Attendance", "salarySheetName"),
    twilioFromNumber: requireWhatsAppNumber(raw.twilioFromNumber, "twilioFromNumber"),
    adminNumber,
    admins,
    employees: Object.freeze(normalizedEmployees),
    employeeLocations: Object.freeze(employeeLocations),
    timeExemptEmployees,
    officeManagers: Object.freeze(officeManagers),
    employeeSalaries: Object.freeze(employeeSalaries),
    employeeFines: Object.freeze(employeeFines),
    timezone,
    workingWeekdays: new Set(workingWeekdays),
    holidays,
    reportsEnabled: raw.reportsEnabled === true,
    twilioSid: requireString(env.TWILIO_ACCOUNT_SID || env.TWILIO_SID, "TWILIO_ACCOUNT_SID"),
    twilioToken: requireString(env.TWILIO_AUTH_TOKEN || env.TWILIO_TOKEN, "TWILIO_AUTH_TOKEN"),
    cronSecret: requireString(env.CRON_SECRET, "CRON_SECRET"),
    port: Number.parseInt(env.PORT || "3000", 10),
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    validateTwilioSignature: env.TWILIO_VALIDATE_WEBHOOK !== "false" && env.TWILIO_VALIDATE_WEBHOOK !== "0",
    configPath,
  });
}

module.exports = { loadConfig };
