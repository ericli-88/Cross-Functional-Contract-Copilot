import pino from "pino";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPath(input: unknown, path: string[]): unknown {
  let current = input;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeError(error: unknown): unknown {
  if (!isRecord(error) && !(error instanceof Error)) return error;

  const responseData = readPath(error, ["response", "data"]);
  const feishuError = readPath(responseData, ["error"]);
  const violations = readPath(feishuError, ["permission_violations"]);
  const missingScopes = Array.isArray(violations)
    ? violations
        .map((item) => (isRecord(item) ? readString(item.subject) : undefined))
        .filter((scope): scope is string => Boolean(scope))
    : [];

  return {
    type: error instanceof Error ? error.name : readString(error.name),
    message: error instanceof Error ? error.message : readString(error.message),
    stack: error instanceof Error ? error.stack : undefined,
    code: readString(readPath(error, ["code"])) ?? readPath(error, ["code"]),
    status: readPath(error, ["status"]) ?? readPath(error, ["response", "status"]),
    feishuCode: isRecord(responseData) ? responseData.code : undefined,
    feishuMsg: isRecord(responseData) ? readString(responseData.msg) : undefined,
    feishuLogId: readString(readPath(feishuError, ["log_id"])),
    missingScopes
  };
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: sanitizeError,
    error: sanitizeError
  },
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
    "*.authToken",
    "*.headers.Authorization",
    "*.headers.authorization",
    "*.Authorization",
    "*.authorization"
  ]
});
