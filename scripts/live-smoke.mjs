// Explicit opt-in; reads credentials from a supplied local file and never prints them.
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";
import { loadConfig } from "../dist/src/config.js";
import { reviewWithClaude } from "../dist/src/review/claudeReviewer.js";
import { resolveReviewProfile } from "../dist/src/review/reviewProfile.js";

if (!process.env.LIVE_ENV_FILE) throw new Error("Set LIVE_ENV_FILE to a local .env file. This check calls real APIs.");
const env = dotenv.parse(await readFile(process.env.LIVE_ENV_FILE));
const config = loadConfig(env);
const checks = {};
try {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.appSecret }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  checks.feishu_auth = body.code === 0 && Boolean(body.tenant_access_token) ? "pass" : `fail (code ${body.code})`;
  if (body.tenant_access_token && config.contractChatId !== "*") {
    const chat = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(config.contractChatId)}`, {
      headers: { Authorization: `Bearer ${body.tenant_access_token}` }, signal: AbortSignal.timeout(20000)
    });
    const chatBody = await chat.json();
    checks.feishu_chat_read = chatBody.code === 0 ? "pass" : `fail (code ${chatBody.code})`;
  }
} catch { checks.feishu_auth = "fail (network or API error)"; }
if (process.env.LIVE_AI_SMOKE === "1") {
  try {
    const result = await reviewWithClaude({
      contractId: "DEMO-SYNTHETIC", version: 1,
      documentTitle: "虚构服务合同（连通性测试）", documentUrl: "https://example.feishu.cn/docx/DEMO", documentToken: "DEMO",
      contract: { fileName: "synthetic.txt", text: "本合同为虚构测试。乙方向甲方提供软件配置服务，费用人民币一万元。甲方在验收后180日付款。验收标准、责任上限和提前终止结算方式未约定。", extractionWarnings: ["Synthetic fixture only; no real contract data"] },
      reviewProfile: resolveReviewProfile("finance")
    }, { projectRoot: process.cwd(), ...config.claude });
    checks.ai_structured_review = result.must_focus.length > 0 && result.actions.length > 0 ? "pass" : "fail";
  } catch (error) {
    let message = error instanceof Error ? error.message : "unknown error";
    for (const value of Object.values(env)) {
      if (value.length >= 8) message = message.replaceAll(value, "[redacted]");
    }
    checks.ai_structured_review = `fail (${message.slice(0, 350)})`;
  }
} else checks.ai_structured_review = "skip (set LIVE_AI_SMOKE=1; uses paid API)";
console.log(JSON.stringify({ checks, note: "No messages sent. No tasks or documents changed. AI input is synthetic." }, null, 2));
if (Object.values(checks).some((value) => value.startsWith("fail"))) process.exitCode = 1;
