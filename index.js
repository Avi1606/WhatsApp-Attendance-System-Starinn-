const { createApp } = require("./src/app");
const { loadConfig } = require("./src/config");
const { loadDotEnv } = require("./src/env");

async function main() {
  if (!loadDotEnv()) {
    loadDotEnv("password.env");
  }
  const config = loadConfig();
  const app = createApp({
    config,
    validateTwilioSignature: config.validateTwilioSignature,
  });

  app.listen(config.port, () => {
    console.log(`WhatsApp attendance bot listening on port ${config.port}`);
    console.log(`Using config: ${config.configPath}`);
    if (!config.validateTwilioSignature) {
      console.warn("Twilio webhook signature validation is OFF. Use only for local testing.");
    }
  });
}

main().catch((error) => {
  console.error("Failed to start attendance bot:", error);
  process.exit(1);
});
