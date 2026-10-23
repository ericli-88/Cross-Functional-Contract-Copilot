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

export interface FeishuSentMessage {
  messageId?: string;
  raw: unknown;
}

export interface ImportedFeishuDocument {
  documentToken: string;
  documentUrl: string;
}

export interface FeishuTaskInfo {
  taskGuid: string;
  taskUrl?: string;
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

  async getChatName(chatId: string): Promise<string | undefined> {
    const response = await this.client.request<FeishuResponse>({
      method: "GET",
      url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`
    });
    const data = response.data?.data ?? response.data;
    const chat = isRecord(data) && isRecord(data.chat) ? data.chat : data;
    return isRecord(chat) ? readNonBlankString(chat.name) : undefined;
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

  async createFolder(name: string, parentFolderToken = ""): Promise<{
    folderToken: string;
    folderUrl?: string;
  }> {
    const response = await this.client.drive.file.createFolder({
      data: { name, folder_token: parentFolderToken }
    });
    assertFeishuSuccess(response, "create folder");
    const folderToken = response.data?.token;
    if (!folderToken) throw new Error("Feishu create folder response did not contain token");
    return { folderToken, folderUrl: response.data?.url };
  }

  async grantChatFolderFullAccess(folderToken: string, chatId: string): Promise<void> {
    const response = await this.client.drive.permissionMember.create({
      data: {
        member_type: "openchat",
        member_id: chatId,
        perm: "full_access",
        type: "chat"
      },
      params: { type: "folder", need_notification: false },
      path: { token: folderToken }
    });
    assertFeishuSuccess(response, "grant chat folder permission");
  }

  async setTenantEditable(documentToken: string, documentType: "docx" | "docs" = "docx"): Promise<void> {
    const response = await this.client.drive.permissionPublic.patch({
      data: { link_share_entity: "tenant_editable" },
      params: { type: documentType === "docs" ? "doc" : "docx" },
      path: { token: documentToken }
    });
    assertFeishuSuccess(response, "set document tenant editable");
  }

  async createDocumentShortcut(input: {
    documentToken: string;
    documentType: "docx" | "docs";
    parentFolderToken: string;
  }): Promise<void> {
    const response = await this.client.drive.file.createShortcut({
      data: {
        parent_token: input.parentFolderToken,
        refer_entity: {
          refer_token: input.documentToken,
          refer_type: input.documentType === "docs" ? "doc" : "docx"
        }
      },
      params: { user_id_type: "user_id" }
    });
    assertFeishuSuccess(response, "create document shortcut");
  }

  async importFileAsDocx(input: {
    fileName: string;
    fileExtension: string;
    data: Buffer;
    folderToken: string;
    documentTitle: string;
  }): Promise<ImportedFeishuDocument> {
    if (input.data.byteLength === 0) throw new Error("不能导入空文件");
    if (input.data.byteLength > 20 * 1024 * 1024) {
      throw new Error("当前合同附件超过 20 MB，无法通过飞书单次导入接口转换");
    }

    const upload = await this.client.drive.media.uploadAll({
      data: {
        file_name: input.fileName,
        parent_type: "ccm_import_open",
        parent_node: "",
        size: input.data.byteLength,
        extra: JSON.stringify({
          obj_type: "docx",
          file_extension: input.fileExtension
        }),
        file: input.data
      }
    });
    const fileToken = upload?.file_token;
    if (!fileToken) throw new Error("Feishu upload media response did not contain file_token");

    const created = await this.client.drive.importTask.create({
      data: {
        file_extension: input.fileExtension,
        file_token: fileToken,
        type: "docx",
        file_name: input.documentTitle,
        point: {
          mount_type: 1,
          mount_key: input.folderToken
        }
      }
    });
    assertFeishuSuccess(created, "create document import task");
    const ticket = created.data?.ticket;
    if (!ticket) throw new Error("Feishu import task response did not contain ticket");

    for (let attempt = 0; attempt < 45; attempt += 1) {
      if (attempt > 0) await delay(1000);
      const queried = await this.client.drive.importTask.get({ path: { ticket } });
      assertFeishuSuccess(queried, "query document import task");
      const result = queried.data?.result;
      if (result?.job_status === 2) {
        throw new Error(`飞书文档导入失败：${result.job_error_msg ?? "未知错误"}`);
      }
      if (result?.job_status === 0 && result.token && result.url) {
        return {
          documentToken: result.token,
          documentUrl: result.url
        };
      }
    }

    throw new Error("飞书文档导入等待超时，请稍后重新提交这份文件");
  }

  async deleteDriveFile(
    fileToken: string,
    type: "docx" | "file" | "folder" = "docx"
  ): Promise<void> {
    const response = await this.client.drive.file.delete({
      params: { type, async: false },
      path: { file_token: fileToken }
    });
    assertFeishuSuccess(response, "delete drive file");
  }

  async createDocumentVersion(input: {
    documentToken: string;
    name: string;
  }): Promise<string | undefined> {
    const response = await this.client.drive.fileVersion.create({
      data: { name: input.name, obj_type: "docx" },
      params: { user_id_type: "user_id" },
      path: { file_token: input.documentToken }
    });
    assertFeishuSuccess(response, "create document version");
    return response.data?.version;
  }

  async createTask(input: {
    summary: string;
    description: string;
    assigneeUserIds: string[];
    clientToken: string;
    contractUrl?: string;
  }): Promise<FeishuTaskInfo> {
    const data: {
      summary: string;
      description: string;
      members: Array<{ id: string; type: "user"; role: "assignee" }>;
      client_token: string;
      origin?: {
        platform_i18n_name: { zh_cn: string };
        href: { url: string; title: string };
      };
    } = {
      summary: input.summary,
      description: input.description,
      members: input.assigneeUserIds.map((userId) => ({
        id: userId,
        type: "user",
        role: "assignee"
      })),
      client_token: input.clientToken
    };
    if (input.contractUrl) {
      data.origin = {
        platform_i18n_name: { zh_cn: "合同审核群聊 Bot" },
        href: { url: input.contractUrl, title: "打开合同" }
      };
    }
    const response = await this.client.task.v2.task.create({
      data,
      params: { user_id_type: "user_id" }
    });
    assertFeishuSuccess(response, "create task");
    const taskGuid = response.data?.task?.guid;
    if (!taskGuid) throw new Error("Feishu create task response did not contain task guid");
    return { taskGuid, taskUrl: response.data?.task?.url };
  }

  async updateTask(input: {
    taskGuid: string;
    summary?: string;
    description?: string;
    completedAt?: string;
  }): Promise<void> {
    const updateFields: string[] = [];
    const task: { summary?: string; description?: string; completed_at?: string } = {};
    if (input.summary !== undefined) {
      updateFields.push("summary");
      task.summary = input.summary;
    }
    if (input.description !== undefined) {
      updateFields.push("description");
      task.description = input.description;
    }
    if (input.completedAt !== undefined) {
      updateFields.push("completed_at");
      task.completed_at = input.completedAt;
    }
    if (updateFields.length === 0) return;

    const response = await this.client.task.v2.task.patch({
      data: { task, update_fields: updateFields },
      params: { user_id_type: "user_id" },
      path: { task_guid: input.taskGuid }
    });
    assertFeishuSuccess(response, "update task");
  }

  async getTask(taskGuid: string): Promise<{
    completedAt?: string;
    taskUrl?: string;
  }> {
    const response = await this.client.task.v2.task.get({
      params: { user_id_type: "user_id" },
      path: { task_guid: taskGuid }
    });
    assertFeishuSuccess(response, "get task");
    return {
      completedAt: response.data?.task?.completed_at,
      taskUrl: response.data?.task?.url
    };
  }

  async deleteTask(taskGuid: string): Promise<void> {
    const response = await this.client.task.v2.task.delete({
      path: { task_guid: taskGuid }
    });
    assertFeishuSuccess(response, "delete task");
  }

  async addTaskComment(taskGuid: string, content: string): Promise<void> {
    const response = await this.client.task.v2.comment.create({
      data: {
        content,
        resource_type: "task",
        resource_id: taskGuid
      },
      params: { user_id_type: "user_id" }
    });
    assertFeishuSuccess(response, "create task comment");
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
  ): Promise<FeishuSentMessage> {
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
    return { messageId: extractMessageId(response), raw: response };
  }

  async sendInteractiveCardToChatId(
    chatId: string,
    card: FeishuInteractiveCard
  ): Promise<FeishuSentMessage> {
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
    return { messageId: extractMessageId(response), raw: response };
  }

  async updateInteractiveMessage(
    messageId: string,
    card: FeishuInteractiveCard
  ): Promise<void> {
    const response = await this.client.request({
      method: "PATCH",
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card)
      }
    });
    assertFeishuSuccess(response, "update interactive message");
    logger.info({ messageId }, "updated feishu interactive message");
  }
}

function assertFeishuSuccess(response: unknown, operation: string): void {
  if (!isRecord(response)) return;
  const code = response.code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(
      `Feishu ${operation} failed (${code}): ${readNonBlankString(response.msg) ?? "unknown error"}`
    );
  }
}

function extractMessageId(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const data = isRecord(response.data) ? response.data : undefined;
  const nested = data && isRecord(data.data) ? data.data : data;
  return nested ? readNonBlankString(nested.message_id) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
