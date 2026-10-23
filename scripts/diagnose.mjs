import "dotenv/config";

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { loadConfig } from "../dist/src/config.js";
import { FeishuClient } from "../dist/src/feishu/feishuClient.js";
import {
  describeFeishuError,
  extractFeishuErrorData,
  extractMissingScopes
} from "../dist/src/feishu/feishuErrors.js";
import { resolveChatCompletionUrl } from "../dist/src/review/claudeReviewer.js";

const config = loadConfig();

const result = {
  app: {
    publicBaseUrl: config.publicBaseUrl ?? null,
    callbackUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/feishu/events` : null,
    contractChatId: config.contractChatId
  },
  checks: {}
};

function setCheck(name, status, details = {}) {
  result.checks[name] = { status, ...details };
}

async function safeCheck(name, fn) {
  try {
    await fn();
  } catch (error) {
    setCheck(name, "fail", {
      message: describeDiagnosticError(error),
      missingScopes: extractMissingScopes(error)
    });
  }
}

async function main() {
  await safeCheck("local_config", async () => {
    setCheck("local_config", "pass", {
      aiBaseUrl: config.claude.baseUrl ?? null,
      aiEndpoint: config.claude.baseUrl
        ? resolveChatCompletionUrl(config.claude.baseUrl)
        : null,
      aiModel: config.claude.model ?? null,
      usableAiKey: Boolean(config.claude.apiKey || config.claude.authToken)
    });
  });

  await safeCheck("workflow_v2_config", async () => {
    const ownerCounts = Object.fromEntries(
      Object.entries(config.owners).map(([roleKey, owners]) => [
        roleKey,
        owners.filter((owner) => Boolean(owner.userId)).length
      ])
    );
    setCheck("workflow_v2_config", "pass", {
      documentArchiveEnabled: config.documentArchive.enabled,
      rootFolderTokenConfigured: Boolean(config.documentArchive.rootFolderToken),
      tasksEnabled: config.tasks.enabled,
      ownerCounts,
      testCcEnabled: config.reviewTestCc.enabled,
      testCcRecipientCount: config.reviewTestCc.userIds.length,
      note:
        "This check validates local configuration only. Feishu permissions must still be enabled and published in the Developer Console."
    });
  });

  if (config.publicBaseUrl) {
    await safeCheck("public_healthz", async () => {
      const response = await fetchPublic(`${config.publicBaseUrl}/healthz`);
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(`healthz returned HTTP ${response.status}`);
      }
      setCheck("public_healthz", "pass", { httpStatus: response.status });
    });

    await safeCheck("feishu_url_verification", async () => {
      const challenge = `diagnose_${Date.now()}`;
      const response = await fetchPublic(`${config.publicBaseUrl}/feishu/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "url_verification",
          token: config.feishu.verificationToken,
          challenge
        })
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.challenge !== challenge) {
        throw new Error(`challenge mismatch or HTTP ${response.status}`);
      }
      setCheck("feishu_url_verification", "pass", { httpStatus: response.status });
    });
  } else {
    setCheck("public_healthz", "skip", { message: "PUBLIC_BASE_URL is not configured" });
    setCheck("feishu_url_verification", "skip", {
      message: "PUBLIC_BASE_URL is not configured"
    });
  }

  const tenantToken = await getTenantAccessToken();
  let recentGroupMessagesSummary;
  await safeCheck("feishu_tenant_token", async () => {
    if (!tenantToken) throw new Error("tenant_access_token is missing");
    setCheck("feishu_tenant_token", "pass");
  });

  if (tenantToken) {
    await safeCheck("feishu_target_chat", async () => {
      if (config.contractChatId === "*") {
        setCheck("feishu_target_chat", "skip", {
          message: "FEISHU_CONTRACT_CHAT_ID is *, so no single target chat can be checked"
        });
        return;
      }

      const response = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(config.contractChatId)}`,
        {
          headers: { Authorization: `Bearer ${tenantToken}` }
        }
      );
      const body = await response.json();
      if (body.code !== 0) throw new Error(`${body.code}: ${body.msg}`);
      setCheck("feishu_target_chat", "pass", {
        chatName: body.data?.name ?? null,
        chatMode: body.data?.chat_mode ?? null
      });
    });

    await safeCheck("feishu_recent_group_messages", async () => {
      if (config.contractChatId === "*") {
        setCheck("feishu_recent_group_messages", "skip", {
          message: "FEISHU_CONTRACT_CHAT_ID is *, so no single target chat can be checked"
        });
        return;
      }

      const end = Math.floor(Date.now() / 1000);
      const start = end - 6 * 60 * 60;
      const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
      url.searchParams.set("container_id_type", "chat");
      url.searchParams.set("container_id", config.contractChatId);
      url.searchParams.set("start_time", String(start));
      url.searchParams.set("end_time", String(end));
      url.searchParams.set("sort_type", "ByCreateTimeDesc");
      url.searchParams.set("page_size", "20");

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${tenantToken}` }
      });
      const body = await response.json();
      if (body.code !== 0) throw new Error(`${body.code}: ${body.msg}`);

      const items = Array.isArray(body.data?.items) ? body.data.items : [];
      recentGroupMessagesSummary = {
        count: items.length,
        latestUserAtMessage: summarizeMessage(
          items.find((item) => item.sender?.sender_type === "user" && hasMention(item))
        ),
        latestAppMessage: summarizeMessage(
          items.find((item) => item.sender?.sender_type === "app")
        )
      };
      setCheck("feishu_recent_group_messages", "pass", recentGroupMessagesSummary);
    });

    await safeCheck("feishu_event_delivery_hint", async () => {
      if (config.contractChatId === "*") {
        setCheck("feishu_event_delivery_hint", "skip", {
          message: "FEISHU_CONTRACT_CHAT_ID is *, so no single target chat can be checked"
        });
        return;
      }

      const latestUserAtMessage = recentGroupMessagesSummary?.latestUserAtMessage;
      if (!latestUserAtMessage?.messageId) {
        setCheck("feishu_event_delivery_hint", "skip", {
          message: "No recent user @ message was found in the target chat"
        });
        return;
      }

      const latestAppMessage = recentGroupMessagesSummary?.latestAppMessage;
      if (
        latestAppMessage?.createTime &&
        Number(latestAppMessage.createTime) >= Number(latestUserAtMessage.createTime)
      ) {
        setCheck("feishu_event_delivery_hint", "pass", {
          message: "A recent app message exists after the latest user @ message"
        });
        return;
      }

      const logPath = "bot-server-current.log";
      const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      if (logText.includes(latestUserAtMessage.messageId)) {
        setCheck("feishu_event_delivery_hint", "pass", {
          message: "The current local bot log contains the latest user @ message id"
        });
        return;
      }

      setCheck("feishu_event_delivery_hint", "fail", {
        latestUserAtMessageId: latestUserAtMessage.messageId,
        message:
          "The bot can read the latest @ message through Feishu APIs, but the current local callback log never received that message and no newer app response exists. The Feishu Developer Console Event Subscription Request URL is probably not set to the current PUBLIC_BASE_URL /feishu/events, or the event subscription was not saved/published."
      });
    });

    if (process.env.DIAGNOSE_USER_ID) {
      await safeCheck("feishu_contact_user", async () => {
        const response = await fetch(
          `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(process.env.DIAGNOSE_USER_ID)}?user_id_type=user_id`,
          {
            headers: { Authorization: `Bearer ${tenantToken}` }
          }
        );
        const body = await response.json();
        if (body.code !== 0) throw new Error(`${body.code}: ${body.msg}`);
        const user = body.data?.user ?? {};
        setCheck("feishu_contact_user", "pass", {
          userId: user.user_id ?? process.env.DIAGNOSE_USER_ID,
          displayName: readDisplayName(user) ?? null,
          hasMobile: Boolean(user.mobile),
          hasEmail: Boolean(user.email)
        });
      });
    } else {
      setCheck("feishu_contact_user", "skip", {
        message: "Set DIAGNOSE_USER_ID=<user_id> to test contact display name lookup"
      });
    }

    if (process.env.DIAGNOSE_SEND_TEST_MESSAGE === "1") {
      await safeCheck("feishu_send_test_message", async () => {
        const response = await fetch(
          "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tenantToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              receive_id: config.contractChatId,
              msg_type: "text",
              content: JSON.stringify({
                text: "Codex 诊断：合同审查机器人发送通道正常。（不用回复）"
              })
            })
          }
        );
        const body = await response.json();
        if (body.code !== 0) throw new Error(`${body.code}: ${body.msg}`);
        setCheck("feishu_send_test_message", "pass", {
          messageIdPresent: Boolean(body.data?.message_id)
        });
      });
    } else {
      setCheck("feishu_send_test_message", "skip", {
        message: "Set DIAGNOSE_SEND_TEST_MESSAGE=1 to send a real group message"
      });
    }

    if (config.tasks.enabled && process.env.DIAGNOSE_TASK_SMOKE === "1") {
      await safeCheck("feishu_task_create_comment_delete", async () => {
        const assigneeUserId = findTaskSmokeAssigneeUserId();
        if (!assigneeUserId) {
          throw new Error(
            "No configured owner/test-CC user_id was found for task smoke test"
          );
        }

        const feishu = new FeishuClient(config.feishu);
        let taskGuid;
        try {
          const task = await feishu.createTask({
            summary: `Codex 诊断临时任务 ${Date.now()}`,
            description:
              "用于确认合同审核机器人是否有创建飞书任务和写入任务评论的权限。创建成功后会立即删除。",
            assigneeUserIds: [assigneeUserId],
            clientToken: `codex-task-smoke-${Date.now()}`,
            contractUrl: "https://open.feishu.cn"
          });
          taskGuid = task.taskGuid;
          await feishu.addTaskComment(
            taskGuid,
            "Codex 诊断：任务评论写入权限正常。本任务会被自动删除。"
          );
          setCheck("feishu_task_create_comment_delete", "pass", {
            assigneeUserId,
            createdTaskGuid: taskGuid,
            taskUrlPresent: Boolean(task.taskUrl),
            cleanup: "pending"
          });
        } finally {
          if (taskGuid) {
            await feishu.deleteTask(taskGuid)
              .then(() => {
                const current = result.checks.feishu_task_create_comment_delete;
                if (current?.status === "pass") current.cleanup = "deleted";
              })
              .catch((cleanupError) => {
                setCheck("feishu_task_cleanup", "fail", {
                  taskGuid,
                  message: describeDiagnosticError(cleanupError),
                  missingScopes: extractMissingScopes(cleanupError)
                });
              });
          }
        }
      });
    } else {
      setCheck("feishu_task_create_comment_delete", "skip", {
        message:
          "Set DIAGNOSE_TASK_SMOKE=1 to create, comment on, and delete a temporary Feishu task"
      });
    }

    if (config.documentArchive.enabled && process.env.DIAGNOSE_ARCHIVE_SMOKE === "1") {
      await safeCheck("feishu_archive_create_import_permission_delete", async () => {
        const feishu = new FeishuClient(config.feishu);
        let folderToken;
        let documentToken;

        try {
          const folder = await feishu.createFolder(
            `Codex 归档诊断临时文件夹 ${Date.now()}`,
            config.documentArchive.rootFolderToken
          );
          folderToken = folder.folderToken;

          const imported = await feishu.importFileAsDocx({
            fileName: "codex-archive-smoke.txt",
            fileExtension: "txt",
            data: Buffer.from("合同归档诊断测试。", "utf8"),
            folderToken,
            documentTitle: `Codex 归档诊断临时文档 ${Date.now()}`
          });
          documentToken = imported.documentToken;

          await feishu.setTenantEditable(documentToken, "docx");
          setCheck("feishu_archive_create_import_permission_delete", "pass", {
            folderTokenPresent: Boolean(folderToken),
            documentUrlPresent: Boolean(imported.documentUrl),
            cleanup: "pending"
          });
        } finally {
          const cleanup = [];
          if (documentToken) {
            await feishu.deleteDriveFile(documentToken, "docx")
              .then(() => cleanup.push("docx_deleted"))
              .catch((cleanupError) => {
                setCheck("feishu_archive_docx_cleanup", "fail", {
                  message: describeDiagnosticError(cleanupError),
                  missingScopes: extractMissingScopes(cleanupError)
                });
              });
          }
          if (folderToken) {
            await feishu.deleteDriveFile(folderToken, "folder")
              .then(() => cleanup.push("folder_deleted"))
              .catch((cleanupError) => {
                setCheck("feishu_archive_folder_cleanup", "fail", {
                  message: describeDiagnosticError(cleanupError),
                  missingScopes: extractMissingScopes(cleanupError)
                });
              });
          }

          const current = result.checks.feishu_archive_create_import_permission_delete;
          if (current?.status === "pass") current.cleanup = cleanup;
        }
      });
    } else {
      setCheck("feishu_archive_create_import_permission_delete", "skip", {
        message:
          "Set DIAGNOSE_ARCHIVE_SMOKE=1 to create a temporary folder, import a tiny document, set tenant-editable sharing, and delete the temporary files"
      });
    }

    const wikiNodeToken = process.env.DIAGNOSE_WIKI_NODE_TOKEN;
    if (wikiNodeToken) {
      let wikiObjType;
      let wikiObjToken;
      await safeCheck("feishu_wiki_scope", async () => {
        const response = await fetch(
          `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiNodeToken)}`,
          {
            headers: { Authorization: `Bearer ${tenantToken}` }
          }
        );
        const body = await response.json();
        if (body.code !== 0) throw new Error(`${body.code}: ${body.msg}`);
        wikiObjType = body.data?.node?.obj_type;
        wikiObjToken = body.data?.node?.obj_token;
        setCheck("feishu_wiki_scope", "pass", {
          title: body.data?.node?.title ?? null,
          objType: wikiObjType ?? null,
          hasObjToken: Boolean(wikiObjToken)
        });
      });

      if (wikiObjType === "docx" && wikiObjToken) {
        await checkDocxReadable("feishu_wiki_docx_raw_content", tenantToken, wikiObjToken);
      } else {
        setCheck("feishu_wiki_docx_raw_content", "skip", {
          message: "Wiki node did not resolve to a docx object"
        });
      }
    } else {
      setCheck("feishu_wiki_scope", "skip", {
        message: "Set DIAGNOSE_WIKI_NODE_TOKEN=<wiki token> to test wiki scope"
      });
      setCheck("feishu_wiki_docx_raw_content", "skip", {
        message: "Set DIAGNOSE_WIKI_NODE_TOKEN=<wiki token> to test wiki docx reading"
      });
    }

    const docxToken = process.env.DIAGNOSE_DOCX_TOKEN;
    if (docxToken) {
      await checkDocxReadable("feishu_docx_raw_content", tenantToken, docxToken);
    } else {
      setCheck("feishu_docx_raw_content", "skip", {
        message: "Set DIAGNOSE_DOCX_TOKEN=<docx token> to test direct docx reading"
      });
    }
  }

  if (process.env.DIAGNOSE_AI_SMOKE === "1") {
    await safeCheck("ai_endpoint_reachable", async () => {
      if (!config.claude.baseUrl) throw new Error("AI_BASE_URL is missing");
      if (!config.claude.model) throw new Error("AI_MODEL is missing");
      const apiKey = config.claude.apiKey ?? config.claude.authToken;
      if (!apiKey) throw new Error("AI_API_KEY is missing or still a placeholder");
      const response = await fetch(resolveChatCompletionUrl(config.claude.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.claude.model,
          temperature: 0,
          max_tokens: 20,
          messages: [{ role: "user", content: "Reply with exactly: ok" }]
        })
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      setCheck("ai_endpoint_reachable", "pass", {
        hasContent: Boolean(body?.choices?.[0]?.message?.content)
      });
    });
  } else {
    setCheck("ai_endpoint_reachable", "skip", {
      message: "Set DIAGNOSE_AI_SMOKE=1 after configuring a real AI key"
    });
  }

  console.log(JSON.stringify(result, null, 2));
}

async function getTenantAccessToken() {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config.feishu.appId,
        app_secret: config.feishu.appSecret
      })
    }
  );
  const body = await response.json();
  if (body.code !== 0) {
    setCheck("feishu_tenant_token", "fail", { code: body.code, message: body.msg });
    return undefined;
  }
  return body.tenant_access_token;
}

async function checkDocxReadable(name, tenantToken, docxToken) {
  await safeCheck(name, async () => {
    const metadataResponse = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(docxToken)}`,
      {
        headers: { Authorization: `Bearer ${tenantToken}` }
      }
    );
    const metadataBody = await metadataResponse.json();
    if (metadataBody.code !== 0) {
      throw new Error(`metadata ${metadataBody.code}: ${metadataBody.msg}`);
    }

    const contentResponse = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(docxToken)}/raw_content`,
      {
        headers: { Authorization: `Bearer ${tenantToken}` }
      }
    );
    const contentBody = await contentResponse.json();
    if (contentBody.code !== 0) {
      throw new Error(`raw_content ${contentBody.code}: ${contentBody.msg}`);
    }

    const content = String(
      contentBody.data?.content ?? contentBody.content ?? contentBody.data?.raw_content ?? ""
    );
    setCheck(name, "pass", {
      title: metadataBody.data?.document?.title ?? metadataBody.data?.title ?? null,
      revisionId:
        metadataBody.data?.document?.revision_id ?? metadataBody.data?.revision_id ?? null,
      textLength: content.length,
      hasText: content.trim().length > 0
    });
  });
}

function hasMention(item) {
  return Array.isArray(item?.mentions) && item.mentions.length > 0;
}

function summarizeMessage(item) {
  if (!item) return null;
  return {
    messageId: item.message_id ?? null,
    createTime: item.create_time ?? null,
    createTimeIso: Number.isFinite(Number(item.create_time))
      ? new Date(Number(item.create_time)).toISOString()
      : null,
    senderType: item.sender?.sender_type ?? null,
    msgType: item.msg_type ?? null,
    mentionCount: Array.isArray(item.mentions) ? item.mentions.length : 0,
    textPreview: readMessageText(item).slice(0, 160)
  };
}

function readMessageText(item) {
  const content = item?.body?.content;
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content);
    return String(parsed.text ?? parsed.title ?? content);
  } catch {
    return content;
  }
}

function readDisplayName(user) {
  return user?.cn_name || user?.name || user?.en_name || user?.nickname || undefined;
}

function findTaskSmokeAssigneeUserId() {
  const fromCc = config.reviewTestCc.userIds[0];
  if (fromCc) return fromCc;
  for (const owners of Object.values(config.owners)) {
    const owner = owners.find((item) => item.userId);
    if (owner?.userId) return owner.userId;
  }
  return undefined;
}

function describeDiagnosticError(error) {
  const data = extractFeishuErrorData(error);
  if (data) return describeFeishuError(error);
  return error instanceof Error ? error.message : String(error);
}

async function fetchPublic(url, options = {}) {
  try {
    return await fetch(url, options);
  } catch (fetchError) {
    if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY && !process.env.ALL_PROXY) {
      throw fetchError;
    }

    try {
      return await curlFetch(url, options);
    } catch (curlError) {
      throw new Error(
        `Node fetch failed (${errorDetail(fetchError)}); curl proxy fallback failed (${errorDetail(curlError)})`
      );
    }
  }
}

async function curlFetch(url, options) {
  const method = String(options.method ?? "GET").toUpperCase();
  const args = ["--fail-with-body", "--silent", "--show-error", "--max-time", "20"];
  if (method !== "GET") args.push("--request", method);
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    args.push("--header", `${name}: ${value}`);
  }
  const body = typeof options.body === "string" ? options.body : undefined;
  if (body !== undefined) args.push("--data-binary", "@-");
  args.push("--write-out", "\n%{http_code}", url);

  const executable = process.platform === "win32" ? "curl.exe" : "curl";
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr.trim() || `curl exited with code ${code}`));
    });
    child.stdin.end(body ?? "");
  });

  const splitAt = stdout.lastIndexOf("\n");
  if (splitAt < 0) throw new Error("curl response did not include an HTTP status");
  const responseBody = stdout.slice(0, splitAt);
  const status = Number(stdout.slice(splitAt + 1).trim());
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(responseBody);
    }
  };
}

function errorDetail(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    return `${error.message}: ${cause.code}`;
  }
  return error.message;
}

await main();
