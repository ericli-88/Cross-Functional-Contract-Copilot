import * as lark from "@larksuiteoapi/node-sdk";

import type { AppConfig } from "../config.js";
import { parseFeishuContentText } from "../chat/messageParsing.js";
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

export interface FeishuMessageRecord {
  messageId: string;
  parentMessageId?: string;
  rootMessageId?: string;
  messageType: string;
  text: string;
  fileKey?: string;
  fileName?: string;
  raw: unknown;
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

  async getMessage(messageId: string): Promise<FeishuMessageRecord> {
    const response = await this.client.request<FeishuResponse>({
      method: "GET",
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
    });
    const data = response.data?.data ?? response.data;
    const item = firstMessageItem(data);
    if (!item) {
      throw new Error(`Feishu get message response did not contain message ${messageId}`);
    }

    const parsed = parseMessageRecord(item, messageId);
    logger.info(
      {
        messageId: parsed.messageId,
        parentMessageId: parsed.parentMessageId,
        rootMessageId: parsed.rootMessageId,
        messageType: parsed.messageType,
        hasFile: Boolean(parsed.fileKey)
      },
      "read feishu message by message_id"
    );
    return parsed;
  }

  async downloadMessageFile(messageId: string, fileKey: string): Promise<Buffer> {
    const response = await this.client.request<FeishuResponse<Buffer | ArrayBuffer>>({
      method: "GET",
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      params: {
        type: "file"
      },
      responseType: "arraybuffer"
    } as never);
    const buffer =
      toBuffer(response) ??
      toBuffer((response as FeishuResponse<Buffer | ArrayBuffer>).data) ??
      toBuffer((response as FeishuResponse<Buffer | ArrayBuffer>).data?.data);
    if (!buffer) {
      throw new Error(`Feishu message resource response was not binary for ${messageId}`);
    }
    logger.info({ messageId, fileKey, byteLength: buffer.byteLength }, "downloaded feishu message file");
    return buffer;
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

function firstMessageItem(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  if (Array.isArray(data.items) && isRecord(data.items[0])) return data.items[0];
  if (isRecord(data.message)) return data.message;
  return data;
}

function parseMessageRecord(item: Record<string, unknown>, fallbackMessageId: string): FeishuMessageRecord {
  const body = isRecord(item.body) ? item.body : {};
  const rawContent = body.content ?? item.content;
  const messageType =
    readNonBlankString(item.msg_type) ??
    readNonBlankString(item.message_type) ??
    readNonBlankString(item.type) ??
    "unknown";
  const contentObject = parseContentObject(rawContent);

  return {
    messageId: readNonBlankString(item.message_id) ?? fallbackMessageId,
    parentMessageId: readNonBlankString(item.parent_id),
    rootMessageId: readNonBlankString(item.root_id),
    messageType,
    text: parseFeishuContentText(messageType, rawContent),
    fileKey: readNonBlankString(contentObject?.file_key),
    fileName:
      readNonBlankString(contentObject?.file_name) ??
      readNonBlankString(contentObject?.name) ??
      readNonBlankString(contentObject?.title),
    raw: item
  };
}

function parseContentObject(rawContent: unknown): Record<string, unknown> | undefined {
  if (isRecord(rawContent)) return rawContent;
  if (typeof rawContent !== "string") return undefined;
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isArrayBufferView(value: unknown): value is NodeJS.ArrayBufferView {
  return Boolean(value) && ArrayBuffer.isView(value);
}

function toBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (isArrayBufferView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}
