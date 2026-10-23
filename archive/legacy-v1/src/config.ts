import path from "node:path";
import { z } from "zod";
import { roleLabels, type OwnerRecord, type RoleKey } from "./domain/types.js";

const requiredString = z.string().trim().min(1);
const optionalString = z
  .string()
  .trim()
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional();

const positiveIntegerFromEnv = (defaultValue: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : value),
    z.coerce.number().int().positive()
  );

const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return value;
  }, z.boolean());

const httpUrlString = z
  .string()
  .trim()
  .refine(
    (value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "must be a valid http or https URL" }
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: positiveIntegerFromEnv(3000),
    PUBLIC_BASE_URL: httpUrlString.optional(),
    FEISHU_APP_ID: requiredString,
    FEISHU_APP_SECRET: requiredString,
    FEISHU_ENCRYPT_KEY: optionalString,
    FEISHU_VERIFICATION_TOKEN: requiredString,
    FEISHU_CONTRACT_CHAT_ID: requiredString.default("*"),
    FEISHU_BOT_MENTION_NAME: optionalString,
    OWNER_COMMERCIAL_NAME: requiredString.default("商务负责人"),
    OWNER_COMMERCIAL_USER_ID: optionalString,
    OWNER_OPERATIONS_NAME: requiredString.default("运营负责人"),
    OWNER_OPERATIONS_USER_ID: optionalString,
    OWNER_LEGAL_NAME: requiredString.default("法务负责人"),
    OWNER_LEGAL_USER_ID: optionalString,
    OWNER_FINANCE_NAME: requiredString.default("财务负责人"),
    OWNER_FINANCE_USER_ID: optionalString,
    REVIEW_TEST_CC_ENABLED: booleanFromEnv(false),
    REVIEW_TEST_CC_USER_IDS: optionalString,
    AI_API_KEY: optionalString,
    AI_BASE_URL: optionalString.pipe(httpUrlString.optional()),
    AI_MODEL: optionalString,
    ARK_API_KEY: optionalString,
    ARK_BASE_URL: optionalString.pipe(httpUrlString.optional()),
    ARK_MODEL: optionalString,
    ARK_VISION_MODEL: optionalString,
    ANTHROPIC_API_KEY: optionalString,
    ANTHROPIC_AUTH_TOKEN: optionalString,
    ANTHROPIC_BASE_URL: optionalString.pipe(httpUrlString.optional()),
    ANTHROPIC_MODEL: optionalString,
    API_TIMEOUT_MS: positiveIntegerFromEnv(300000),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: z.enum(["0", "1"]).default("1"),
    CLAUDE_MAX_TURNS: positiveIntegerFromEnv(8),
    DATA_DIR: requiredString.default("./data")
  });

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  const data = parsed.data;
  const projectRoot = path.resolve(process.cwd());
  const dataDir = path.resolve(projectRoot, data.DATA_DIR);

  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    publicBaseUrl: data.PUBLIC_BASE_URL,
    projectRoot,
    dataDir,
    contractChatId: data.FEISHU_CONTRACT_CHAT_ID,
    botMentionName: data.FEISHU_BOT_MENTION_NAME,
    feishu: {
      appId: data.FEISHU_APP_ID,
      appSecret: data.FEISHU_APP_SECRET,
      encryptKey: data.FEISHU_ENCRYPT_KEY,
      verificationToken: data.FEISHU_VERIFICATION_TOKEN
    },
    owners: {
      commercial: makeOwner(
        "commercial",
        data.OWNER_COMMERCIAL_NAME,
        data.OWNER_COMMERCIAL_USER_ID
      ),
      operations: makeOwner(
        "operations",
        data.OWNER_OPERATIONS_NAME,
        data.OWNER_OPERATIONS_USER_ID
      ),
      legal: makeOwner(
        "legal",
        data.OWNER_LEGAL_NAME,
        data.OWNER_LEGAL_USER_ID
      ),
      finance: makeOwner(
        "finance",
        data.OWNER_FINANCE_NAME,
        data.OWNER_FINANCE_USER_ID
      )
    },
    reviewTestCc: {
      enabled: data.REVIEW_TEST_CC_ENABLED,
      userIds: parseUserIdList(data.REVIEW_TEST_CC_USER_IDS)
    },
    claude: {
      apiKey: normalizeAiSecret(
        data.ARK_API_KEY ?? data.AI_API_KEY ?? data.ANTHROPIC_API_KEY
      ),
      authToken: normalizeAiSecret(data.ANTHROPIC_AUTH_TOKEN),
      baseUrl: data.ARK_BASE_URL ?? data.AI_BASE_URL ?? data.ANTHROPIC_BASE_URL,
      model: data.ARK_VISION_MODEL ?? data.ARK_MODEL ?? data.AI_MODEL ?? data.ANTHROPIC_MODEL,
      timeoutMs: data.API_TIMEOUT_MS,
      maxTurns: data.CLAUDE_MAX_TURNS,
      disableNonessentialTraffic: data.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    }
  };
}

function makeOwner(
  roleKey: RoleKey,
  displayName: string,
  userId?: string
): OwnerRecord {
  return {
    roleKey,
    roleLabel: roleLabels[roleKey],
    displayName,
    ...(userId ? { userId } : {}),
    source: userId ? "env" : "missing"
  };
}

function normalizeAiSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^(replace|your_|xxx|test|demo|sk_replace)/iu.test(value)) return undefined;
  return value;
}

function parseUserIdList(value?: string): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

export type AppConfig = ReturnType<typeof loadConfig>;
