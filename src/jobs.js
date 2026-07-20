"use strict";

const { displayDate, zonedDateTime } = require("./time");

function createJobRunner({ config, attendance, sendMessage, now = () => new Date(), logger = console }) {
  const completedRuns = new Set();

  function context() {
    return zonedDateTime(now(), config.timezone);
  }

  function isWorkingDay(day) {
    return config.workingWeekdays.has(day.weekday) && !config.holidays.has(day.dateKey);
  }

  function isHoliday(day) {
    return config.holidays.has(day.dateKey);
  }

  function employeesOutsideJasola() {
    return Object.fromEntries(
      Object.entries(config.employees).filter(([id]) => {
        const location = String(config.employeeLocations[id] || "").trim().toLowerCase();
        return location && location !== "jasola office";
      }),
    );
  }

  function isSunday(day) {
    return day.weekday === "Sun";
  }

  async function sendAll(messages) {
    const results = await Promise.allSettled(messages.map(({ to, body }) => sendMessage(to, body)));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error(`${failed.length} outbound message(s) failed`);
    return results.length;
  }

  async function runOnce(name, task, { requireWorkingDay = true } = {}) {
    const day = context();
    const key = `${name}:${day.dateKey}`;
    if (completedRuns.has(key)) return { skipped: "already-run", sent: 0 };
    if (requireWorkingDay && !isWorkingDay(day)) return { skipped: "non-working-day", sent: 0 };
    if (!requireWorkingDay && isHoliday(day)) return { skipped: "holiday", sent: 0 };

    const result = await task(day);
    completedRuns.add(key);
    logger.info(`[JOB] ${name} completed for ${day.dateKey}`);
    return result;
  }

  return Object.freeze({
    morning: () =>
      runOnce("morning", async (day) => {
        const daily = await attendance.getDailyMap(config.employees, day.dateKey);
        const messages = Object.entries(config.employees)
          .filter(([id]) => !daily.get(id)?.inTime)
          .map(([to, name]) => ({
            to,
            body: `Good morning ${name}!\n\nPlease mark your attendance when you arrive.\nReply *in* for Office IN.`,
          }));

        return { sent: await sendAll(messages) };
      }),

    forgotOut: () =>
      runOnce("forgot-out", async (day) => {
        const daily = await attendance.getDailyMap(config.employees, day.dateKey);
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
        const daily = await attendance.getDailyMap(config.employees, day.dateKey);
        const present = [];
        const noOut = [];
        const absent = [];

        for (const [id, name] of Object.entries(config.employees)) {
          const record = daily.get(id);
          if (!record?.inTime) absent.push(name);
          else if (!record.outTime) noOut.push(`${name} (IN: ${record.inTime})`);
          else present.push(`${name} (${record.inTime}-${record.outTime})`);
        }

        const body =
          `*Attendance Report - ${displayDate(day.dateKey)}*\n\n` +
          `Present (${present.length}): ${present.join(", ") || "None"}\n\n` +
          `No OUT marked (${noOut.length}): ${noOut.join(", ") || "None"}\n\n` +
          `Absent (${absent.length}): ${absent.join(", ") || "None"}`;

        await sendMessage(config.adminNumber, body);
        return { sent: 1 };
      }),

    autoAbsent: () =>
      runOnce(
        "auto-absent",
        async (day) => {
          const employeesToMark = isSunday(day) ? employeesOutsideJasola() : config.employees;

          return {
            markedAbsent: await attendance.markAbsent(employeesToMark, day.dateKey, config.employeeLocations),
            sent: 0,
          };
        },
        { requireWorkingDay: false },
      ),

  });
}

module.exports = { createJobRunner };
