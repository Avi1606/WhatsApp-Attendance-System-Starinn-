"use strict";

function zonedDateTime(now = new Date(), timezone = "Asia/Kolkata") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    dateKey,
    displayDate: `${parts.day}/${parts.month}/${parts.year}`,
    monthKey: `${parts.year}-${parts.month}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now),
  };
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = String(value.getUTCFullYear());
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  if (typeof value !== "string" && typeof value !== "number") return null;
  let year;
  let month;
  let day;
  const input = String(value).trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(input);
  if (match) [, year, month, day] = match;
  else {
    match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(input);
    if (!match) return null;
    [, day, month, year] = match;
  }
  month = String(Number(month)).padStart(2, "0");
  day = String(Number(day)).padStart(2, "0");
  const candidate = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getUTCFullYear() !== Number(year) ||
    candidate.getUTCMonth() + 1 !== Number(month) ||
    candidate.getUTCDate() !== Number(day)
  ) return null;
  return `${year}-${month}-${day}`;
}

function normalizeMonthFirstDate(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const input = String(value).trim();
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(input);
  if (!match) return null;

  let [, month, day, year] = match;
  month = String(Number(month)).padStart(2, "0");
  day = String(Number(day)).padStart(2, "0");

  const candidate = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getUTCFullYear() !== Number(year) ||
    candidate.getUTCMonth() + 1 !== Number(month) ||
    candidate.getUTCDate() !== Number(day)
  ) return null;

  return `${year}-${month}-${day}`;
}

function sheetDateMatches(value, dateKey) {
  if (String(value || "").trim() === dateKey) return true;
  return normalizeDate(value) === dateKey || normalizeMonthFirstDate(value) === dateKey;
}

function displayDate(dateKey) {
  const normalized = normalizeDate(dateKey);
  if (!normalized) return dateKey;
  const [year, month, day] = normalized.split("-");
  return `${day}/${month}/${year}`;
}

module.exports = { zonedDateTime, normalizeDate, normalizeMonthFirstDate, sheetDateMatches, displayDate };
