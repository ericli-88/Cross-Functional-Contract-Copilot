import * as lark from "@larksuiteoapi/node-sdk";

import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import type { FeishuInteractiveCard } from "../review/reviewCard.js";
import { silentLarkLogger } from "./sdkLogger.js";

type FeishuConfig = AppConfig["feishu"];

interface FeishuResponse<T = unknown> {
  data?: {
    data?: T;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class FeishuClient {
  private readonly client: lark.Client;

  constructor(config: FeishuConfig) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      logger: silentLarkLogger,
      appType: lark.AppType.SelfBuild
    });
  }

  async getDocxMetadata(documentId: string): Promise<{ title?: string; revisionId?: number }> {
    const response = await this.client.request<FeishuResponse>({
      method: "GET",
      url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`
    });
    const data = response.data?.data ?? response.data;
    const document = isRecord(data) && isRecord(data.document) ? data.document : data;

    return {
      title: isRecord(document) ? readNonBlankString(document.title) : undefined,
      revisionId:
        isRecord(document) && typeof document.revision_id === "number"
          ? document.revision_id
          : undefined
    };
  }

  async getDocxRawContent(documentId: string): Promise<string> {
    const response = await this.client.request<FeishuResponse>({
      method: "GET",
      url: `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`
    });
    const data = response.data?.data ?? response.data;
    const content =
      readNonBlankString(isRecord(data) ? data.content : undefined) ??
      readNonBlankString(isRecord(data) ? data.raw_content : undefined) ??
      readNonBlankString(isRecord(data) ? data.text : undefined);

    if (!content) {
      throw new Error("Feishu docx raw content response did not contain text content");
    }

    return content;
  }

  async getDocsContent(documentToken: string): Promise<{ title?: string; content: string }> {
    const response = await this.client.request<FeishuResponse>({
      method: "GET",
      url: "/open-apis/docs/v1/content",
      params: {
        doc_token: documentToken
      }
    });
    const data = response.data?.data ?? response.data;
    const content =
      readNonBlankString(isRecord(data) ? data.content : undefined) ??
      readNonBlankString(isRecord(data) ? data.raw_content : undefined) ??
      readNonBlankString(isRecord(data) ? data.text : undefined);

    if (!content) {
      throw new Error("Feishu docs content response did not contain text content");
    }

    return {
      title: isRecord(data) ? readNonBlankString(data.title) : undefined,
      content
    };
  }

  async getWikiNodeInfo(nodeToken: string): Promise<{
    objType?: string;
    objToken?: string;
    title?: string;
  }> {
    const response = await this.client.request<FeishuResponse>({
      method: "GET",
      url: "/open-apis/wiki/v2/spaces/get_node",
      params: {
        token: nodeToken
      }
    });
    const data = response.data?.data ?? response.data;
    const node = isRecord(data) && isRecord(data.node) ? data.node : data;

    return {
      objType: isRecord(node) ? readNonBlankString(node.obj_type) : undefined,
      objToken: isRecord(node) ? readNonBlankString(node.obj_token) : undefined,
      title: isRecord(node) ? readNonBlankString(node.title) : undefined
    };
  }

  async getUserDisplayName(userId: string): Promise<string | undefined> {
    const response = await this.client.request<FeishuResponse>({
      method: "GET",
      url: `/open-apis/contact/v3/users/${encodeURIComponent(userId)}`,
      params: {
        user_id_type: "user_id"
      }
    });
    const data = response.data?.data ?? response.data;
    const user = isRecord(data) && isRecord(data.user) ? data.user : undefined;

    return user ? readDisplayName(user) : undefined;
  }

  async getChatMemberDisplayName(chatId: string, userId: string): Promise<string | undefined> {
    let pageToken: string | undefined;

    do {
      const response = await this.client.request<FeishuResponse>({
        method: "GET",
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`,
        params: {
          member_id_type: "user_id",
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {})
        }
      });
      const data = response.data?.data ?? response.data;
      const items = isRecord(data) && Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        if (!isRecord(item)) continue;
        if (readNonBlankString(item.member_id) !== userId) continue;
        return readNonBlankString(item.name);
      }
      pageToken = isRecord(data) ? readNonBlankString(data.page_token) : undefined;
    } while (pageToken);

    return undefined;
  }

  async sendTextToUserId(userId: string, text: string): Promise<unknown> {
    const response = await this.client.request({
      method: "POST",
      url: "/open-apis/im/v1/messages",
      params: {
        receive_id_type: "user_id"
      },
      data: {
        receive_id: userId,
        msg_type: "text",
        content: JSON.stringify({ text })
      }
    });
    logger.info({ userId, textLength: text.length }, "sent feishu text message to user_id");
    return response;
  }

  async sendTextToChatId(chatId: string, text: string): Promise<unknown> {
    const response = await this.client.request({
      method: "POST",
      url: "/open-apis/im/v1/messages",
      params: {
        receive_id_type: "chat_id"
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      }
    });
    logger.info({ chatId, textLength: text.length }, "sent feishu text message to chat_id");
    return response;
  }

  async sendInteractiveCardToUserId(
    userId: string,
    card: FeishuInteractiveCard
  ): Promise<unknown> {
    const response = await this.client.request({
      method: "POST",
      url: "/open-apis/im/v1/messages",
      params: {
        receive_id_type: "user_id"
      },
      data: {
        receive_id: userId,
        msg_type: "interactive",
        content: JSON.stringify(card)
      }
    });
    logger.info({ userId }, "sent feishu interactive card to user_id");
    return response;
  }

  async sendInteractiveCardToChatId(
    chatId: string,
    card: FeishuInteractiveCard
  ): Promise<unknown> {
    const response = await this.client.request({
      method: "POST",
      url: "/open-apis/im/v1/messages",
      params: {
        receive_id_type: "chat_id"
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card)
      }
    });
    logger.info({ chatId }, "sent feishu interactive card to chat_id");
    return response;
  }
}

function readDisplayName(record: Record<string, unknown>): string | undefined {
  return (
    readNonBlankString(record.cn_name) ??
    readNonBlankString(record.name) ??
    readNonBlankString(record.en_name) ??
    readNonBlankString(record.nickname)
  );
}
