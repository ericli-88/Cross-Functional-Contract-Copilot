import { logger } from "../logger.js";

const sensitiveKeyPattern =
  /authorization|token|secret|api[-_]?key|app[-_]?secret|encrypt[-_]?key/iu;
const omittedKeyPattern =
  /^(config|request|response|headers|agent|socket|res|req|_header|rawHeaders|client|ssl)$/iu;

export const silentLarkLogger = {
  trace: (...args: unknown[]) => logger.trace({ args: sanitizeLogArgs(args) }, "lark sdk trace"),
  info: (...args: unknown[]) => logger.debug({ args: sanitizeLogArgs(args) }, "lark sdk info"),
  warn: (...args: unknown[]) => logger.debug({ args: sanitizeLogArgs(args) }, "lark sdk warn"),
  error: (...args: unknown[]) => logger.debug({ args: sanitizeLogArgs(args) }, "lark sdk error"),
  debug: (...args: unknown[]) => logger.debug({ args: sanitizeLogArgs(args) }, "lark sdk debug")
};

function sanitizeLogArgs(args: unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return args.map((arg) => summarizeLogValue(arg, "", seen));
}

function summarizeLogValue(
  value: unknown,
  keyHint = "",
  seen: WeakSet<object>,
  depth = 0
): unknown {
  if (typeof value === "string") {
    if (sensitiveKeyPattern.test(keyHint)) return "[Redacted]";
    const sanitized = value.replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [Redacted]");
    return sanitized.length > 1000 ? `${sanitized.slice(0, 1000)}...` : sanitized;
  }

  if (depth > 5) return "[MaxDepth]";

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.slice(0, 20).map((item) => summarizeLogValue(item, keyHint, seen, depth + 1));
  }

  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const httpErrorSummary = summarizeHttpError(value);
  if (httpErrorSummary) return httpErrorSummary;

  const plain: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 40)) {
    plain[key] = sensitiveKeyPattern.test(key)
      ? "[Redacted]"
      : omittedKeyPattern.test(key)
        ? summarizeOmittedField(key, nested)
        : summarizeLogValue(nested, key, seen, depth + 1);
  }
  return plain;
}

function summarizeHttpError(value: object): Record<string, unknown> | undefined {
  const record = value as Record<string, unknown>;
  const response = isRecord(record.response) ? record.response : undefined;
  const responseData = isRecord(response?.data) ? response.data : undefined;
  if (!responseData && !("isAxiosError" in record) && !("config" in record)) return undefined;

  const feishuError = isRecord(responseData?.error) ? responseData.error : undefined;
  const violations = Array.isArray(feishuError?.permission_violations)
    ? feishuError.permission_violations
        .map((item) => (isRecord(item) ? readString(item.subject) : undefined))
        .filter((scope): scope is string => Boolean(scope))
    : [];

  return {
    name: readString(record.name),
    message: readString(record.message),
    code: readString(record.code),
    status: response?.status,
    feishuCode: responseData?.code,
    feishuMsg: readString(responseData?.msg),
    feishuLogId: readString(feishuError?.log_id),
    missingScopes: [...new Set(violations)]
  };
}

function summarizeOmittedField(key: string, value: unknown): unknown {
  if (key === "response" && isRecord(value)) {
    return summarizeHttpError({ response: value }) ?? "[Omitted]";
  }
  return "[Omitted]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
