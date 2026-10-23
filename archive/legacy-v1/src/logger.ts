import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "FEISHU_APP_SECRET",
    "FEISHU_ENCRYPT_KEY",
    "FEISHU_VERIFICATION_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ARK_API_KEY",
    "env.FEISHU_APP_SECRET",
    "env.FEISHU_ENCRYPT_KEY",
    "env.FEISHU_VERIFICATION_TOKEN",
    "env.ANTHROPIC_API_KEY",
    "env.ANTHROPIC_AUTH_TOKEN",
    "env.ARK_API_KEY",
    "*.appSecret",
    "*.encryptKey",
    "*.verificationToken",
    "*.apiKey",
    "*.authToken"
  ]
});
