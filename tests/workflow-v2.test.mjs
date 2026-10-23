import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContractCaseStore } from "../dist/src/chat/contractCaseStore.js";
import { ContractChatWorkflow } from "../dist/src/chat/contractChatWorkflow.js";
import { DocumentArchive } from "../dist/src/chat/documentArchive.js";
import { TaskCoordinator } from "../dist/src/chat/taskCoordinator.js";
import { roleKeys, roleLabels } from "../dist/src/domain/types.js";

const chatId = "oc_v2_workflow_test";

async function testAttachmentBasicReviewTasksAndCompletion() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-v2-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new WorkflowFeishu();
    const reviewer = new WorkflowReviewer();
    const archive = new DocumentArchive(
      { enabled: true, rootFolderToken: "root_contracts" },
      store,
      feishu
    );
    const tasks = new TaskCoordinator({ enabled: true }, store, feishu);
    const ownerDefaults = makeOwnerGroups({
      commercial: ["commercial_1", "commercial_2"],
      operations: ["operations_1"],
      legal: ["legal_1"],
      finance: ["finance_1"]
    });
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      botMentionName: "合同审批Bot",
      store,
      feishu,
      reviewer,
      ownerDefaults,
      documentArchive: archive,
      taskCoordinator: tasks,
      reviewTestCc: { enabled: false, userIds: [] }
    });

    setReplyFile(
      feishu,
      "om_file_v1",
      "contract.txt",
      Buffer.from("V1 contract text with payment, acceptance, liability and service scope.")
    );
    await workflow.handleMessage(
      makeEvent("@_user_1", {
        messageId: "om_trigger_v1",
        parentMessageId: "om_file_v1",
        senderUserId: "commercial_1"
      })
    );

    let contract = await store.findLatestContractInChat(chatId);
    assert.ok(contract);
    assert.equal(contract.latestVersion, 1);
    assert.equal(contract.versions.length, 1);
    assert.equal(
      contract.versions[0]?.documentUrl,
      "Feishu file attachment: contract.txt (message_id: om_file_v1)"
    );
    assert.equal(feishu.importedFiles.length, 0, "plain attachments are not imported as Feishu docs");
    assert.equal(feishu.createdFolders.length, 1, "each chat gets a contract folder");
    assert.equal(feishu.createdFolders[0]?.name, "合同");
    assert.equal(feishu.chatFolderPermissions.length, 1);
    assert.equal(feishu.tenantEditableTokens.length, 0);
    assert.equal(feishu.createdTasks.length, 4);
    assert.equal(
      feishu.createdTasks.find((task) => task.clientToken.endsWith("-commercial"))?.contractUrl,
      undefined
    );
    assert.deepEqual(
      feishu.createdTasks.find((task) => task.clientToken.endsWith("-commercial"))?.assigneeUserIds,
      ["commercial_1", "commercial_2"]
    );
    assert.equal(feishu.taskComments.length, 4);
    assert.equal(feishu.privateCards.length, 5, "each configured owner receives the V1 role card");
    const privateCardJson = JSON.stringify(feishu.privateCards[0]?.card);
    assert.doesNotMatch(privateCardJson, /必须关注/u);
    assert.doesNotMatch(privateCardJson, /建议动作 \/ 修改建议/u);
    assert.doesNotMatch(privateCardJson, /审批提示/u);
    assert.match(privateCardJson, /详细审查建议已写入对应飞书任务/u);
    assert.equal(feishu.groupCards.length, 1);
    assert.match(JSON.stringify(feishu.groupCards[0]?.card), /普通文件附件，不支持跳转链接/u);
    assert.doesNotMatch(JSON.stringify(feishu.groupCards[0]?.card), /https:\/\/example\.feishu\.cn\/docx/u);

    setReplyFile(
      feishu,
      "om_file_v2",
      "contract.txt",
      Buffer.from("V2 changed contract text with revised payment, acceptance and liability terms.")
    );
    await workflow.handleMessage(
      makeEvent("@_user_1", {
        messageId: "om_trigger_v2",
        parentMessageId: "om_file_v2",
        senderUserId: "operations_1"
      })
    );

    contract = await store.findLatestContractInChat(chatId);
    assert.equal(contract?.latestVersion, 2);
    assert.equal(contract?.versions.length, 2);
    assert.equal(
      contract?.versions[1]?.documentUrl,
      "Feishu file attachment: contract.txt (message_id: om_file_v2)"
    );
    assert.equal(feishu.createdTasks.length, 4, "V2 reuses the existing four tasks");
    assert.equal(feishu.updatedTasks.filter((item) => item.description).length, 4);
    assert.equal(feishu.taskComments.length, 8, "V1 and V2 advice remain as task comments");
    assert.equal(feishu.privateCards.length, 5, "production owners are not sent another V2 bot DM");
    assert.equal(feishu.groupCards.length, 2);

    await workflow.handleMessage(
      makeEvent(`@_user_1 ${contract.contractId} 财务已完成`, {
        messageId: "om_finance_done",
        senderUserId: "finance_1"
      })
    );
    contract = await store.findLatestContractInChat(chatId);
    assert.equal(contract?.roleStatuses?.finance?.status, "completed");
    assert.equal(contract?.roleStatuses?.finance?.completedByName, "财务负责人1");
    assert.deepEqual(feishu.deletedTasks, ["task-finance"]);
    assert.equal(contract?.roleTasks?.finance, undefined);
    assert.equal(feishu.updatedMessages.length, 1, "latest group card is refreshed when possible");

    const financeCommentCount = feishu.taskComments.filter((item) =>
      item.taskGuid.endsWith("finance")
    ).length;
    const financeDescriptionUpdateCount = feishu.updatedTasks.filter(
      (item) => item.taskGuid.endsWith("finance") && item.description
    ).length;

    setReplyFile(
      feishu,
      "om_file_v3",
      "contract.txt",
      Buffer.from("V3 changed contract text after finance confirmed completion; legal terms changed.")
    );
    await workflow.handleMessage(
      makeEvent("@_user_1", {
        messageId: "om_trigger_v3",
        parentMessageId: "om_file_v3",
        senderUserId: "legal_1"
      })
    );

    contract = await store.findLatestContractInChat(chatId);
    assert.equal(contract?.latestVersion, 3);
    const v3StartedText = feishu.textMessages
      .filter((message) => message.text?.includes("已开始审查"))
      .at(-1)?.text ?? "";
    assert.match(v3StartedText, /商务、运营、法务建议/u);
    assert.doesNotMatch(v3StartedText, /财务建议/u);
    assert.equal(
      feishu.taskComments.filter((item) => item.taskGuid.endsWith("finance")).length,
      financeCommentCount,
      "completed finance role receives no V3 task comment"
    );
    assert.equal(
      feishu.updatedTasks.filter(
        (item) => item.taskGuid.endsWith("finance") && item.description
      ).length,
      financeDescriptionUpdateCount,
      "completed finance role receives no V3 task update"
    );
    assert.equal(feishu.privateCards.length, 5);
    assert.match(JSON.stringify(feishu.groupCards.at(-1)?.card), /财务：已确认完成/u);
    assert.doesNotMatch(JSON.stringify(feishu.groupCards.at(-1)?.card), /财务：中风险/u);

    await workflow.handleMessage(
      makeEvent(`@_user_1 ${contract.contractId} 财务恢复处理`, {
        messageId: "om_finance_reopen",
        senderUserId: "finance_1"
      })
    );
    contract = await store.findLatestContractInChat(chatId);
    assert.equal(contract?.roleStatuses?.finance?.status, "active");
    assert.equal(contract?.roleTasks?.finance, undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testLegacyWorkspaceRecordCreatesContractNamedFolder() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-legacy-folder-"));
  try {
    const store = new ContractCaseStore(dataDir);
    await store.upsertChatWorkspace({
      chatId,
      folderToken: "old_folder",
      folderUrl: "https://example.feishu.cn/drive/folder/old_folder",
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    const feishu = new WorkflowFeishu();
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      botMentionName: "合同审批Bot",
      store,
      feishu,
      reviewer: new WorkflowReviewer(),
      ownerDefaults: makeOwnerGroups(),
      documentArchive: new DocumentArchive(
        { enabled: true, rootFolderToken: "root_contracts" },
        store,
        feishu
      )
    });
    setReplyFile(
      feishu,
      "om_legacy_folder_file",
      "contract.txt",
      Buffer.from("Contract text that should create a new chat folder named contract.")
    );

    await workflow.handleMessage(
      makeEvent("@_user_1", {
        messageId: "om_legacy_folder_trigger",
        parentMessageId: "om_legacy_folder_file"
      })
    );

    const workspace = await store.getChatWorkspace(chatId);
    assert.equal(workspace?.folderName, "合同");
    assert.notEqual(workspace?.folderToken, "old_folder");
    assert.equal(feishu.createdFolders[0]?.name, "合同");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testTextPdfAttachmentIsReviewedWithoutLink() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-pdf-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new WorkflowFeishu();
    const reviewer = new WorkflowReviewer();
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      botMentionName: "合同审批Bot",
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerGroups()
    });
    setReplyFile(
      feishu,
      "om_pdf",
      "text-contract.pdf",
      makeSimplePdf("PDF contract text with payment, liability, acceptance and service scope.")
    );

    await workflow.handleMessage(
      makeEvent("@_user_1", {
        messageId: "om_pdf_trigger",
        parentMessageId: "om_pdf"
      })
    );

    const contract = await store.findLatestContractInChat(chatId);
    assert.ok(contract);
    assert.equal(contract.latestVersion, 1);
    assert.equal(reviewer.calls.length, 4);
    assert.equal(feishu.importedFiles.length, 0);
    assert.equal(feishu.createdTasks.length, 0);
    assert.equal(feishu.groupCards.length, 1);
    assert.match(JSON.stringify(feishu.groupCards[0]?.card), /普通文件附件，不支持跳转链接/u);
    assert.doesNotMatch(JSON.stringify(feishu.groupCards[0]?.card), /https:\/\/example\.feishu\.cn\/docx/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testDirectDocRetainsLinkAndCreatesSnapshots() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-link-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new WorkflowFeishu();
    const reviewer = new WorkflowReviewer();
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      botMentionName: "合同审批Bot",
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerGroups(),
      documentArchive: new DocumentArchive(
        { enabled: true, rootFolderToken: "root_contracts" },
        store,
        feishu
      ),
      taskCoordinator: new TaskCoordinator({ enabled: true }, store, feishu)
    });
    const originalUrl = "https://example.feishu.cn/docx/DIRECT_DOC";

    feishu.docxText.set("DIRECT_DOC", "Direct V1 contract text.");
    await workflow.handleMessage(
      makeEvent(`@_user_1 ${originalUrl}`, { messageId: "om_direct_v1" })
    );
    feishu.docxText.set("DIRECT_DOC", "Direct V2 contract text changed.");
    await workflow.handleMessage(
      makeEvent(`@_user_1 ${originalUrl}`, { messageId: "om_direct_v2" })
    );

    const contract = await store.findLatestContractInChat(chatId);
    assert.equal(contract?.documentUrl, originalUrl);
    assert.equal(contract?.versions.length, 2);
    assert.equal(contract?.versions[0]?.documentUrl, originalUrl);
    assert.equal(contract?.versions[1]?.documentUrl, originalUrl);
    assert.equal(feishu.shortcuts.length, 1);
    assert.equal(feishu.documentVersions.length, 2);
    assert.equal(feishu.createdFolders[0]?.name, "合同");
    assert.deepEqual(
      contract?.versions.map((version) => version.feishuVersionId),
      ["snapshot-1", "snapshot-2"]
    );

    const reviewCallCount = reviewer.calls.length;
    await workflow.handleMessage(
      makeEvent(`@_user_1 ${originalUrl} 财务已完成`, {
        messageId: "om_direct_finance_done_by_operations",
        senderUserId: "operations_1"
      })
    );
    let updated = await store.findLatestContractInChat(chatId);
    assert.equal(updated?.roleStatuses?.finance?.status, "completed");
    assert.equal(updated?.roleStatuses?.finance?.completedByName, "运营负责人1");
    assert.deepEqual(feishu.deletedTasks, ["task-finance"]);
    assert.equal(reviewer.calls.length, reviewCallCount, "completion with a link does not trigger a new review");

    setReplyDoc(feishu, "om_original_doc_message", originalUrl);
    await workflow.handleMessage(
      makeEvent("@_user_1 法务已完成", {
        messageId: "om_reply_legal_done_by_operations",
        parentMessageId: "om_original_doc_message",
        senderUserId: "operations_1"
      })
    );
    updated = await store.findLatestContractInChat(chatId);
    assert.equal(updated?.roleStatuses?.legal?.status, "completed");
    assert.deepEqual(feishu.deletedTasks, ["task-finance", "task-legal"]);
    assert.equal(reviewer.calls.length, reviewCallCount, "completion by replying to a doc does not trigger a new review");

    feishu.docxText.set("DIRECT_DOC", "Direct V3 contract text changed after two roles completed.");
    await workflow.handleMessage(
      makeEvent(`@_user_1 ${originalUrl}`, { messageId: "om_direct_v3" })
    );
    const v3StartedText = feishu.textMessages
      .filter((message) => message.text?.includes("已开始审查"))
      .at(-1)?.text ?? "";
    assert.match(v3StartedText, /商务、运营建议/u);
    assert.doesNotMatch(v3StartedText, /法务建议/u);
    assert.doesNotMatch(v3StartedText, /财务建议/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testTestCcGetsAtMostFourRoleCardsPerVersion() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-cc-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new WorkflowFeishu();
    const reviewer = new WorkflowReviewer();
    const ownerDefaults = makeOwnerGroups({
      commercial: ["same_person"],
      operations: ["same_person"],
      legal: ["same_person"],
      finance: ["same_person"]
    });
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      store,
      feishu,
      reviewer,
      ownerDefaults,
      reviewTestCc: { enabled: true, userIds: ["same_person", "test_cc"] }
    });

    feishu.docxText.set("CC_DOC", "Contract text for CC deduplication.");
    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/CC_DOC", {
        messageId: "om_cc_v1"
      })
    );

    assert.equal(
      feishu.privateCards.filter((item) => item.userId === "same_person").length,
      4
    );
    assert.equal(
      feishu.privateCards.filter((item) => item.userId === "test_cc").length,
      4
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testConcurrentSameContractIsSerialized() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-concurrent-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new WorkflowFeishu();
    const reviewer = new WorkflowReviewer(40);
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerGroups()
    });
    feishu.docxText.set("CONCURRENT_DOC", "One concurrent contract body.");

    await Promise.all([
      workflow.handleMessage(
        makeEvent("@_user_1 https://example.feishu.cn/docx/CONCURRENT_DOC", {
          messageId: "om_concurrent_1",
          eventId: "evt_concurrent_1"
        })
      ),
      workflow.handleMessage(
        makeEvent("@_user_1 https://example.feishu.cn/docx/CONCURRENT_DOC", {
          messageId: "om_concurrent_2",
          eventId: "evt_concurrent_2"
        })
      )
    ]);

    const contracts = await store.listContractsInChat(chatId);
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0]?.versions.length, 1);
    assert.equal(contracts[0]?.latestVersion, 1);
    assert.equal(reviewer.calls.length, 4, "the unchanged concurrent duplicate does not call AI");
    assert.equal(feishu.groupCards.length, 2, "one review card and one no-change card");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testTaskFailureFallsBackToOnlyAffectedRolePrivateCard() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-task-fallback-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new WorkflowFeishu();
    const reviewer = new WorkflowReviewer();
    const tasks = new TaskCoordinator({ enabled: true }, store, feishu);
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerGroups(),
      taskCoordinator: tasks
    });
    feishu.docxText.set("TASK_FALLBACK_DOC", "V1 task fallback contract body.");
    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/TASK_FALLBACK_DOC", {
        messageId: "om_task_fallback_v1"
      })
    );
    assert.equal(feishu.privateCards.length, 4);

    const originalUpdateTask = feishu.updateTask.bind(feishu);
    feishu.updateTask = async (input) => {
      if (input.taskGuid.endsWith("finance") && input.description) {
        throw new Error("simulated finance task outage");
      }
      return originalUpdateTask(input);
    };
    feishu.docxText.set("TASK_FALLBACK_DOC", "V2 changed task fallback contract body.");
    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/TASK_FALLBACK_DOC", {
        messageId: "om_task_fallback_v2"
      })
    );

    assert.equal(feishu.privateCards.length, 5);
    assert.equal(feishu.privateCards.at(-1)?.userId, "finance_1");
    assert.match(feishu.lastTextToChat(), /飞书任务没有全部创建或更新成功/u);
    assert.match(feishu.lastTextToChat(), /AI 审查结果已经保存/u);
    assert.match(feishu.lastTextToChat(), /财务任务/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testLinkedDocumentArchivePermissionFailureContinuesReview() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-archive-scope-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new WorkflowFeishu();
    const reviewer = new WorkflowReviewer();
    const archive = new DocumentArchive(
      { enabled: true, rootFolderToken: "root_contracts" },
      store,
      feishu
    );
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerGroups(),
      documentArchive: archive
    });

    feishu.docxText.set("NO_SCOPE_DOC", "Document text that should still reach AI.");
    feishu.setTenantEditable = async () => {
      const error = new Error("Request failed with status code 400");
      error.response = {
        data: {
          code: 99991672,
          msg: "Access denied. One of the following scopes is required: [drive:drive, docs:permission.setting:write_only].",
          error: {
            permission_violations: [
              { type: "action_scope_required", subject: "drive:drive" },
              { type: "action_scope_required", subject: "docs:permission.setting:write_only" }
            ]
          }
        }
      };
      throw error;
    };

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/NO_SCOPE_DOC", {
        messageId: "om_archive_scope_failure"
      })
    );

    const contract = await store.findLatestContractInChat(chatId);
    assert.ok(contract);
    assert.equal(contract.latestVersion, 1, "linked feishu docs continue reviewing even when auto-permission update fails");
    assert.equal(reviewer.calls.length, 4, "AI is still called after the linked document is readable");
    assert.equal(feishu.groupCards.length, 1, "the general review card is still sent");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function setReplyFile(feishu, messageId, fileName, data) {
  const fileKey = `${messageId}_file_key`;
  feishu.messages.set(messageId, {
    messageId,
    messageType: "file",
    text: "",
    fileKey,
    fileName
  });
  feishu.messageFiles.set(`${messageId}:${fileKey}`, data);
}

function setReplyDoc(feishu, messageId, url) {
  feishu.messages.set(messageId, {
    messageId,
    messageType: "text",
    text: url
  });
}

function makeSimplePdf(text) {
  const escapedText = text.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 12 Tf 72 720 Td (${escapedText}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 72 720 Td (${escapedText}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join(""), "latin1"));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(""), "latin1");
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(`trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(chunks.join(""), "latin1");
}

function makeEvent(text, overrides = {}) {
  return {
    eventId: overrides.eventId ?? `evt_${overrides.messageId ?? Math.random()}`,
    messageId: overrides.messageId ?? `om_${Math.random()}`,
    parentMessageId: overrides.parentMessageId,
    rootMessageId: overrides.rootMessageId,
    chatId: overrides.chatId ?? chatId,
    chatType: "group",
    messageType: "text",
    text,
    senderUserId: overrides.senderUserId ?? "commercial_1",
    mentions: [{ key: "@_user_1", name: "合同审批Bot", userId: "bot_user" }],
    raw: {}
  };
}

function makeOwnerGroups(overrides = {}) {
  return Object.fromEntries(
    roleKeys.map((roleKey) => {
      const ids = overrides[roleKey] ?? [`${roleKey}_1`];
      return [
        roleKey,
        ids.map((userId, index) => ({
          roleKey,
          roleLabel: roleLabels[roleKey],
          displayName: `${roleLabels[roleKey]}负责人${index + 1}`,
          userId,
          source: "env"
        }))
      ];
    })
  );
}

class WorkflowReviewer {
  calls = [];

  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }

  async review(input) {
    this.calls.push(input);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      contract_type: "service agreement",
      risk_level: "medium",
      suggestion: "supplement_required",
      confidence: 0.88,
      must_focus: [
        {
          title: `${input.reviewProfile.key} risk`,
          detail: `Review ${input.contractId} V${input.version} carefully.`
        }
      ],
      actions: [`Update the ${input.reviewProfile.key} clause.`],
      tips: ["AI advice only; the owner decides completion."]
    };
  }
}

class WorkflowFeishu {
  textMessages = [];
  privateCards = [];
  groupCards = [];
  updatedMessages = [];
  messages = new Map();
  messageFiles = new Map();
  docxText = new Map();
  importedTextQueue = [];
  importedFiles = [];
  deletedFiles = [];
  createdFolders = [];
  chatFolderPermissions = [];
  tenantEditableTokens = [];
  shortcuts = [];
  documentVersions = [];
  createdTasks = [];
  updatedTasks = [];
  deletedTasks = [];
  taskComments = [];
  taskCompletion = new Map();

  async getChatName() {
    return "测试合同群";
  }

  async createFolder(name, parentFolderToken) {
    const folderToken = `folder_${this.createdFolders.length + 1}`;
    const record = {
      name,
      parentFolderToken,
      folderToken,
      folderUrl: `https://example.feishu.cn/drive/folder/${folderToken}`
    };
    this.createdFolders.push(record);
    return record;
  }

  async grantChatFolderFullAccess(folderToken, targetChatId) {
    this.chatFolderPermissions.push({ folderToken, chatId: targetChatId });
  }

  async importFileAsDocx(input) {
    const number = this.importedFiles.length + 1;
    const documentToken = `IMPORTED_${number}`;
    const documentUrl = `https://example.feishu.cn/docx/${documentToken}`;
    this.importedFiles.push({ ...input, documentToken, documentUrl });
    this.docxText.set(
      documentToken,
      this.importedTextQueue.shift() ?? `Imported contract ${number}`
    );
    return { documentToken, documentUrl };
  }

  async setTenantEditable(documentToken) {
    this.tenantEditableTokens.push(documentToken);
  }

  async deleteDriveFile(documentToken) {
    this.deletedFiles.push(documentToken);
  }

  async createDocumentShortcut(input) {
    this.shortcuts.push(input);
  }

  async createDocumentVersion(input) {
    const version = `snapshot-${this.documentVersions.length + 1}`;
    this.documentVersions.push({ ...input, version });
    return version;
  }

  async getDocxMetadata(documentToken) {
    return { title: `Contract ${documentToken}`, revisionId: 1 };
  }

  async getDocxRawContent(documentToken) {
    return this.docxText.get(documentToken) ?? "Default contract text.";
  }

  async getDocsContent(documentToken) {
    return { title: `Legacy ${documentToken}`, content: this.docxText.get(documentToken) };
  }

  async getWikiNodeInfo() {
    throw new Error("wiki is not used in this test");
  }

  async getMessage(messageId) {
    const message = this.messages.get(messageId);
    if (!message) throw new Error(`missing fake message ${messageId}`);
    return message;
  }

  async downloadMessageFile(messageId, fileKey) {
    const data = this.messageFiles.get(`${messageId}:${fileKey}`);
    if (!data) throw new Error(`missing fake file ${messageId}:${fileKey}`);
    return data;
  }

  async getUserDisplayName(userId) {
    const known = {
      commercial_1: "商务负责人1",
      operations_1: "运营负责人1",
      legal_1: "法务负责人1",
      finance_1: "财务负责人1"
    };
    return known[userId];
  }

  async getChatMemberDisplayName(_targetChatId, userId) {
    return this.getUserDisplayName(userId);
  }

  async createTask(input) {
    const roleKey = input.clientToken.split("-").at(-1);
    const taskGuid = `task-${roleKey}`;
    const taskUrl = `https://example.feishu.cn/task/${taskGuid}`;
    this.createdTasks.push({ ...input, taskGuid, taskUrl });
    this.taskCompletion.set(taskGuid, "0");
    return { taskGuid, taskUrl };
  }

  async updateTask(input) {
    this.updatedTasks.push(input);
    if (input.completedAt !== undefined) {
      this.taskCompletion.set(input.taskGuid, input.completedAt);
    }
  }

  async getTask(taskGuid) {
    return {
      completedAt: this.taskCompletion.get(taskGuid),
      taskUrl: `https://example.feishu.cn/task/${taskGuid}`
    };
  }

  async deleteTask(taskGuid) {
    this.deletedTasks.push(taskGuid);
    this.taskCompletion.delete(taskGuid);
  }

  async addTaskComment(taskGuid, content) {
    this.taskComments.push({ taskGuid, content });
  }

  async sendTextToChatId(targetChatId, text) {
    this.textMessages.push({ chatId: targetChatId, text });
    return {};
  }

  async sendInteractiveCardToChatId(targetChatId, card) {
    const messageId = `om_group_card_${this.groupCards.length + 1}`;
    this.groupCards.push({ chatId: targetChatId, card, messageId });
    return { messageId };
  }

  async sendInteractiveCardToUserId(userId, card) {
    const messageId = `om_private_card_${this.privateCards.length + 1}`;
    this.privateCards.push({ userId, card, messageId });
    return { messageId };
  }

  async updateInteractiveMessage(messageId, card) {
    this.updatedMessages.push({ messageId, card });
  }

  lastTextToChat() {
    return this.textMessages.at(-1)?.text ?? "";
  }
}

await testAttachmentBasicReviewTasksAndCompletion();
await testLegacyWorkspaceRecordCreatesContractNamedFolder();
await testTextPdfAttachmentIsReviewedWithoutLink();
await testDirectDocRetainsLinkAndCreatesSnapshots();
await testTestCcGetsAtMostFourRoleCardsPerVersion();
await testConcurrentSameContractIsSerialized();
await testTaskFailureFallsBackToOnlyAffectedRolePrivateCard();
await testLinkedDocumentArchivePermissionFailureContinuesReview();

console.log("workflow-v2 tests passed");
