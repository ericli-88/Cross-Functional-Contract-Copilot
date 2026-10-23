import type { ChatContractReviewInput } from "../domain/types.js";
import { buildReviewPrompt } from "./prompt.js";
import {
  ContractReviewResultSchema,
  toClaudeJsonSchema,
  type ContractReviewResult
} from "./reviewSchema.js";
import { logger } from "../logger.js";
import { loadInlineSkillReferences } from "./skillReferences.js";

export interface ClaudeReviewConfig {
  projectRoot: string;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  model?: string;
  disableNonessentialTraffic?: "0" | "1";
  maxTurns: number;
  timeoutMs: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

type ReviewModelMode = "pro" | "mini" | "standard";

interface ReviewModelProfile {
  mode: ReviewModelMode;
  temperature: number;
  maxTokens: number;
  strictJsonHints: string[];
  useFallbackResult: boolean;
}

export async function reviewWithClaude(
  input: ChatContractReviewInput,
  config: ClaudeReviewConfig
): Promise<ContractReviewResult> {
  const referenceContent = await loadInlineSkillReferences(
    config.projectRoot,
    input.reviewProfile.skillReferences
  );
  const prompt = buildReviewPrompt(input, referenceContent);
  const apiKey = config.apiKey ?? config.authToken;
  if (!isUsableApiKey(apiKey)) {
    throw new Error(
      "AI API Key 未配置或仍是占位符。请在 .env 里设置 AI_API_KEY，或设置 ANTHROPIC_AUTH_TOKEN 为火山方舟/OpenAI-compatible API Key。"
    );
  }

  const model = config.model ?? "gpt-4o-mini";
  const modelProfile = resolveReviewModelProfile(model);
  const requestStartedAt = Date.now();
  logger.info(
    {
      contractId: input.contractId,
      version: input.version,
      roleKey: input.reviewProfile.key,
      model,
      modelMode: modelProfile.mode,
      textLength: input.contract.text.length,
      promptLength: prompt.length,
      maxTokens: modelProfile.maxTokens
    },
    "ai review request started"
  );
  const responseText = await callOpenAICompatibleChatCompletion({
    apiKey,
    baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
    model,
    modelProfile,
    timeoutMs: config.timeoutMs,
    prompt
  });
  logger.info(
    {
      contractId: input.contractId,
      version: input.version,
      roleKey: input.reviewProfile.key,
      model,
      modelMode: modelProfile.mode,
      durationMs: Date.now() - requestStartedAt,
      responseLength: responseText.length
    },
    "ai review request completed"
  );

  const result = await parseOrRepairReviewResult({
    responseText,
    input,
    apiKey,
    baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
    model,
    modelProfile,
    timeoutMs: config.timeoutMs,
    prompt
  });
  if (!isLikelyEnglishResult(result)) return result;

  const languageRetryStartedAt = Date.now();
  logger.warn(
    {
      contractId: input.contractId,
      version: input.version,
      roleKey: input.reviewProfile.key,
      model,
      modelMode: modelProfile.mode
    },
    "ai review output used too much English; requesting Chinese rewrite"
  );
  const retryText = await callOpenAICompatibleChatCompletion({
    apiKey,
    baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
    model,
    modelProfile,
    timeoutMs: config.timeoutMs,
    prompt: [
      prompt,
      "",
      "Language correction:",
      "The previous output used too much English.",
      "Return the same schema again, but all user-facing JSON string values must be written in Simplified Chinese.",
      "Translate risk titles, risk details, actions, and tips into Simplified Chinese. Keep only unavoidable contract names or legal terms in English."
    ].join("\n")
  });
  logger.info(
    {
      contractId: input.contractId,
      version: input.version,
      roleKey: input.reviewProfile.key,
      model,
      modelMode: modelProfile.mode,
      durationMs: Date.now() - languageRetryStartedAt,
      responseLength: retryText.length
    },
    "ai review Chinese rewrite completed"
  );

  return parseReviewResult(retryText, input, modelProfile, {
    allowFallback: false
  });
}

function isUsableApiKey(value?: string): value is string {
  if (!value) return false;
  return !/^(replace|your_|xxx|test|demo|sk_replace)/iu.test(value);
}

async function callOpenAICompatibleChatCompletion(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  modelProfile: ReviewModelProfile;
  timeoutMs: number;
  prompt: string;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetch(resolveChatCompletionUrl(input.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        temperature: input.modelProfile.temperature,
        max_tokens: input.modelProfile.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are a careful contract review assistant.",
              "Return exactly one valid JSON object and no Markdown.",
              "All user-facing JSON string values must be written in Simplified Chinese, even when the contract text or reference material is English.",
              "Keep only unavoidable contract names, defined terms, or legal terms in English.",
              ...input.modelProfile.strictJsonHints,
              "The JSON object must match this schema:",
              JSON.stringify(toClaudeJsonSchema())
            ].join("\n")
          },
          {
            role: "user",
            content: input.prompt
          }
        ]
      })
    });

    const payload = (await response.json().catch(() => undefined)) as
      | ChatCompletionResponse
      | undefined;

    if (!response.ok) {
      const message =
        payload?.error?.message ??
        `AI request failed with HTTP ${response.status} ${response.statusText}`;
      throw new Error(message);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (!content || content.trim().length === 0) {
      throw new Error("AI response did not contain message content.");
    }

    return content;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveChatCompletionUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  if (/\/chat\/completions$/u.test(normalized)) return normalized;
  if (/\/(?:v1|api\/v3)$/u.test(normalized)) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "")
      .trim();
    try {
      return JSON.parse(withoutFence);
    } catch {
      const start = withoutFence.indexOf("{");
      const end = withoutFence.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(withoutFence.slice(start, end + 1));
      }
      throw new Error("AI response was not valid JSON.");
    }
  }
}

function parseReviewResult(
  text: string,
  input: ChatContractReviewInput,
  modelProfile: ReviewModelProfile = resolveReviewModelProfile(undefined),
  options: { allowFallback?: boolean } = {}
): ContractReviewResult {
  try {
    const parsed = parseJsonObject(text);
    const candidate = normalizeReviewPayload(unwrapReviewPayload(parsed), input);
    return ContractReviewResultSchema.parse(candidate);
  } catch (error) {
    if ((options.allowFallback ?? true) && modelProfile.useFallbackResult) {
      return buildFallbackReviewResult(input, error);
    }
    throw error;
  }
}

function isLikelyEnglishResult(result: ContractReviewResult): boolean {
  const text = [
    result.contract_type,
    ...result.must_focus.flatMap((item) => [item.title, item.detail]),
    ...result.actions,
    ...result.tips
  ].join(" ");
  const latinCharacters = (text.match(/[A-Za-z]/gu) ?? []).length;
  const cjkCharacters = (text.match(/[\u3400-\u9FFF]/gu) ?? []).length;

  return latinCharacters >= 120 && cjkCharacters < latinCharacters * 0.25;
}

function unwrapReviewPayload(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) return current;
    let nested: Record<string, unknown> | undefined;
    for (const key of ["result", "review", "data", "output"]) {
      const candidate = current[key];
      if (isRecord(candidate)) {
        nested = candidate;
        break;
      }
    }
    if (nested) {
      current = nested;
    } else {
      return current;
    }
  }
  return current;
}

function normalizeReviewPayload(
  value: unknown,
  input: ChatContractReviewInput
): unknown {
  const record = isRecord(value) ? value : {};

  return {
    contract_type:
      readStringField(record, [
        "contract_type",
        "contractType",
        "contract_category",
        "合同类型",
        "合同类别"
      ]) ?? inferContractType(input.documentTitle),
    risk_level: normalizeRiskLevel(
      readStringField(record, ["risk_level", "riskLevel", "风险等级"])
    ),
    suggestion: normalizeSuggestion(
      readStringField(record, ["suggestion", "处理建议", "审核建议", "建议"])
    ),
    confidence: normalizeConfidence(record.confidence ?? record["置信度"]),
    must_focus: normalizeFocusItems(
      readArrayField(record, ["must_focus", "mustFocus", "risks", "必须关注", "重点风险"])
    ),
    actions: normalizeStringArray(
      readArrayField(record, ["actions", "next_actions", "建议动作", "修改建议", "行动建议"]),
      8
    ),
    tips: normalizeStringArray(
      readArrayField(record, ["tips", "reminders", "审批提示", "提示"]),
      5
    )
  };
}

function readStringField(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readArrayField(
  record: Record<string, unknown>,
  keys: string[]
): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function normalizeRiskLevel(value?: string): "low" | "medium" | "high" {
  const normalized = (value ?? "").toLowerCase();
  if (/high|高/u.test(normalized)) return "high";
  if (/low|低/u.test(normalized)) return "low";
  return "medium";
}

function normalizeSuggestion(value?: string): "suggest_approve" | "supplement_required" | "manual_review" {
  const normalized = (value ?? "").toLowerCase();
  if (/suggest_approve|通过|approve/u.test(normalized)) return "suggest_approve";
  if (/manual_review|人工|复核|重点/u.test(normalized)) return "manual_review";
  return "supplement_required";
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampConfidence(value > 1 ? value / 100 : value);
  }

  if (typeof value === "string") {
    const numeric = Number(value.replace(/%/gu, "").trim());
    if (Number.isFinite(numeric)) return clampConfidence(numeric > 1 ? numeric / 100 : numeric);
  }

  return 0.7;
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeFocusItems(value?: unknown[]): Array<{ title: string; detail: string }> {
  const items = (value ?? [])
    .map((item) => {
      if (typeof item === "string" && item.trim()) {
        return { title: "关注事项", detail: item.trim() };
      }
      if (!isRecord(item)) return undefined;
      const title =
        readStringField(item, ["title", "risk", "name", "标题", "风险点", "风险"]) ??
        "关注事项";
      const detail =
        readStringField(item, ["detail", "description", "reason", "内容", "详情", "说明"]) ??
        title;
      return { title, detail };
    })
    .filter((item): item is { title: string; detail: string } => Boolean(item));

  return items.slice(0, 8);
}

function normalizeStringArray(
  value: unknown[] | undefined,
  maxItems: number
): string[] {
  const strings = (value ?? [])
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (isRecord(item)) {
        return (
          readStringField(item, ["text", "action", "tip", "content", "内容", "建议"]) ??
          ""
        );
      }
      return "";
    })
    .filter((item) => item.length > 0);

  return strings.slice(0, maxItems);
}

function inferContractType(documentTitle: string): string {
  return /协议/u.test(documentTitle) ? "协议类合同" : "合同文件";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function parseOrRepairReviewResult(input: {
  responseText: string;
  input: ChatContractReviewInput;
  apiKey: string;
  baseUrl: string;
  model: string;
  modelProfile: ReviewModelProfile;
  timeoutMs: number;
  prompt: string;
}): Promise<ContractReviewResult> {
  try {
    return parseReviewResult(input.responseText, input.input, input.modelProfile, {
      allowFallback: false
    });
  } catch (error) {
    const repairStartedAt = Date.now();
    logger.warn(
      {
        err: error,
        contractId: input.input.contractId,
        version: input.input.version,
        roleKey: input.input.reviewProfile.key,
        model: input.model,
        modelMode: input.modelProfile.mode
      },
      "ai review output parse failed; requesting schema repair"
    );

    try {
      const repairText = await callOpenAICompatibleChatCompletion({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        model: input.model,
        modelProfile: input.modelProfile,
        timeoutMs: input.timeoutMs,
        prompt: [
          input.prompt,
          "",
          "Schema repair:",
          "The previous output could not be parsed into the required JSON schema.",
          "Return only one top-level JSON object with these exact top-level keys:",
          "contract_type, risk_level, suggestion, confidence, must_focus, actions, tips.",
          "Do not wrap the object inside result/data/output.",
          "All user-facing strings must be Simplified Chinese.",
          "Do not return {} or an empty object. must_focus/actions/tips must contain concrete contract-specific content.",
          `Previous model output length: ${input.responseText.length}`,
          `Previous model output preview: ${input.responseText.slice(0, 800)}`,
          `Previous parser error: ${
            error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600)
          }`
        ].join("\n")
      });

      return parseReviewResult(repairText, input.input, input.modelProfile, {
        allowFallback: false
      });
    } catch (repairError) {
      logger.warn(
        {
          err: repairError,
          contractId: input.input.contractId,
          version: input.input.version,
          roleKey: input.input.reviewProfile.key,
          model: input.model,
          modelMode: input.modelProfile.mode,
          durationMs: Date.now() - repairStartedAt
        },
        "ai review schema repair failed; failing role review"
      );
      throw new Error(
        `AI response was not a complete structured review result after schema repair: ${
          repairError instanceof Error ? repairError.message : String(repairError)
        }`
      );
    }
  }
}

export function resolveReviewModelMode(model?: string): ReviewModelMode {
  const normalized = (model ?? "").toLowerCase();
  if (/doubao.*mini|mini.*doubao|seed.*mini/u.test(normalized)) return "mini";
  if (/doubao.*pro|pro.*doubao|seed.*pro/u.test(normalized)) return "pro";
  return "standard";
}

function resolveReviewModelProfile(model?: string): ReviewModelProfile {
  const mode = resolveReviewModelMode(model);
  if (mode === "mini") {
    return {
      mode,
      temperature: 0,
      maxTokens: 2600,
      useFallbackResult: true,
      strictJsonHints: [
        "This is a smaller model, so follow the schema mechanically.",
        "The JSON must not be wrapped inside result, data, output, markdown, or code fences.",
        "If unsure about a value, fill a safe Chinese value instead of omitting the key.",
        "risk_level must be exactly one of: low, medium, high.",
        "suggestion must be exactly one of: suggest_approve, supplement_required, manual_review."
      ]
    };
  }

  return {
    mode,
    temperature: 0.1,
    maxTokens: 2200,
    useFallbackResult: false,
    strictJsonHints: []
  };
}

function buildFallbackReviewResult(
  input: ChatContractReviewInput,
  error: unknown
): ContractReviewResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    contract_type: inferContractType(input.documentTitle),
    risk_level: "medium",
    suggestion: "manual_review",
    confidence: 0.45,
    must_focus: [
      {
        title: "AI 输出格式异常",
        detail:
          "模型没有返回完整的结构化审查结果。本次卡片仅作为兜底提示，请负责人结合合同原文人工复核。"
      },
      {
        title: "需要人工确认合同风险",
        detail:
          "请重点核对服务范围、验收标准、付款节点、责任上限、变更收费和终止结算等核心条款。"
      }
    ],
    actions: [
      "重新发送同一份合同链接可再次触发审查。",
      "如多次出现该提示，建议临时切回 pro 模型，或缩短合同正文后重新审查。",
      `技术提示：${message.slice(0, 160)}`
    ],
    tips: ["AI 结果仅供人工审核参考。"]
  };
}

export function parseReviewResultForTest(
  text: string,
  input: ChatContractReviewInput,
  model?: string
): ContractReviewResult {
  return parseReviewResult(text, input, resolveReviewModelProfile(model));
}
