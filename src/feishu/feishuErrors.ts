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

export function extractFeishuErrorData(error: unknown): Record<string, unknown> | undefined {
  const data = readPath(error, ["response", "data"]);
  return isRecord(data) ? data : undefined;
}

export function extractMissingScopes(error: unknown): string[] {
  const data = extractFeishuErrorData(error);
  const violations = readPath(data, ["error", "permission_violations"]);
  const scopes = Array.isArray(violations)
    ? violations
        .map((item) => (isRecord(item) ? readString(item.subject) : undefined))
        .filter((scope): scope is string => Boolean(scope))
    : [];
  if (scopes.length > 0) return [...new Set(scopes)];

  const message = `${readString(data?.msg) ?? ""}\n${error instanceof Error ? error.message : String(error)}`;
  const bracketMatch = message.match(/scopes? is required:\s*\[([^\]]+)\]/iu);
  if (!bracketMatch) return [];
  return bracketMatch[1]
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function isMissingScopeError(error: unknown): boolean {
  const data = extractFeishuErrorData(error);
  return data?.code === 99991672 || extractMissingScopes(error).length > 0;
}

export function describeFeishuError(error: unknown): string {
  const scopes = extractMissingScopes(error);
  if (scopes.length > 0) {
    return `飞书应用权限未开通或新版本未发布，缺少权限：${scopes.join("、")}`;
  }

  const data = extractFeishuErrorData(error);
  if (data) {
    const code = typeof data.code === "number" ? `code=${data.code}` : undefined;
    const msg = readString(data.msg);
    return [code, msg].filter(Boolean).join("，") || JSON.stringify(data);
  }

  return error instanceof Error ? error.message : String(error);
}

export function formatMissingScopeInstruction(error: unknown): string {
  const scopes = extractMissingScopes(error);
  if (scopes.length === 0) return describeFeishuError(error);
  return [
    `缺少权限：${scopes.join("、")}`,
    "请在飞书开放平台进入当前机器人应用：权限管理，搜索并开通上面的权限。",
    "开通后一定要去“版本管理与发布”创建新版本并发布；只勾选权限但不发布，机器人拿到的 tenant_access_token 仍然没有这些权限。",
    "发布完成后，在 PowerShell 里重新运行 start-bot.ps1 -Restart，让机器人重新获取新的 token。"
  ].join("\n");
}
