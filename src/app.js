const crypto = require("crypto");
const express = require("express");
const twilio = require("twilio");
const { google } = require("googleapis");
const { AttendanceStore } = require("./attendance");
const { createJobRunner } = require("./jobs");
const { displayDate, normalizeDate, zonedDateTime } = require("./time");

function maskPhone(phone = "") {
  return String(phone).replace(/(\+\d{2})\d+(\d{2})$/, "$1******$2");
}

function safeEqual(a = "", b = "") {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function twiml(message) {
  const response = new twilio.twiml.MessagingResponse();
  response.message(message);
  return response.toString();
}

function emptyTwiml() {
  return new twilio.twiml.MessagingResponse().toString();
}

function createSendMessage({ twilioClient, fromNumber, logger = console }) {
  return async function sendMessage(to, body) {
    const message = await twilioClient.messages.create({
      from: fromNumber,
      to,
      body,
    });

    logger.log(`Sent WhatsApp message ${message.sid || ""} to ${maskPhone(to)}`);
    return message;
  };
}

function employeeFromConfig(config, phone) {
  const name = config.employees[phone];
  return name
    ? {
        id: phone,
        name,
        location: config.employeeLocations[phone] || "",
        timeExempt: config.timeExemptEmployees.has(phone),
      }
    : null;
}

function findEmployeeByName(config, name) {
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) return null;

  for (const [id, employeeName] of Object.entries(config.employees)) {
    if (employeeName.toLowerCase() === wanted) {
      return {
        id,
        name: employeeName,
        location: config.employeeLocations[id] || "",
        timeExempt: config.timeExemptEmployees.has(id),
      };
    }
  }

  return null;
}

function formatTime12(time24) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time24 || ""));
  if (!match) return time24 || "-";

  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? "pm" : "am";
  hour %= 12;
  if (hour === 0) hour = 12;

  return `${hour}:${minute} ${suffix}`;
}

function formatWelcome(employeeName, { isAdmin = false, reportsEnabled = false } = {}) {
  const lines = [
    `Hello ${employeeName}!`,
    "",
    "Reply *in* for Office IN",
    "Reply *out* for Office OUT",
  ];

  if (reportsEnabled) {
    lines.push("Reply *report* for monthly report");
  }

  if (isAdmin) {
    lines.push("");
    lines.push("*Admin commands*");
    lines.push("mark in <employee name>");
    lines.push("mark out <employee name>");
    lines.push("mark in <employee name> DD/MM/YYYY");
  }

  return lines.join("\n");
}

function formatAttendanceMarked(action, employeeName, displayDateValue, time) {
  return [
    `Office ${action} marked!`,
    `Employee: ${employeeName}`,
    `Date: ${displayDateValue}`,
    `Time: ${formatTime12(time)}`,
  ].join("\n");
}

function formatAlreadyMarked(action, time) {
  return [
    `Office ${action} already marked for today.`,
    time ? `Time: ${formatTime12(time)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatStatus(status) {
  if (!status.exists) {
    return [
      "Today's Attendance",
      "",
      "No attendance marked yet.",
      "Reply *in* when you arrive.",
    ].join("\n");
  }

  const lines = ["Today's Attendance", "", `Status: *${status.status}*`];
  if (status.inTime) lines.push(`IN: ${formatTime12(status.inTime)}`);
  if (status.outTime) lines.push(`OUT: ${formatTime12(status.outTime)}`);
  if (status.inTime && !status.outTime) lines.push("", "Reply *out* when you leave.");

  return lines.join("\n");
}

function formatMonthlyReport(report, monthKey) {
  const [year, month] = monthKey.split("-");
  const lines = [
    `Attendance Report (${month}/${year})`,
    "",
    `Present days: ${report.presentDays}`,
    `Absent days: ${report.absentDays}`,
    `Missed OUT days: ${report.missedOutDays}`,
  ];

  if (report.rows.length) {
    lines.push("");
    lines.push("*Details*");
    lines.push(
      ...report.rows.map((row) => {
        const inTime = row.inTime ? formatTime12(row.inTime) : "-";
        const outTime = row.outTime ? formatTime12(row.outTime) : "-";
        return `${displayDate(row.dateKey)} | IN ${inTime} | OUT ${outTime}`;
      }),
    );
  }

  return lines.join("\n");
}

function parseAdminMarkCommand(message) {
  const match = String(message || "").match(
    /^mark\s+(in|out)\s+(.+?)(?:\s+(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}))?$/i,
  );
  if (!match) return null;

  return {
    action: match[1].toUpperCase(),
    employeeName: match[2].trim(),
    dateInput: match[3] || null,
  };
}

async function createSheetsClient(googleAuth) {
  const auth =
    googleAuth ||
    new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

  return google.sheets({ version: "v4", auth });
}

function createApp({
  config,
  sheets,
  googleAuth,
  twilioLib = twilio,
  logger = console,
  now = () => new Date(),
  validateTwilioSignature = true,
} = {}) {
  if (!config) {
    throw new Error("config is required");
  }

  const app = express();
  if (config.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  const attendancePromise = Promise.resolve(sheets || createSheetsClient(googleAuth)).then(
    (resolvedSheets) =>
      new AttendanceStore({
        sheets: resolvedSheets,
        spreadsheetId: config.spreadsheetId,
        sheetName: config.sheetName,
      }),
  );

  const twilioClient = twilioLib(config.twilioSid, config.twilioToken);
  const sendMessage = createSendMessage({
    twilioClient,
    fromNumber: config.twilioFromNumber,
    logger,
  });

  const jobsPromise = attendancePromise.then((attendance) =>
    createJobRunner({
      config,
      attendance,
      sendMessage,
      now,
      logger,
    }),
  );

  function requireCronSecret(req, res, next) {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (!safeEqual(token, config.cronSecret)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    return next();
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "whatsapp-attendance-bot" });
  });

  app.post("/jobs/:name", requireCronSecret, async (req, res, next) => {
    try {
      const jobs = await jobsPromise;
      const handlers = {
        morning: jobs.morning,
        "forgot-out": jobs.forgotOut,
        "daily-report": jobs.dailyReport,
        "auto-absent": jobs.autoAbsent,
      };
      const handler = handlers[req.params.name];

      if (!handler) {
        return res.status(404).json({ ok: false, error: "Unknown job" });
      }

      const result = await handler();
      if (req.query.quiet === "1") {
        return res.status(204).send();
      }
      return res.json({ ok: true, result });
    } catch (error) {
      return next(error);
    }
  });

  const webhookMiddlewares = [];
  if (validateTwilioSignature) {
    webhookMiddlewares.push(twilioLib.webhook({ validate: true }, config.twilioToken));
  }

  app.post("/webhook", ...webhookMiddlewares, async (req, res) => {
    try {
      const attendance = await attendancePromise;
      const from = String(req.body.From || "").trim();
      const body = String(req.body.Body || "").trim().slice(0, 1000);
      const messageSid = String(req.body.MessageSid || req.body.SmsMessageSid || "").trim();
      const lowerBody = body.toLowerCase();
      const current = zonedDateTime(now(), config.timezone);
      const employee = employeeFromConfig(config, from);

      res.type("text/xml");

      if (!employee) {
        logger.warn(`Rejected unregistered WhatsApp sender ${maskPhone(from)}`);
        return res.send(
          twiml(
            [
              "You are not registered for attendance.",
              "",
              "Please contact admin to add your WhatsApp number.",
            ].join("\n"),
          ),
        );
      }

      if (lowerBody === "hi" || lowerBody === "hello" || lowerBody === "help") {
        return res.send(
          twiml(
            formatWelcome(employee.name, {
              isAdmin: config.admins.has(from),
              reportsEnabled: config.reportsEnabled,
            }),
          ),
        );
      }

      if (lowerBody === "in" || lowerBody === "out") {
        const result = await attendance.markAttendance({
          employee,
          action: lowerBody.toUpperCase(),
          dateKey: current.dateKey,
          time: current.time,
          messageSid,
        });

        if (result.ok || result.reason === "already_processed" || result.reason === "already_marked") {
          return res.send(emptyTwiml());
        }

        if (result.reason === "out_before_in") {
          return res.send(
            twiml(
              [
                "Office OUT cannot be marked yet.",
                "",
                "Please reply *in* first, then reply *out* when you leave.",
              ].join("\n"),
            ),
          );
        }

        return res.send(twiml("Could not mark attendance. Please try again."));
      }

      if (lowerBody === "status") {
        return res.send(emptyTwiml());
      }

      if (lowerBody === "report") {
        if (!config.reportsEnabled) {
          return res.send(
            twiml(
              [
                "Monthly report is currently on hold.",
                "",
                "Admin will activate it before salary slip preparation.",
              ].join("\n"),
            ),
          );
        }

        const report = await attendance.getMonthlyReport(employee, current.monthKey);
        return res.send(twiml(formatMonthlyReport(report, current.monthKey)));
      }

      const adminCommand = parseAdminMarkCommand(body);
      if (adminCommand) {
        if (!config.admins.has(from)) {
          return res.send(twiml("Only admins can mark attendance for another employee."));
        }

        const target = findEmployeeByName(config, adminCommand.employeeName);
        if (!target) {
          return res.send(twiml(`Employee not found: ${adminCommand.employeeName}`));
        }

        const dateKey = adminCommand.dateInput
          ? normalizeDate(adminCommand.dateInput)
          : current.dateKey;
        if (!dateKey) {
          return res.send(twiml("Invalid date. Use DD/MM/YYYY or YYYY-MM-DD."));
        }

        const result = await attendance.markAttendance({
          employee: target,
          action: adminCommand.action,
          dateKey,
          time: current.time,
          messageSid: `${messageSid || "admin"}:${target.id}:${adminCommand.action}:${dateKey}`,
        });

        if (result.ok) {
          return res.send(
            twiml(
              [
                "Admin update saved!",
                "",
                formatAttendanceMarked(adminCommand.action, target.name, displayDate(dateKey), current.time),
              ].join("\n"),
            ),
          );
        }
        if (result.reason === "already_marked") {
          return res.send(twiml(formatAlreadyMarked(adminCommand.action, result.time)));
        }
        if (result.reason === "out_before_in") {
          return res.send(twiml(`Please mark IN for ${target.name} before OUT.`));
        }

        return res.send(twiml("Could not complete admin mark command."));
      }

      return res.send(
        twiml(
          [
            "Unknown command.",
            "",
            "Send one of these:",
            "*in* - Office IN",
            "*out* - Office OUT",
            config.reportsEnabled ? "*report* - Monthly report" : null,
            "*help* - Show commands",
          ].filter(Boolean).join("\n"),
        ),
      );
    } catch (error) {
      logger.error("Webhook failed:", error);
      res.type("text/xml");
      return res.send(twiml("Something went wrong. Please try again."));
    }
  });

  app.use((error, _req, res, _next) => {
    logger.error("Request failed:", error);
    res.status(500).json({ ok: false, error: "Internal server error" });
  });

  app.locals.attendancePromise = attendancePromise;
  app.locals.jobsPromise = jobsPromise;

  return app;
}

module.exports = {
  createApp,
  createSendMessage,
  maskPhone,
  parseAdminMarkCommand,
  safeEqual,
  emptyTwiml,
  formatAttendanceMarked,
  formatStatus,
  formatTime12,
  formatWelcome,
};
