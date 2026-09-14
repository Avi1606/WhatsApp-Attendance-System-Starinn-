"use strict";

const { displayDate, zonedDateTime } = require("./time");

function money(value) {
  return Math.round(value || 0).toLocaleString("en-IN");
}

function addMonths(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function salaryCycleFor(currentDateKey) {
  const [year, month, day] = currentDateKey.split("-").map(Number);
  const endMonth = day >= 20 ? { year, month } : addMonths(year, month, -1);
  const startMonth = addMonths(endMonth.year, endMonth.month, -1);

  return {
    startDateKey: dateKey(startMonth.year, startMonth.month, 20),
    endDateKey: dateKey(endMonth.year, endMonth.month, 20),
  };
}

function numberedLines(items, formatter = (item) => item) {
  if (!items.length) return "None";
  return items.map((item, index) => `${index + 1}. ${formatter(item)}`).join("\n");
}

function managerNumbersFor(config, office) {
  const managers = config.officeManagers[office];
  if (!managers) return [];
  return Array.isArray(managers) ? managers : [managers];
}

function shiftDateKey(dateKey, deltaDays) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function formatOfficeReport(report, day) {
  return [
    `Daily Attendance Report - ${report.office}`,
    `Date: ${displayDate(day.dateKey)}`,
    "",
    "Absent:",
    numberedLines(report.absent),
    "",
    "No OUT:",
    numberedLines(report.noOut, (item) => `${item.name} - IN ${item.inTime}`),
    "",
    "Late:",
    numberedLines(report.late, (item) => `${item.name} - IN ${item.inTime}${item.outTime ? `, OUT ${item.outTime}` : ""}`),
    "",
    "Half Day:",
    numberedLines(report.halfDay, (item) => `${item.name} - IN ${item.inTime}${item.outTime ? `, OUT ${item.outTime}` : ""}`),
  ].join("\n");
}

function formatSalaryReport(row, cycle) {
  const grossBeforeFine = Math.max(row.salary - row.deductionDays * row.perDaySalary, 0);
  return [
    `Salary Report - ${row.name}`,
    `Cycle: ${displayDate(cycle.startDateKey)} to ${displayDate(cycle.endDateKey)}`,
    "",
    `Total IN/OUT present days: ${row.presentDays}`,
    `Half days: ${row.halfDays}`,
    `Absent days: ${row.absentDays}`,
    `No OUT marked days: ${row.noOutDays}`,
    `Late days: ${row.lateDays || 0}`,
    `Max absent days allowed: ${row.maxLeaves}`,
    "",
    `Salary: Rs ${money(row.salary)}`,
    `Per day salary: Rs ${money(row.perDaySalary)}`,
    `Deduction days: ${row.deductionDays}`,
    `Fine: Rs ${money(row.fine)}`,
    `Gross after attendance: Rs ${money(grossBeforeFine)}`,
    `Final payout: Rs ${money(row.totalPayout)}`,
    "",
    "Note: No OUT marked days are not counted as present because OUT was not marked. They are counted as absent/not payable.",
  ].join("\n");
}

function createJobRunner({ config, attendance, staffStore = null, sendMessage, now = () => new Date(), logger = console }) {
  const completedRuns = new Set();

  function context() {
    return zonedDateTime(now(), config.timezone);
  }

  async function getStaff(targetDateKey = null) {
    if (staffStore) {
      return staffStore.getStaffData({ fresh: true, targetDateKey });
    }
    return {
      employees: config.employees,
      allEmployees: config.employees,
      employeeLocations: config.employeeLocations,
      timeExemptEmployees: config.timeExemptEmployees,
      employeeSalaries: config.employeeSalaries,
      officeManagers: config.officeManagers,
    };
  }

  function isWorkingDay(day) {
    return config.workingWeekdays.has(day.weekday) && !config.holidays.has(day.dateKey);
  }

  function isHoliday(day) {
    return config.holidays.has(day.dateKey);
  }

  async function sendAll(messages) {
    const results = await Promise.allSettled(messages.map(({ to, body }) => sendMessage(to, body)));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error(`${failed.length} outbound message(s) failed`);
    return results.length;
  }

  async function runOnce(name, task, { requireWorkingDay = true, skipOnHoliday = true } = {}) {
    const day = context();
    const key = `${name}:${day.dateKey}`;
    if (completedRuns.has(key)) return { skipped: "already-run", sent: 0 };
    if (requireWorkingDay && !isWorkingDay(day)) return { skipped: "non-working-day", sent: 0 };
    if (skipOnHoliday && isHoliday(day)) return { skipped: "holiday", sent: 0 };

    const result = await task(day);
    completedRuns.add(key);
    logger.info(`[JOB] ${name} completed for ${day.dateKey}`);
    return result;
  }

  return Object.freeze({
    morning: () =>
      runOnce("morning", async (day) => {
        const staff = await getStaff(day.dateKey);
        const daily = await attendance.getDailyMap(staff.employees, day.dateKey);
        const messages = Object.entries(staff.employees)
          .filter(([id]) => !daily.get(id)?.inTime)
          .map(([to, name]) => ({
            to,
            body: `Good morning ${name}!\n\nPlease mark your attendance when you arrive.\nReply *in* for Office IN.`,
          }));

        return { sent: await sendAll(messages) };
      }),

    forgotOut: () =>
      runOnce("forgot-out", async (day) => {
        const staff = await getStaff(day.dateKey);
        const daily = await attendance.getDailyMap(staff.employees, day.dateKey);
        const messages = [...daily.entries()]
          .filter(([, record]) => record.inTime && !record.outTime)
          .map(([to, record]) => ({
            to,
            body: `Reminder: Hey ${record.name}, you marked IN at ${record.inTime} but haven't marked OUT yet.\nReply *out* when you leave.`,
          }));

        return { sent: await sendAll(messages) };
      }),

    dailyReport: () =>
      runOnce("daily-report", async (day) => {
        const reportDateKey = shiftDateKey(day.dateKey, -1);
        const staff = await getStaff(reportDateKey);
        const daily = await attendance.getDailyMap(staff.employees, reportDateKey);
        const present = [];
        const noOut = [];
        const absent = [];

        for (const [id, name] of Object.entries(staff.employees)) {
          const record = daily.get(id);
          if (!record) continue;

          if (!record.inTime || record.remarks === "Absent" || record.status === "Absent") absent.push(name);
          else if (!record.outTime) noOut.push(`${name} (IN: ${record.inTime})`);
          else present.push(`${name} (${record.inTime}-${record.outTime})`);
        }

        const body =
          `*Attendance Report - ${displayDate(reportDateKey)}*\n\n` +
          `Present (${present.length}): ${present.join(", ") || "None"}\n\n` +
          `No OUT marked (${noOut.length}): ${noOut.join(", ") || "None"}\n\n` +
          `Absent (${absent.length}): ${absent.join(", ") || "None"}`;

        await sendMessage(config.adminNumber, body);
        return { sent: 1 };
      }, { requireWorkingDay: false, skipOnHoliday: false }),

    locationDailyReport: () =>
      runOnce("location-daily-report", async (day) => {
        const reportDateKey = shiftDateKey(day.dateKey, -1);
        const staff = await getStaff(reportDateKey);
        const reports = await attendance.getDailyOfficeReport(staff.employees, staff.employeeLocations, reportDateKey);
        const effectiveOfficeManagers = { ...config.officeManagers, ...staff.officeManagers };
        const effectiveConfig = { ...config, officeManagers: effectiveOfficeManagers };
        const messages = reports
          .filter((report) => managerNumbersFor(effectiveConfig, report.office).length > 0)
          .flatMap((report) =>
            managerNumbersFor(effectiveConfig, report.office).map((managerNumber) => ({
              to: managerNumber,
              body: formatOfficeReport(report, { dateKey: reportDateKey }),
            })),
          );

        return { sent: await sendAll(messages) };
      }, { requireWorkingDay: false, skipOnHoliday: false }),

    salaryReport: () =>
      runOnce(
        "salary-report",
        async (day) => {
          const cycle = salaryCycleFor(day.dateKey);
          const staff = await getStaff(cycle.endDateKey);
          const reports = await attendance.getSalaryReport({
            employees: staff.employees,
            employeeLocations: staff.employeeLocations,
            employeeSalaries: { ...config.employeeSalaries, ...staff.employeeSalaries },
            employeeFines: config.employeeFines,
            salarySheetName: config.salarySheetName,
            startDateKey: cycle.startDateKey,
            endDateKey: cycle.endDateKey,
          });
          const messages = reports
            .filter((report) => report.salary > 0 || report.perDaySalary > 0 || report.totalPayout > 0)
            .map((report) => ({
              to: report.id,
              body: formatSalaryReport(report, cycle),
            }));

          return { sent: await sendAll(messages) };
        },
        { requireWorkingDay: false },
      ),

    autoAbsent: () =>
      runOnce(
        "auto-absent",
        async (day) => {
          const staff = await getStaff(day.dateKey);
          return {
            markedAbsent: await attendance.markAbsent(staff.employees, day.dateKey, staff.employeeLocations),
            sent: 0,
          };
        },
        { requireWorkingDay: false },
      ),

  });
}

module.exports = { createJobRunner, formatOfficeReport, formatSalaryReport, salaryCycleFor };
