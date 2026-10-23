import "dotenv/config";

import { loadConfig } from "../dist/src/config.js";
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
      message: error instanceof Error ? error.message : String(error)
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

  if (config.publicBaseUrl) {
    await safeCheck("public_healthz", async () => {
      const response = await fetch(`${config.publicBaseUrl}/healthz`);
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(`healthz returned HTTP ${response.status}`);
      }
      setCheck("public_healthz", "pass", { httpStatus: response.status });
    });

    await safeCheck("feishu_url_verification", async () => {
      const challenge = `diagnose_${Date.now()}`;
      const response = await fetch(`${config.publicBaseUrl}/feishu/events`, {
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
      setCheck("feishu_recent_group_messages", "pass", {
        count: items.length,
        latestUserAtMessage: summarizeMessage(
          items.find((item) => item.sender?.sender_type === "user" && hasMention(item))
        ),
        latestAppMessage: summarizeMessage(
          items.find((item) => item.sender?.sender_type === "app")
        )
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

await main();
