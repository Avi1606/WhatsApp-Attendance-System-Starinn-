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
  if (typeof value !== "string") return null;
  let year;
  let month;
  let day;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match) [, year, month, day] = match;
  else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
    if (!match) return null;
    [, day, month, year] = match;
  }
  const candidate = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getUTCFullYear() !== Number(year) ||
    candidate.getUTCMonth() + 1 !== Number(month) ||
    candidate.getUTCDate() !== Number(day)
  ) return null;
  return `${year}-${month}-${day}`;
}

function displayDate(dateKey) {
  const normalized = normalizeDate(dateKey);
  if (!normalized) return dateKey;
  const [year, month, day] = normalized.split("-");
  return `${day}/${month}/${year}`;
}

module.exports = { zonedDateTime, normalizeDate, displayDate };
