"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");

function withConfig(config, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-config-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
  return callback(dir);
}

const baseConfig = {
  spreadsheetId: "sheet-id",
  sheetName: "Attendance",
  twilioFromNumber: "whatsapp:+10000000000",
  adminNumber: "whatsapp:+910000000000",
  admins: ["whatsapp:+910000000000"],
  employees: {
    "whatsapp:+910000000000": "Avi Kumar",
  },
  timezone: "Asia/Kolkata",
};

const baseEnv = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "secret",
  CRON_SECRET: "cron-secret",
};

test("loadConfig validates and freezes runtime config", () =>
  withConfig(baseConfig, (dir) => {
    const config = loadConfig(baseEnv, dir);

    assert.equal(config.spreadsheetId, "sheet-id");
    assert.equal(config.admins.has("whatsapp:+910000000000"), true);
    assert.equal(config.workingWeekdays.has("Sat"), true);
    assert.equal(config.reportsEnabled, false);
    assert.equal(config.validateTwilioSignature, true);
    assert.deepEqual(config.employeeLocations, {});
    assert.equal(config.timeExemptEmployees.size, 0);
    assert.equal(Object.isFrozen(config.employees), true);
  }));

test("loadConfig accepts employee office locations", () =>
  withConfig(
    {
      ...baseConfig,
      employeeLocations: {
        "whatsapp:+910000000000": "Delhi Office",
      },
    },
    (dir) => {
      const config = loadConfig(baseEnv, dir);

      assert.equal(config.employeeLocations["whatsapp:+910000000000"], "Delhi Office");
    },
  ));

test("loadConfig accepts time-exempt employees", () =>
  withConfig(
    {
      ...baseConfig,
      timeExemptEmployees: ["whatsapp:+910000000000"],
    },
    (dir) => {
      const config = loadConfig(baseEnv, dir);

      assert.equal(config.timeExemptEmployees.has("whatsapp:+910000000000"), true);
    },
  ));

test("loadConfig can disable Twilio validation for local webhook testing", () =>
  withConfig(baseConfig, (dir) => {
    const config = loadConfig({ ...baseEnv, TWILIO_VALIDATE_WEBHOOK: "false" }, dir);

    assert.equal(config.validateTwilioSignature, false);
  }));

test("loadConfig rejects duplicate employee names", () =>
  withConfig(
    {
      ...baseConfig,
      employees: {
        "whatsapp:+910000000000": "Avi Kumar",
        "whatsapp:+910000000001": "avi kumar",
      },
    },
    (dir) => {
      assert.throws(() => loadConfig(baseEnv, dir), /Duplicate employee name/);
    },
  ));
