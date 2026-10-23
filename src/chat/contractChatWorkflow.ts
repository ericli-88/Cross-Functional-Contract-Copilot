import { createHash } from "node:crypto";

import type { AppConfig } from "../config.js";
import {
  roleKeys,
  roleLabels,
  type ChatContractReviewInput,
  type ChatMessageEvent,
  type ContractCaseRecord,
  type ContractText,
  type OwnerGroups,
  type RoleKey
} from "../domain/types.js";
import type { FeishuClient, FeishuMessageRecord } from "../feishu/feishuClient.js";
import {
  describeFeishuError,
  formatMissingScopeInstruction,
  isMissingScopeError
} from "../feishu/feishuErrors.js";
import { logger } from "../logger.js";
import {
  formatDetailedRoleCard,
  formatGeneralGroupCard,
  formatHelpText,
  formatNoChangeCard,
  formatRoleStatusCard
} from "../review/reviewCard.js";
import type { ContractReviewResult } from "../review/reviewSchema.js";
import { resolveReviewProfile } from "../review/reviewProfile.js";
import type { ContractCaseStore } from "./contractCaseStore.js";
import {
  extractContractTextFromAttachment,
  getContractAttachmentExtension,
  isSupportedContractAttachment
} from "./attachmentText.js";
import { DocumentArchive } from "./documentArchive.js";
import { extractFirstDocumentReference } from "./documentLinks.js";
import { parseChatIntent } from "./intentParser.js";
import {
  formatMissingOwnerMessage,
  isUserInRole,
  makeRegisteredOwner,
  resolveOwners,
  type OwnerDefaults
} from "./responsibleOwners.js";
import { TaskCoordinator } from "./taskCoordinator.js";

type ContractReviewer = {
  review(input: ChatContractReviewInput): Promise<ContractReviewResult>;
};

interface ResolvedDocumentReference {
  documentType: ContractCaseRecord["documentType"];
  documentToken: string;
  documentUrl: string;
  title?: string;
  contractText?: ContractText;
  attachmentData?: Buffer;
  attachmentFileName?: string;
  attachmentFileExtension?: string;
  sourceMessageId?: string;
  sourceKey?: string;
}

type ParsedChatIntent = ReturnType<typeof parseChatIntent>;
type ReviewDocumentIntent =
  | Extract<ParsedChatIntent, { kind: "initial_review" | "revision_done" }>
  | {
      kind: "initial_review" | "revision_done";
      documentUrl: string;
      documentToken: string;
      documentType: "file";
      attachmentContract?: ContractText;
      attachmentData?: Buffer;
      attachmentFileName: string;
      attachmentFileExtension: string;
      sourceKey: string;
      sourceMessageId: string;
    };
type DeleteContractRecordIntent = Extract<
  ParsedChatIntent,
  { kind: "delete_contract_record" }
>;

export interface ContractChatWorkflowOptions {
  contractChatId: string;
  botMentionName?: string;
  store: ContractCaseStore;
  feishu: FeishuClient;
  reviewer: ContractReviewer;
  ownerDefaults: OwnerDefaults;
  reviewTestCc?: {
    enabled: boolean;
    userIds: string[];
  };
  documentArchive?: DocumentArchive;
  taskCoordinator?: TaskCoordinator;
}

export class ContractChatWorkflow {
  private readonly reviewQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: ContractChatWorkflowOptions) {}

  async handleMessage(event: ChatMessageEvent): Promise<void> {
    if (
      this.options.contractChatId !== "*" &&
      event.chatId !== this.options.contractChatId
    ) {
      return;
    }
    if (!this.isMentionedOrCommandLike(event)) return;

    const eventStarted = await this.options.store.tryStartMessageEvent({
      eventId: event.eventId,
      messageId: event.messageId,
      chatId: event.chatId
    });
    if (!eventStarted) {
      logger.info(
        {
          eventId: event.eventId,
          messageId: event.messageId,
          chatId: event.chatId
        },
        "ignored duplicate feishu message event"
      );
      return;
    }

    try {
      await this.handleAcceptedMessage(event);
      await this.options.store.finishMessageEvent(event.eventId, "completed");
    } catch (error) {
      await this.options.store.finishMessageEvent(
        event.eventId,
        "failed",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  private async handleAcceptedMessage(event: ChatMessageEvent): Promise<void> {
    let intent: ParsedChatIntent | ReviewDocumentIntent = parseChatIntent(event.text);
    if (intent.kind === "ignore" && !extractFirstDocumentReference(event.text)) {
      const repliedIntent = await this.resolveReviewIntentFromRepliedMessage(event);
      if (repliedIntent) intent = repliedIntent;
    }
    logger.info(
      {
        eventId: event.eventId,
        chatId: event.chatId,
        intentKind: intent.kind,
        text: event.text
      },
      "parsed contract chat intent"
    );
    if (intent.kind === "ignore") return;

    if (intent.kind === "help") {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        formatHelpText(this.options.botMentionName)
      );
      return;
    }

    if (intent.kind === "register_owner") {
      await this.registerOwner(event, intent.roleKey);
      return;
    }

    if (intent.kind === "register_all_owners") {
      await this.registerAllOwners(event);
      return;
    }

    if (intent.kind === "whoami") {
      await this.replyIdentity(event);
      return;
    }

    if (intent.kind === "delete_contract_record") {
      await this.deleteContractRecord(event, intent);
      return;
    }

    if (intent.kind === "set_role_completion") {
      await this.setRoleCompletion(event, intent);
      return;
    }

    await this.reviewDocument(event, intent);
  }

  private isMentionedOrCommandLike(event: ChatMessageEvent): boolean {
    if (event.mentions.length === 0) return false;
    if (!this.options.botMentionName) return true;

    const expectedName = normalizeMentionName(this.options.botMentionName);
    const mentionMatchedByName = event.mentions.some((mention) => {
      const mentionName = mention.name ? normalizeMentionName(mention.name) : "";
      return mentionName === expectedName;
    });
    if (mentionMatchedByName) return true;

    const mentionMatchedByKey = event.mentions.some(
      (mention) => mention.key && event.text.includes(mention.key)
    );
    if (mentionMatchedByKey) {
      logger.warn(
        {
          eventId: event.eventId,
          expectedName: this.options.botMentionName,
          mentions: event.mentions
        },
        "accepting feishu mention event by mention key because mention name did not match"
      );
      return true;
    }

    const mentionNames = event.mentions
      .map((mention) => mention.name)
      .filter((name): name is string => Boolean(name));
    if (mentionNames.length === 0 && /@_user_\d+/u.test(event.text)) {
      logger.warn(
        {
          eventId: event.eventId,
          expectedName: this.options.botMentionName,
          mentions: event.mentions
        },
        "accepting feishu mention event without mention names"
      );
      return true;
    }

    logger.info(
      {
        eventId: event.eventId,
        expectedName: this.options.botMentionName,
        mentions: event.mentions
      },
      "ignored feishu message because mention name did not match configured bot name"
    );
    return false;
  }

  private async registerOwner(event: ChatMessageEvent, roleKey: RoleKey): Promise<void> {
    if (!event.senderUserId) {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        "没有从飞书消息事件里拿到发送人的 user_id，暂时无法注册负责人。"
      );
      return;
    }

    const displayName = await this.resolveSenderDisplayName(event);
    const owner = makeRegisteredOwner({
      roleKey,
      userId: event.senderUserId,
      displayName
    });
    await this.options.store.upsertOwner(owner);
    await this.options.feishu.sendTextToChatId(
      event.chatId,
      `已注册 ${owner.roleLabel} 负责人：${owner.displayName}（user_id 已保存）。`
    );
  }

  private async registerAllOwners(event: ChatMessageEvent): Promise<void> {
    if (!event.senderUserId) {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        "没有从飞书消息事件里拿到你的 user_id，暂时无法把负责人都设置成你。"
      );
      return;
    }

    const displayName = (await this.resolveSenderDisplayName(event)) ?? "测试用户";

    for (const roleKey of roleKeys) {
      await this.options.store.upsertOwner(
        makeRegisteredOwner({
          roleKey,
          userId: event.senderUserId,
          displayName
        })
      );
    }

    await this.options.feishu.sendTextToChatId(
      event.chatId,
      [
        `已进入测试模式：商务、运营、法务、财务四个负责人的私信收件人都设置为 ${displayName}。`,
        `你的 user_id：${event.senderUserId}`,
        "后续审查完成后，四份 detailed 建议都会私信给你。"
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    );
  }

  private async replyIdentity(event: ChatMessageEvent): Promise<void> {
    const mentions =
      event.mentions.length > 0
        ? event.mentions
            .map((mention, index) => {
              return [
                `${index + 1}. name=${mention.name ?? "(unknown)"}`,
                `key=${mention.key ?? "(none)"}`,
                `user_id=${mention.userId ?? "(none)"}`
              ].join(", ");
            })
            .join("\n")
        : "(没有 mentions)";

    await this.options.feishu.sendTextToChatId(
      event.chatId,
      [
        "当前飞书消息调试信息：",
        `chat_id：${event.chatId}`,
        `message_id：${event.messageId}`,
        `sender_user_id：${event.senderUserId ?? "(没有拿到)"}`,
        `sender_union_id：${event.senderUnionId ?? "(没有拿到)"}`,
        "",
        "本条消息的 @ 提及：",
        mentions,
        "",
        "如果你只是本地测试，可以直接发送：",
        `@${this.options.botMentionName ?? "合同机器人"} 我是全部负责人`
      ].join("\n")
    );
  }

  private async resolveReviewIntentFromRepliedMessage(
    event: ChatMessageEvent
  ): Promise<ReviewDocumentIntent | undefined> {
    const messageIds = [event.parentMessageId, event.rootMessageId].filter(
      (messageId): messageId is string => Boolean(messageId)
    );
    if (messageIds.length === 0) return undefined;

    const queue = [...new Set(messageIds)];
    const visited = new Set<string>();

    while (queue.length > 0 && visited.size < 8) {
      const messageId = queue.shift();
      if (!messageId || visited.has(messageId)) continue;
      visited.add(messageId);

      let message: FeishuMessageRecord;
      try {
        message = await this.options.feishu.getMessage(messageId);
      } catch (error) {
        logger.warn(
          { err: error, eventId: event.eventId, messageId },
          "failed to read replied feishu message"
        );
        continue;
      }

      const document = extractFirstDocumentReference(message.text);
      if (document) {
        logger.info(
          {
            eventId: event.eventId,
            repliedMessageId: message.messageId,
            documentType: document.type,
            documentToken: document.token
          },
          "resolved review document from replied message text"
        );
        return {
          kind: "initial_review",
          documentUrl: document.url,
          documentToken: document.token,
          documentType: document.type
        };
      }

      if (message.fileKey) {
        const fileName = message.fileName ?? `${message.fileKey}.bin`;
        if (!isSupportedContractAttachment(fileName)) {
          await this.options.feishu.sendTextToChatId(
            event.chatId,
            [
              "我已经识别到你回复的是一份文件，但当前不支持这种文件格式。",
              `文件名：${fileName}`,
              "支持格式：.doc、.docx、.pdf、.txt、.md、.markdown、.html。",
              "本次不会创建合同记录、版本、任务，也不会调用 AI。"
            ].join("\n")
          );
          return undefined;
        }

        let data: Buffer;
        try {
          data = await this.options.feishu.downloadMessageFile(
            message.messageId,
            message.fileKey
          );
        } catch (error) {
          logger.warn(
            {
              err: error,
              eventId: event.eventId,
              repliedMessageId: message.messageId,
              fileKey: message.fileKey,
              fileName
            },
            "failed to download or read replied feishu file attachment"
          );
          await this.options.feishu.sendTextToChatId(
            event.chatId,
            [
              "我已经识别到你回复的是一份合同文件，但暂时没能把文件内容读取出来，所以还没有开始审查。",
              "",
              `文件名：${fileName}`,
              `底层错误：${extractErrorMessage(error)}`,
              "",
              "你也可以直接把这份合同上传/转换成飞书在线文档，然后发送：",
              `@${this.options.botMentionName ?? "合同机器人"} https://xxx.feishu.cn/docx/xxxx`,
              "",
              "如果它本来就是受支持的文件，请稍后再试一次。"
            ].join("\n")
          );
          return undefined;
        }
        logger.info(
          {
            eventId: event.eventId,
            repliedMessageId: message.messageId,
            fileName,
            byteLength: data.byteLength
          },
          "resolved review document from replied file attachment"
        );
        return {
          kind: "initial_review",
          documentType: "file",
          documentToken: makeAttachmentDocumentToken(message.messageId, message.fileKey),
          documentUrl: formatAttachmentDocumentUrl(message.messageId, fileName),
          attachmentData: data,
          attachmentFileName: fileName,
          attachmentFileExtension: getContractAttachmentExtension(fileName),
          sourceKey: makeAttachmentSourceKey(event.chatId, fileName),
          sourceMessageId: message.messageId
        };
      }

      for (const nextMessageId of [message.parentMessageId, message.rootMessageId]) {
        if (nextMessageId && !visited.has(nextMessageId)) queue.push(nextMessageId);
      }
    }

    logger.info(
      {
        eventId: event.eventId,
        messageIds,
        visitedMessageCount: visited.size
      },
      "replied feishu message did not contain a supported contract document"
    );
    return undefined;
  }

  private async deleteContractRecord(
    event: ChatMessageEvent,
    intent: DeleteContractRecordIntent
  ): Promise<void> {
    let resolvedDocument: ResolvedDocumentReference;
    try {
      resolvedDocument = await this.resolveDocumentReference(intent);
    } catch (error) {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        [
          "我收到了删除合同记录的指令，但没能解析这个飞书文档链接。",
          "请确认链接是 /docx/、/docs/，或者应用已经开通 wiki 读取权限并发布。",
          "",
          `底层错误：${extractErrorMessage(error)}`
        ].join("\n")
      );
      return;
    }

    const deleted = await this.options.store.deleteByDocumentToken(
      resolvedDocument.documentType,
      resolvedDocument.documentToken,
      event.chatId
    );

    if (!deleted) {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        [
          "我没有找到这份合同的历史审查记录，所以没有删除任何内容。",
          "",
          `文档链接：${resolvedDocument.documentUrl}`,
          "如果你接下来再次 @ 我并附上这份文档链接，我会按当前记录状态判断是否首次审查。"
        ].join("\n")
      );
      return;
    }

    await this.options.feishu.sendTextToChatId(
      event.chatId,
      [
        "已删除这份合同在机器人本地保存的审查记录。",
        "",
        `合同编号：${deleted.contractId}`,
        `合同名称：${deleted.documentTitle}`,
        `已删除版本数：${deleted.versions.length}`,
        `文档链接：${deleted.documentUrl}`,
        "",
        "这不会删除飞书文档本身，也不会删除负责人 user_id 配置。",
        "如果你接下来再次 @ 我并附上这份文档链接，我会把它当作一份新出现的合同重新首审。"
      ].join("\n")
    );
  }

  private async reviewDocument(
    event: ChatMessageEvent,
    intent: ReviewDocumentIntent
  ): Promise<void> {
    const queueKey =
      intent.documentType === "file"
        ? `${event.chatId}:${intent.sourceKey}`
        : `${event.chatId}:${intent.documentType}:${intent.documentToken}`;
    await this.serializeReview(queueKey, () => this.reviewDocumentUnlocked(event, intent));
  }

  private async reviewDocumentUnlocked(
    event: ChatMessageEvent,
    intent: ReviewDocumentIntent
  ): Promise<void> {
    const workflowStartedAt = Date.now();
    let resolvedDocument: ResolvedDocumentReference;
    let metadata: { title?: string; revisionId?: number } = {};
    let rawText = "";
    let contractText: ContractText | undefined;
    let contract: ContractCaseRecord;
    const documentReadStartedAt = Date.now();
    try {
      resolvedDocument = await this.resolveDocumentReference(intent);

      if (resolvedDocument.documentType === "file") {
        const sourceKey = resolvedDocument.sourceKey ?? resolvedDocument.documentToken;
        const existing = await this.options.store.findBySourceKey(event.chatId, sourceKey);
        contract = existing ?? await this.options.store.createContract({
          chatId: event.chatId,
          documentType: "file",
          documentToken: sourceKey,
          documentUrl: resolvedDocument.documentUrl,
          documentTitle: resolvedDocument.title ?? "合同附件",
          createdByUserId: event.senderUserId
        });
        contract = await this.options.store.addContractSource({
          contractId: contract.contractId,
          sourceKey,
          sourceMessageId: resolvedDocument.sourceMessageId
        });

        if (resolvedDocument.attachmentData) {
          contractText = await extractContractTextFromAttachment({
            fileName: resolvedDocument.attachmentFileName ?? "contract.docx",
            data: resolvedDocument.attachmentData
          });
          metadata = { title: resolvedDocument.title };
          rawText = contractText.text;
        } else if (resolvedDocument.contractText) {
          contractText = resolvedDocument.contractText;
          metadata = { title: resolvedDocument.title };
          rawText = contractText.text;
        } else {
          throw new Error("没有拿到可读取的合同附件内容");
        }
      } else if (resolvedDocument.documentType === "docx") {
        metadata = await this.options.feishu
          .getDocxMetadata(resolvedDocument.documentToken)
          .catch((error) => {
            logger.warn(
              { err: error, documentToken: resolvedDocument.documentToken },
              "failed to read feishu document metadata"
            );
            return {};
          });
        rawText = await this.options.feishu.getDocxRawContent(resolvedDocument.documentToken);
        const documentTitle = metadata.title ?? resolvedDocument.title ?? `飞书文档 ${resolvedDocument.documentToken}`;
        contract =
          (await this.options.store.findByDocumentTokenInChat(
            event.chatId,
            resolvedDocument.documentType,
            resolvedDocument.documentToken
          )) ??
          (await this.options.store.createContract({
            chatId: event.chatId,
            documentType: resolvedDocument.documentType,
            documentToken: resolvedDocument.documentToken,
            documentUrl: resolvedDocument.documentUrl,
            documentTitle,
            createdByUserId: event.senderUserId
          }));
      } else {
        const docsContent = await this.options.feishu.getDocsContent(
          resolvedDocument.documentToken
        );
        metadata = { title: docsContent.title };
        rawText = docsContent.content;
        const documentTitle = metadata.title ?? resolvedDocument.title ?? `飞书文档 ${resolvedDocument.documentToken}`;
        contract =
          (await this.options.store.findByDocumentTokenInChat(
            event.chatId,
            resolvedDocument.documentType,
            resolvedDocument.documentToken
          )) ??
          (await this.options.store.createContract({
            chatId: event.chatId,
            documentType: resolvedDocument.documentType,
            documentToken: resolvedDocument.documentToken,
            documentUrl: resolvedDocument.documentUrl,
            documentTitle,
            createdByUserId: event.senderUserId
          }));
      }
    } catch (error) {
      logger.warn(
        {
          err: error,
          documentType: intent.documentType,
          documentToken: intent.documentToken
        },
        "failed to resolve or read feishu document"
      );
      const message =
        intent.documentType === "file"
          ? formatAttachmentImportFailureMessage(error)
          : formatDocumentReadFailureMessage(intent, error);
      await this.options.feishu.sendTextToChatId(event.chatId, message);
      return;
    }
    logger.info(
      {
        eventId: event.eventId,
        documentType: resolvedDocument.documentType,
        documentToken: resolvedDocument.documentToken,
        rawTextLength: rawText.length,
        durationMs: Date.now() - documentReadStartedAt
      },
      "contract document read completed"
    );

    if (this.options.documentArchive?.enabled) {
      await this.options.documentArchive.ensureChatWorkspace(event.chatId).catch((error) => {
        logger.warn(
          { err: error, eventId: event.eventId, chatId: event.chatId },
          "failed to ensure chat contract folder; continuing review"
        );
      });
    }

    const triggeredByName = await this.resolveTriggerDisplayName(event);
    const documentTitle = contract.documentTitle;
    contractText ??= normalizeContractText(
      rawText,
      documentTitle,
      resolvedDocument.documentType
    );
    const contentHash = hashText(contractText.text);

    const latestCompletedVersion = findLatestCompletedVersion(contract);
    const latestUsableCompletedVersion = findLatestUsableCompletedVersion(contract);
    const effectiveIntentKind: "initial_review" | "revision_done" = latestCompletedVersion
      ? "revision_done"
      : "initial_review";
    const reviewKindLabel =
      effectiveIntentKind === "revision_done" ? "修改完毕后复审" : "首次审查";

    if (latestUsableCompletedVersion?.contentHash === contentHash) {
      await this.options.feishu.sendInteractiveCardToChatId(
        event.chatId,
        formatNoChangeCard({
          contract,
          currentVersion: latestUsableCompletedVersion.version,
          triggeredByName,
          reviewKindLabel
        })
      );
      logger.info(
        {
          eventId: event.eventId,
          contractId: contract.contractId,
          version: latestUsableCompletedVersion.version,
          textLength: contractText.text.length,
          durationMs: Date.now() - workflowStartedAt
        },
        "contract review skipped because content did not change"
      );
      return;
    }

    const latestVersionRecord = contract.versions.at(-1);
    const shouldRetryFailedVersion =
      latestVersionRecord?.status === "failed" &&
      latestVersionRecord.contentHash === contentHash &&
      !hasAnyRoleResults(latestVersionRecord.roleResults);
    const versionNumber = shouldRetryFailedVersion
      ? latestVersionRecord.version
      : contract.latestVersion + 1;
    let feishuVersionId: string | undefined;

    if (
      this.options.documentArchive?.enabled &&
      (resolvedDocument.documentType === "docx" || resolvedDocument.documentType === "docs")
    ) {
      try {
        const archived = await this.options.documentArchive.prepareLinkedDocument({
          contract,
          documentType: resolvedDocument.documentType,
          documentToken: resolvedDocument.documentToken,
          version: versionNumber
        });
        contract = archived.contract;
        feishuVersionId = archived.feishuVersionId;
      } catch (error) {
        logger.error(
          { err: error, contractId: contract.contractId, version: versionNumber },
          "failed to archive linked contract document"
        );
        await this.options.feishu.sendTextToChatId(
          event.chatId,
          formatArchiveFailureStopMessage(error)
        );
        return;
      }
    }

    const currentDocumentToken = resolvedDocument.documentToken;
    const currentDocumentUrl = resolvedDocument.documentUrl;
    const versionInput = {
      version: versionNumber,
      status: "started" as const,
      intent: effectiveIntentKind,
      contentHash,
      textLength: contractText.text.length,
      triggeredByUserId: event.senderUserId,
      triggeredByName,
      messageId: event.messageId,
      createdAt: new Date().toISOString(),
      documentToken: currentDocumentToken,
      documentUrl: currentDocumentUrl,
      documentTitle,
      feishuVersionId,
      sourceMessageId: resolvedDocument.sourceMessageId,
      error: undefined
    };
    contract = shouldRetryFailedVersion
      ? await this.options.store.updateVersion(contract.contractId, versionNumber, versionInput)
      : await this.options.store.appendVersion(contract.contractId, versionInput);

    const activeRoleKeys = getActiveRoleKeys(contract);
    const activeRoleText = activeRoleKeys.map((roleKey) => roleLabels[roleKey]).join("、");
    await this.options.feishu.sendTextToChatId(
      event.chatId,
      [
        `已开始审查：${contract.documentTitle}`,
        `合同编号：${contract.contractId}`,
        `版本：V${versionNumber}`,
        activeRoleKeys.length > 0
          ? `机器人正在分别生成${activeRoleText}建议。已完成的职能不会再收到任务或私信提醒。`
          : "所有职能均已确认完成；机器人会记录本次版本，但不会再给负责人发送任务或私信提醒。"
      ].join("\n")
    );

    const owners = await resolveOwners(this.options.store, this.options.ownerDefaults);
    let roleResults: Record<RoleKey, ContractReviewResult>;

    try {
      roleResults = await this.reviewForAllRoles({
        contract,
        version: versionNumber,
        contractText,
        triggeredByName
      });

      contract = await this.options.store.updateVersion(contract.contractId, versionNumber, {
        status: "completed",
        completedAt: new Date().toISOString(),
        roleResults
      });
    } catch (error) {
      await this.options.store.updateVersion(contract.contractId, versionNumber, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        [
          `合同 ${contract.contractId} V${versionNumber} 审查失败。`,
          formatPublicReviewFailureMessage(error)
        ].join("\n")
      );
      throw error;
    }

    const taskSync = await this.options.taskCoordinator?.syncReviewVersion({
      contract,
      version: versionNumber,
      owners,
      results: roleResults,
      triggeredByName,
      reviewKindLabel
    });
    if (taskSync) contract = taskSync.contract;

    const deliveryFailures = await this.deliverReviewCards({
      chatId: event.chatId,
      contract,
      version: versionNumber,
      owners,
      roleResults,
      triggeredByName,
      reviewKindLabel,
      taskFailedRoleKeys: taskSync?.failedRoleKeys ?? []
    });
    if (taskSync?.failures.length) deliveryFailures.push(...taskSync.failures);
    if (deliveryFailures.length > 0) {
      const failureSummary = formatPostReviewFailureSummary(deliveryFailures);
      logger.error(
        {
          eventId: event.eventId,
          contractId: contract.contractId,
          version: versionNumber,
          deliveryFailures
        },
        "contract review completed but card delivery had failures"
      );
      await this.options.feishu
        .sendTextToChatId(
          event.chatId,
          [
            `合同 ${contract.contractId} V${versionNumber} 审查结果已生成。`,
            failureSummary
          ].join("\n")
        )
        .catch((notifyError) => {
          logger.warn(
            {
              err: notifyError,
              eventId: event.eventId,
              contractId: contract.contractId,
              version: versionNumber
            },
            "failed to send card delivery warning to chat"
          );
        });
    }

    logger.info(
      {
        eventId: event.eventId,
        contractId: contract.contractId,
        version: versionNumber,
        textLength: contractText.text.length,
        deliveryFailureCount: deliveryFailures.length,
        durationMs: Date.now() - workflowStartedAt
      },
      "contract review workflow completed"
    );
  }

  private async deliverReviewCards(input: {
    chatId: string;
    contract: ContractCaseRecord;
    version: number;
    owners: OwnerGroups;
    roleResults: Record<RoleKey, ContractReviewResult>;
    triggeredByName: string;
    reviewKindLabel: string;
    taskFailedRoleKeys: RoleKey[];
  }): Promise<string[]> {
    const failures: string[] = [];

    try {
      const sent = await this.options.feishu.sendInteractiveCardToChatId(
        input.chatId,
        formatGeneralGroupCard({
          contract: input.contract,
          version: input.version,
          owners: input.owners,
          results: input.roleResults,
          triggeredByName: input.triggeredByName,
          reviewKindLabel: input.reviewKindLabel,
          missingOwnerMessage: formatMissingOwnerMessage(
            input.owners,
            this.options.botMentionName
          )
        })
      );
      if (sent.messageId) {
        input.contract = await this.options.store.updateContract(
          input.contract.contractId,
          { latestGroupCardMessageId: sent.messageId }
        );
      }
    } catch (error) {
      failures.push(`group_card: ${error instanceof Error ? error.message : String(error)}`);
    }

    failures.push(
      ...(await this.sendPrivateRoleCards(
        input.contract,
        input.version,
        input.owners,
        input.roleResults,
        input.triggeredByName,
        input.reviewKindLabel,
        new Set(input.taskFailedRoleKeys)
      ))
    );

    return failures;
  }

  private async reviewForAllRoles(input: {
    contract: ContractCaseRecord;
    version: number;
    contractText: ContractText;
    triggeredByName?: string;
  }): Promise<Record<RoleKey, ContractReviewResult>> {
    const startedAt = Date.now();
    const results: Partial<Record<RoleKey, ContractReviewResult>> = {};
    const failedRoleKeys: RoleKey[] = [];
    const roleConcurrency = 2;

    for (let start = 0; start < roleKeys.length; start += roleConcurrency) {
      const roleBatch = roleKeys.slice(start, start + roleConcurrency);
      const settledResults = await Promise.allSettled(
        roleBatch.map((roleKey) => this.reviewOneRole(input, roleKey, "primary"))
      );

      for (let index = 0; index < settledResults.length; index += 1) {
        const roleKey = roleBatch[index];
        const settledResult = settledResults[index];
        if (!roleKey || !settledResult) continue;
        if (settledResult.status === "fulfilled") {
          const [completedRoleKey, result] = settledResult.value;
          results[completedRoleKey] = result;
        } else {
          if (isNonRetriableAiServiceError(settledResult.reason)) {
            logger.error(
              {
                err: settledResult.reason,
                contractId: input.contract.contractId,
                version: input.version,
                roleKey
              },
              "contract role review failed with non-retriable AI service error"
            );
            throw settledResult.reason;
          }
          failedRoleKeys.push(roleKey);
          logger.warn(
            {
              err: settledResult.reason,
              contractId: input.contract.contractId,
              version: input.version,
              roleKey
            },
            "contract role review failed in primary pass; will retry once"
          );
        }
      }
    }

    for (const roleKey of failedRoleKeys) {
      const [completedRoleKey, result] = await this.reviewOneRole(input, roleKey, "retry");
      results[completedRoleKey] = result;
    }

    logger.info(
      {
        contractId: input.contract.contractId,
        version: input.version,
        roleCount: roleKeys.length,
        durationMs: Date.now() - startedAt
      },
      "contract role reviews completed"
    );

    return results as Record<RoleKey, ContractReviewResult>;
  }

  private async reviewOneRole(
    input: {
      contract: ContractCaseRecord;
      version: number;
      contractText: ContractText;
      triggeredByName?: string;
    },
    roleKey: RoleKey,
    attempt: "primary" | "retry"
  ): Promise<readonly [RoleKey, ContractReviewResult]> {
    const roleStartedAt = Date.now();
    logger.info(
      {
        contractId: input.contract.contractId,
        version: input.version,
        roleKey,
        attempt,
        textLength: input.contractText.text.length
      },
      "contract role review started"
    );
    const profile = resolveReviewProfile(roleKey);
    const result = await this.options.reviewer.review({
      contractId: input.contract.contractId,
      version: input.version,
      documentTitle: input.contract.documentTitle,
      documentUrl: input.contract.documentUrl,
      documentToken: input.contract.documentToken,
      triggeredByName: input.triggeredByName,
      contract: input.contractText,
      reviewProfile: profile
    });
    logger.info(
      {
        contractId: input.contract.contractId,
        version: input.version,
        roleKey,
        attempt,
        riskLevel: result.risk_level,
        suggestion: result.suggestion,
        durationMs: Date.now() - roleStartedAt
      },
      "contract role review completed"
    );
    return [roleKey, result] as const;
  }

  private async sendPrivateRoleCards(
    contract: ContractCaseRecord,
    version: number,
    owners: OwnerGroups,
    results: Record<RoleKey, ContractReviewResult>,
    triggeredByName: string,
    reviewKindLabel: string,
    taskFailedRoleKeys: ReadonlySet<RoleKey>
  ): Promise<string[]> {
    const failures: string[] = [];
    const roleResults = await Promise.all(
      roleKeys.map(async (roleKey) => {
        const roleOwners = owners[roleKey];
        const recipientUserIds = new Set<string>();
        const roleCompleted = contract.roleStatuses?.[roleKey]?.status === "completed";
        if (roleCompleted) return [];
        const shouldSendActualOwners =
          !this.options.taskCoordinator?.enabled ||
            version === 1 ||
            !contract.roleTasks?.[roleKey] ||
            taskFailedRoleKeys.has(roleKey);
        if (shouldSendActualOwners) {
          for (const owner of roleOwners) {
            if (owner.userId) recipientUserIds.add(owner.userId);
          }
        }
        if (this.options.reviewTestCc?.enabled) {
          for (const userId of this.options.reviewTestCc.userIds) {
            recipientUserIds.add(userId);
          }
        }
        if (recipientUserIds.size === 0) return [];

        const card = formatDetailedRoleCard({
          contract,
          version,
          roleKey,
          owners: roleOwners,
          result: results[roleKey],
          triggeredByName,
          reviewKindLabel,
          taskUrl: contract.roleTasks?.[roleKey]?.taskUrl
        });

        const sends = await Promise.allSettled(
          [...recipientUserIds].map(async (userId) => {
            await this.options.feishu.sendInteractiveCardToUserId(userId, card);
            return userId;
          })
        );
        return sends.flatMap((result, index) => {
          if (result.status === "fulfilled") return [];
          const userId = [...recipientUserIds][index] ?? "unknown";
          return [
            `${roleLabels[roleKey]}私信（user_id=${userId}）：${extractErrorMessage(result.reason)}`
          ];
        });
      })
    );
    for (const roleFailureList of roleResults) failures.push(...roleFailureList);
    return failures;
  }

  private async setRoleCompletion(
    event: ChatMessageEvent,
    intent: Extract<ParsedChatIntent, { kind: "set_role_completion" }>
  ): Promise<void> {
    if (!event.senderUserId) {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        "没有从飞书事件中取得你的 user_id，暂时不能确认部门处理状态。"
      );
      return;
    }

    let contract = intent.contractId
      ? await this.options.store.findByContractId(event.chatId, intent.contractId)
      : undefined;
    if (!contract && intent.documentToken && intent.documentType) {
      contract = await this.findContractByCompletionDocument(event.chatId, {
        documentType: intent.documentType,
        documentToken: intent.documentToken,
        documentUrl: intent.documentUrl ?? ""
      }).catch((error) => {
        logger.warn(
          { err: error, eventId: event.eventId, documentType: intent.documentType },
          "failed to resolve role completion contract from explicit document link"
        );
        return undefined;
      });
    }
    if (!contract) {
      contract = await this.findContractFromRepliedDocument(event);
    }
    if (!contract) {
      for (const messageId of [event.parentMessageId, event.rootMessageId]) {
        if (!messageId) continue;
        contract = await this.options.store.findByRelatedMessageId(event.chatId, messageId);
        if (contract) break;
      }
    }
    if (!contract) {
      const contracts = await this.options.store.listContractsInChat(event.chatId);
      if (contracts.length === 1) contract = contracts[0];
    }

    if (!contract) {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        "没有找到要更新状态的合同。请回复该合同的群卡片，或者在指令中写明合同编号，例如：@机器人 HT-20260812-0001 财务已完成。"
      );
      return;
    }

    const owners = await resolveOwners(this.options.store, this.options.ownerDefaults);
    let roleKey = intent.roleKey;
    if (!roleKey) {
      const matchingRoles = roleKeys.filter((candidate) =>
        isUserInRole(owners, candidate, event.senderUserId as string)
      );
      if (matchingRoles.length === 1) roleKey = matchingRoles[0];
      else {
        await this.options.feishu.sendTextToChatId(
          event.chatId,
          "请在指令里写明部门，例如：@机器人 财务已完成。因为你可能属于多个职能，机器人不会替你猜。"
        );
        return;
      }
    }

    const senderIsAnyOwner = roleKeys.some((candidate) =>
      isUserInRole(owners, candidate, event.senderUserId as string)
    );
    if (!senderIsAnyOwner) {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        "只有代码中已配置的负责人可以确认或恢复部门状态。你的 user_id 不在任何职能负责人列表中。"
      );
      return;
    }

    const currentStatus = contract.roleStatuses?.[roleKey]?.status ?? "active";
    const targetStatus = intent.completed ? "completed" : "active";
    if (currentStatus === targetStatus) {
      await this.options.feishu.sendTextToChatId(
        event.chatId,
        `${contract.contractId} 的${roleLabels[roleKey]}当前已经是“${intent.completed ? "已确认完成" : "处理中"}”，无需重复操作。`
      );
      return;
    }

    const actorName = await this.resolveTriggerDisplayName(event);
    contract = this.options.taskCoordinator
      ? await this.options.taskCoordinator.setRoleCompletion({
          contract,
          roleKey,
          completed: intent.completed,
          actorUserId: event.senderUserId,
          actorName
        })
      : await this.options.store.setRoleStatus(contract.contractId, roleKey, {
          status: targetStatus,
          ...(intent.completed
            ? {
                completedAt: new Date().toISOString(),
                completedByUserId: event.senderUserId,
                completedByName: actorName,
                completedAtVersion: contract.latestVersion
              }
            : {})
        });

    const statusCard = formatRoleStatusCard({
      contract,
      roleKey,
      completed: intent.completed,
      actorName
    });
    await this.options.feishu.sendInteractiveCardToChatId(event.chatId, statusCard);

    const latest = findLatestUsableCompletedVersion(contract);
    if (contract.latestGroupCardMessageId && latest && hasCompleteUsableRoleResults(latest.roleResults)) {
      const latestResults = latest.roleResults as Record<RoleKey, ContractReviewResult>;
      const latestCard = formatGeneralGroupCard({
        contract,
        version: latest.version,
        owners,
        results: latestResults,
        triggeredByName: latest.triggeredByName ?? "未知提交人",
        reviewKindLabel: latest.intent === "revision_done" ? "修改完毕后复审" : "首次审查",
        missingOwnerMessage: formatMissingOwnerMessage(owners, this.options.botMentionName)
      });
      await this.options.feishu
        .updateInteractiveMessage(contract.latestGroupCardMessageId, latestCard)
        .catch((error) => {
          logger.warn(
            {
              err: error,
              contractId: contract?.contractId,
              messageId: contract?.latestGroupCardMessageId
            },
            "could not update latest group card after role status change"
          );
        });
    }
  }

  private async findContractByCompletionDocument(
    chatId: string,
    document: { documentType: "docx" | "docs" | "wiki"; documentToken: string; documentUrl: string }
  ): Promise<ContractCaseRecord | undefined> {
    const resolved = await this.resolveDocumentReference({
      kind: "initial_review",
      documentType: document.documentType,
      documentToken: document.documentToken,
      documentUrl: document.documentUrl
    });
    return this.options.store.findByDocumentTokenInChat(
      chatId,
      resolved.documentType,
      resolved.documentToken
    );
  }

  private async findContractFromRepliedDocument(
    event: ChatMessageEvent
  ): Promise<ContractCaseRecord | undefined> {
    const messageIds = [event.parentMessageId, event.rootMessageId].filter(
      (messageId): messageId is string => Boolean(messageId)
    );
    const queue = [...new Set(messageIds)];
    const visited = new Set<string>();

    while (queue.length > 0 && visited.size < 8) {
      const messageId = queue.shift();
      if (!messageId || visited.has(messageId)) continue;
      visited.add(messageId);

      let message: FeishuMessageRecord;
      try {
        message = await this.options.feishu.getMessage(messageId);
      } catch (error) {
        logger.warn(
          { err: error, eventId: event.eventId, messageId },
          "failed to read replied message while resolving role completion contract"
        );
        continue;
      }

      const document = extractFirstDocumentReference(message.text);
      if (document) {
        const contract = await this.findContractByCompletionDocument(event.chatId, {
          documentType: document.type,
          documentToken: document.token,
          documentUrl: document.url
        });
        if (contract) return contract;
      }

      if (message.fileKey && message.fileName) {
        const sourceKey = makeAttachmentSourceKey(event.chatId, message.fileName);
        const contract = await this.options.store.findBySourceKey(event.chatId, sourceKey);
        if (contract) return contract;
      }

      for (const nextMessageId of [message.parentMessageId, message.rootMessageId]) {
        if (nextMessageId && !visited.has(nextMessageId)) queue.push(nextMessageId);
      }
    }

    return undefined;
  }

  private async resolveTriggerDisplayName(event: ChatMessageEvent): Promise<string> {
    if (event.senderUserId) {
      const displayName = await this.resolveSenderDisplayName(event);
      return displayName ?? `user_id:${event.senderUserId}`;
    }
    if (event.senderUnionId) return `union_id:${event.senderUnionId}`;
    return "未知触发人";
  }

  private async resolveSenderDisplayName(event: ChatMessageEvent): Promise<string | undefined> {
    if (!event.senderUserId) return undefined;

    return (
      (await this.options.feishu
        .getUserDisplayName(event.senderUserId)
        .catch(() => undefined)) ??
      (await this.options.feishu
        .getChatMemberDisplayName(event.chatId, event.senderUserId)
        .catch(() => undefined))
    );
  }

  private async serializeReview<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.reviewQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.reviewQueues.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.reviewQueues.get(key) === current) this.reviewQueues.delete(key);
    }
  }

  private async resolveDocumentReference(
    intent: ReviewDocumentIntent | DeleteContractRecordIntent
  ): Promise<ResolvedDocumentReference> {
    if (intent.documentType === "file") {
      return {
        documentType: "file",
        documentToken: intent.documentToken,
        documentUrl: intent.documentUrl,
        title: intent.attachmentFileName,
        contractText: intent.attachmentContract,
        attachmentData: intent.attachmentData,
        attachmentFileName: intent.attachmentFileName,
        attachmentFileExtension: intent.attachmentFileExtension,
        sourceMessageId: intent.sourceMessageId,
        sourceKey: intent.sourceKey
      };
    }

    if (intent.documentType === "docx" || intent.documentType === "docs") {
      return {
        documentType: intent.documentType,
        documentToken: intent.documentToken,
        documentUrl: intent.documentUrl
      };
    }

    const node = await this.options.feishu.getWikiNodeInfo(intent.documentToken);
    const objType = node.objType?.toLowerCase();
    if (!node.objToken || !objType) {
      throw new Error("Feishu wiki node response did not contain obj_type or obj_token");
    }

    return {
      documentType: objType === "docx" ? "docx" : "docs",
      documentToken: node.objToken,
      documentUrl: intent.documentUrl,
      title: node.title
    };
  }
}

function normalizeContractText(
  rawText: string,
  documentTitle: string,
  documentType: ContractCaseRecord["documentType"]
): ContractText {
  const maxCharacters = 300_000;
  const trimmed = rawText.trim();
  const source =
    documentType === "docx"
      ? "Read from Feishu docx raw_content API"
      : documentType === "docs"
        ? "Read from Feishu docs content API"
        : "Read from replied Feishu file attachment";
  const suffix =
    documentType === "docx"
      ? "feishu-docx"
      : documentType === "docs"
        ? "feishu-docs"
        : "feishu-file";
  if (trimmed.length <= maxCharacters) {
    return {
      fileName: `${documentTitle}.${suffix}.txt`,
      text: trimmed,
      extractionWarnings: [source]
    };
  }

  return {
    fileName: `${documentTitle}.${suffix}.txt`,
    text: trimmed.slice(0, maxCharacters),
    extractionWarnings: [
      source,
      `Document text was truncated to ${maxCharacters} characters before AI review`
    ]
  };
}

function makeAttachmentDocumentToken(messageId: string, fileKey: string): string {
  return `file:${messageId}:${fileKey}`;
}

function makeAttachmentSourceKey(chatId: string, fileName: string): string {
  const normalizedName = fileName
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.(docx?|txt|md|markdown|html?)$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return `attachment:${chatId}:${normalizedName || fileName.toLowerCase()}`;
}

function formatAttachmentDocumentUrl(messageId: string, fileName: string): string {
  return `Feishu file attachment: ${fileName} (message_id: ${messageId})`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function findLatestCompletedVersion(
  contract: ContractCaseRecord
): ContractCaseRecord["versions"][number] | undefined {
  return contract.versions
    .slice()
    .reverse()
    .find(
      (version) =>
        version.status === "completed" || hasCompleteUsableRoleResults(version.roleResults)
    );
}

function findLatestUsableCompletedVersion(
  contract: ContractCaseRecord
): ContractCaseRecord["versions"][number] | undefined {
  return contract.versions
    .slice()
    .reverse()
    .find((version) => hasCompleteUsableRoleResults(version.roleResults));
}

function hasCompleteUsableRoleResults(roleResults: unknown): boolean {
  if (!roleResults || typeof roleResults !== "object" || Array.isArray(roleResults)) {
    return false;
  }

  const record = roleResults as Partial<Record<RoleKey, unknown>>;
  return roleKeys.every((roleKey) => isUsableReviewResult(record[roleKey]));
}

function getActiveRoleKeys(contract: ContractCaseRecord): RoleKey[] {
  return roleKeys.filter((roleKey) => contract.roleStatuses?.[roleKey]?.status !== "completed");
}

function hasAnyRoleResults(roleResults: unknown): boolean {
  return Boolean(
    roleResults &&
      typeof roleResults === "object" &&
      !Array.isArray(roleResults) &&
      Object.keys(roleResults).length > 0
  );
}

function isUsableReviewResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  const serialized = JSON.stringify(record);
  if (/AI 输出格式异常|请人工复核 AI 输出/u.test(serialized)) return false;

  return (
    Array.isArray(record.must_focus) &&
    record.must_focus.length > 0 &&
    Array.isArray(record.actions) &&
    record.actions.length > 0 &&
    Array.isArray(record.tips) &&
    record.tips.length > 0
  );
}

function formatDocumentReadFailureMessage(
  intent: ReviewDocumentIntent,
  error: unknown
): string {
  const errorMessage = extractErrorMessage(error);
  if (
    intent.documentType === "wiki" &&
    /wiki:wiki|wiki:node:read|99991672|Access denied/u.test(errorMessage)
  ) {
    return [
      "我收到的是知识库 wiki 链接，但当前应用还没有知识库读取权限，所以无法把它解析成实际文档。",
      "",
      "需要在飞书开放平台补开任一权限并发布新版本：",
      "- wiki:wiki:readonly",
      "- wiki:node:read",
      "",
      "临时解决办法：把合同文档从知识库里打开后，复制实际 /docx/ 链接发给我。"
    ].join("\n");
  }

  return [
    "我没能读取这个飞书文档，所以还不能开始审查。",
    "",
    "请确认：",
    "1. 链接是新版飞书文档 /docx/、旧版文档 /docs/，或者应用已开通 wiki 读取权限。",
    "2. 文档已授权给机器人，或组织内获得链接的人可阅读。",
    "3. 应用权限改动已经发布生效。",
    "",
    `底层错误：${errorMessage}`
  ].join("\n");
}

function formatAttachmentImportFailureMessage(error: unknown): string {
  const errorMessage = extractErrorMessage(error);
  return [
    "我已经识别到你回复的是普通文件附件，但暂时没能读取出可审查的文字内容，所以没有开始 AI 审查。",
    "",
    "请确认：",
    "1. 文件格式是 .doc、.docx、.pdf、.txt、.md、.markdown 或 .html，且文件不为空。",
    "2. 文件没有加密、损坏，且内容不是纯图片扫描件。",
    "3. 如果是 PDF，请确认它是文字型 PDF；扫描件或图片版 PDF 暂时不能识别。",
    "4. 普通文件附件不会被转换成飞书在线文档，也不会生成可点击合同链接。",
    "",
    `底层错误：${errorMessage}`
  ].join("\n");
}

function formatArchiveFailureStopMessage(error: unknown): string {
  const detail = isMissingScopeError(error)
    ? formatMissingScopeInstruction(error)
    : describeFeishuError(error);
  return [
    "我已经读到这份飞书文档，但还不能开始审查。",
    "",
    "原因是：机器人没有完成合同归档 / 企业内可编辑权限设置。",
    "按照当前设计，机器人必须先把合同放进本群合同文件夹，并确认合同链接可编辑，之后才会生成审查版本、任务和卡片。",
    "",
    detail,
    "",
    "这次不会创建新的合同版本，也不会调用 AI。请补齐权限并发布应用版本后，再重新 @ 机器人发送同一份合同。"
  ].join("\n");
}

function formatPostReviewFailureSummary(failures: string[]): string {
  const uniqueFailures = [...new Set(failures)];
  const hasMissingScope = uniqueFailures.some((failure) =>
    /权限未开通|缺少权限|Access denied|99991672|scope/iu.test(failure)
  );
  const taskFailures = uniqueFailures.filter((failure) => /任务/u.test(failure));
  const cardFailures = uniqueFailures.filter((failure) => !/任务/u.test(failure));
  const title = hasMissingScope
    ? "但飞书任务/后续操作没有全部完成，原因是应用权限还没有发布生效。"
    : taskFailures.length > 0
      ? "但飞书任务没有全部创建或更新成功。"
      : "但部分飞书卡片没有发送成功。";
  const nextStep = hasMissingScope
    ? [
        "请先去飞书开放平台补齐上面列出的权限，并且一定要发布新版本。",
        "发布完成后，在 PowerShell 里重新运行 start-bot.ps1 -Restart。",
        "如果这是已经审查完成但任务没生成的合同，可以再运行 pnpm tasks:backfill 补建任务，不需要重新调用 AI。"
      ].join("\n")
    : taskFailures.length > 0
      ? "请查看机器人日志确认任务失败原因；修复后可运行 pnpm tasks:backfill 补建已审查合同的任务。"
      : "请查看机器人日志确认具体失败对象，然后重试发送卡片。";
  return [
    title,
    "",
    taskFailures.length > 0
      ? "说明：AI 审查结果已经保存；由于任务创建/更新失败，机器人已尽量用私信卡片兜底发送给负责人。"
      : undefined,
    cardFailures.length > 0
      ? "说明：任务处理不一定失败，下面列出的卡片收件人或群卡片需要单独排查。"
      : undefined,
    taskFailures.length > 0 || cardFailures.length > 0 ? "" : undefined,
    "失败项：",
    ...uniqueFailures.slice(0, 8).map((failure) => `- ${failure}`),
    uniqueFailures.length > 8 ? `- 另外还有 ${uniqueFailures.length - 8} 项，详见日志。` : undefined,
    "",
    nextStep
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const responseData = readPath(error, ["response", "data"]);
    if (responseData) return JSON.stringify(responseData);
    return error.message;
  }
  return String(error);
}

function formatPublicReviewFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isNonRetriableAiServiceError(error)) {
    return [
      "AI 服务账号当前不可用，本次没有生成审查卡片。",
      "",
      "这不是飞书权限问题，也不是合同文档读取失败。",
      "机器人已经能读取合同，但调用大模型时返回了余额不足/欠费/额度不可用错误。",
      "",
      `底层错误：${message.length > 300 ? `${message.slice(0, 300)}...` : message}`
    ].join("\n");
  }
  if (
    /ZodError|invalid_type|invalid_value|unrecognized_keys|AI response was not valid JSON|complete structured review result/u.test(
      message
    )
  ) {
    return "AI 返回的审查结果格式不稳定，本次没有生成审查卡片。你可以重新发送同一份文档链接，我会重新审查。";
  }
  return message.length > 300 ? `${message.slice(0, 300)}...` : message;
}

function isNonRetriableAiServiceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /overdue balance|insufficient balance|quota|欠费|余额不足|额度不足|no credit|payment required|billing/iu.test(
    message
  );
}

function readPath(input: unknown, path: string[]): unknown {
  let current = input;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function makeContractChatWorkflowOptions(config: AppConfig, deps: {
  store: ContractCaseStore;
  feishu: FeishuClient;
  reviewer: ContractReviewer;
}): ContractChatWorkflowOptions {
  const documentArchive = new DocumentArchive(
    config.documentArchive,
    deps.store,
    deps.feishu
  );
  const taskCoordinator = new TaskCoordinator(
    config.tasks,
    deps.store,
    deps.feishu
  );
  return {
    contractChatId: config.contractChatId,
    botMentionName: config.botMentionName,
    ownerDefaults: config.owners,
    reviewTestCc: config.reviewTestCc,
    documentArchive,
    taskCoordinator,
    ...deps
  };
}

function normalizeMentionName(value: string): string {
  return value.replace(/^@/u, "").replace(/\s+/gu, "").trim().toLowerCase();
}
