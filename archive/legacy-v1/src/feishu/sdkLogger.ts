import { logger } from "../logger.js";

const sensitiveKeyPattern =
  /authorization|token|secret|api[-_]?key|app[-_]?secret|encrypt[-_]?key/iu;

export const silentLarkLogger = {
  trace: (...args: unknown[]) => logger.trace({ args: sanitizeLogArgs(args) }, "lark sdk trace"),
  info: (...args: unknown[]) => logger.debug({ args: sanitizeLogArgs(args) }, "lark sdk info"),
  warn: (...args: unknown[]) => logger.warn({ args: sanitizeLogArgs(args) }, "lark sdk warn"),
  error: (...args: unknown[]) => logger.error({ args: sanitizeLogArgs(args) }, "lark sdk error"),
  debug: (...args: unknown[]) => logger.debug({ args: sanitizeLogArgs(args) }, "lark sdk debug")
};

function sanitizeLogArgs(args: unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return args.map((arg) => sanitizeLogValue(arg, "", seen));
}

function sanitizeLogValue(
  value: unknown,
  keyHint = "",
  seen: WeakSet<object>,
  depth = 0
): unknown {
  if (typeof value === "string") {
    if (sensitiveKeyPattern.test(keyHint)) return "[Redacted]";
    return value.replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [Redacted]");
  }

  if (depth > 8) return "[MaxDepth]";

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.slice(0, 50).map((item) => sanitizeLogValue(item, keyHint, seen, depth + 1));
  }

  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const plain: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 80)) {
    plain[key] = sensitiveKeyPattern.test(key)
      ? "[Redacted]"
      : sanitizeLogValue(nested, key, seen, depth + 1);
  }
  return plain;
}
