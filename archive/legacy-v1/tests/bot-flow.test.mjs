import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { roleKeys, roleLabels } from "../dist/src/domain/types.js";
import { parseChatMessageEvent } from "../dist/src/chat/messageParsing.js";
import { parseChatIntent } from "../dist/src/chat/intentParser.js";
import { ContractCaseStore } from "../dist/src/chat/contractCaseStore.js";
import { ContractChatWorkflow } from "../dist/src/chat/contractChatWorkflow.js";
import {
  makeRegisteredOwner,
  resolveOwners
} from "../dist/src/chat/responsibleOwners.js";
import {
  parseReviewResultForTest,
  resolveChatCompletionUrl,
  resolveReviewModelMode
} from "../dist/src/review/claudeReviewer.js";
import { silentLarkLogger } from "../dist/src/feishu/sdkLogger.js";

const chatId = "oc_test_contract_group";
const senderUserId = "user_test";

async function testIntentParsing() {
  assert.equal(parseChatIntent("@_user_1 help").kind, "help");
  assert.equal(
    parseChatIntent("@_user_1 https://x.feishu.cn/docx/ABC123").kind,
    "initial_review"
  );
  assert.equal(
    parseChatIntent("@_user_1 https://x.feishu.cn/docs/OLD123").kind,
    "initial_review"
  );
  assert.equal(
    parseChatIntent("@_user_1 https://x.feishu.cn/wiki/WIKI123").kind,
    "initial_review"
  );
  assert.equal(
    parseChatIntent("@_user_1 删除记录 https://x.feishu.cn/docx/ABC123").kind,
    "delete_contract_record"
  );
  assert.equal(parseChatIntent("@_user_1 just talking").kind, "ignore");

  const richTextEvent = parseChatMessageEvent(
    makeRawMessage("", {
      messageType: "post",
      content: {
        title: "",
        content: [
          [
            { tag: "text", text: "review " },
            {
              tag: "a",
              text: "contract",
              href: "https://x.feishu.cn/docx/RICH_DOC_TOKEN"
            }
          ]
        ]
      }
    })
  );
  assert.match(richTextEvent.text, /https:\/\/x\.feishu\.cn\/docx\/RICH_DOC_TOKEN/u);
  assert.equal(parseChatIntent(richTextEvent.text).kind, "initial_review");
}

async function testWorkflow() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new FakeFeishu();
    const reviewer = new FakeReviewer();
    const workflow = new ContractChatWorkflow({
      contractChatId: chatId,
      store,
      feishu,
      reviewer,
      botMentionName: "Contract Bot",
      ownerDefaults: makeOwnerDefaults({
        commercial: "owner_commercial",
        operations: "owner_operations",
        legal: "owner_legal",
        finance: "owner_finance"
      })
    });

    await workflow.handleMessage(makeEvent("@_user_1 help"));
    assert.match(feishu.lastTextToChat(), /Bot/u);
    assert.doesNotMatch(feishu.lastTextToChat(), /负责人注册/u);
    assert.match(feishu.lastTextToChat(), /删除记录/u);

    await workflow.handleMessage(
      makeEvent("@_user_1 help", { mentionName: "Other Bot" })
    );
    assert.match(feishu.lastTextToChat(), /Bot/u);

    await workflow.handleMessage(makeEvent("@_user_1 help", { mentionName: undefined }));
    assert.match(feishu.lastTextToChat(), /Bot/u);

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/DOCX_TOKEN")
    );
    assert.equal(reviewer.calls.length, 4);
    assert.equal(feishu.privateCards.length, 4);
    assert.equal(feishu.groupCards.length, 1);

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/DOCX_TOKEN")
    );
    assert.equal(reviewer.calls.length, 4);
    assert.equal(feishu.privateCards.length, 4);
    assert.equal(feishu.groupCards.length, 2);

    feishu.rawContent = "second version contract text with changed payment terms";
    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/DOCX_TOKEN")
    );
    assert.equal(reviewer.calls.length, 8);
    assert.equal(feishu.privateCards.length, 8);
    assert.equal(feishu.groupCards.length, 3);

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docs/OLD_DOC_TOKEN")
    );
    assert.equal(reviewer.calls.length, 12);
    assert.equal(reviewer.calls.at(-1)?.documentToken, "OLD_DOC_TOKEN");

    feishu.rawContent = "wiki resolved contract text";
    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/wiki/WIKI_NODE_TOKEN")
    );
    assert.equal(reviewer.calls.length, 16);
    assert.equal(reviewer.calls.at(-1)?.documentToken, "WIKI_DOCX_TOKEN");

    await workflow.handleMessage(
      makeEvent("@_user_1 删除记录 https://example.feishu.cn/docx/DOCX_TOKEN")
    );
    assert.match(feishu.lastTextToChat(), /已删除这份合同/u);

    feishu.rawContent = "first version contract text with payment and liability terms";
    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/DOCX_TOKEN")
    );
    assert.equal(reviewer.calls.length, 20);
    assert.equal(feishu.privateCards.length, 20);
    assert.equal(feishu.groupCards.length, 6);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testStoreReadsUtf8BomStateFile() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    await writeFile(
      path.join(dataDir, "chat-bot-state.json"),
      `\uFEFF${JSON.stringify(
        {
          contracts: [],
          owners: {
            commercial: {
              roleKey: "commercial",
              roleLabel: "商务",
              displayName: "BOM Owner",
              userId: "owner_bom",
              source: "chat_registration"
            }
          },
          lastContractSequence: 0,
          processedMessageEvents: []
        },
        null,
        2
      )}`,
      "utf8"
    );

    const store = new ContractCaseStore(dataDir);
    const owner = await store.getOwner("commercial");
    assert.equal(owner?.userId, "owner_bom");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testWildcardChatIdAcceptsAnyGroup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new FakeFeishu();
    const reviewer = new FakeReviewer();
    const workflow = new ContractChatWorkflow({
      contractChatId: "*",
      store,
      feishu,
      reviewer,
      botMentionName: "Contract Bot",
      ownerDefaults: makeOwnerDefaults()
    });

    await workflow.handleMessage(
      makeEvent("@_user_1 帮助", { chatId: "oc_any_other_group" })
    );

    assert.equal(feishu.textMessages.at(-1)?.chatId, "oc_any_other_group");
    assert.match(feishu.lastTextToChat(), /合同审核群聊 Bot 使用方式/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testDuplicateFeishuEventIgnoredWhileFirstRunIsInProgress() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new FakeFeishu();
    const reviewer = new SlowReviewer();
    const workflow = new ContractChatWorkflow({
      contractChatId: chatId,
      store,
      feishu,
      reviewer,
      botMentionName: "Contract Bot",
      ownerDefaults: makeOwnerDefaults({
        commercial: "owner_commercial",
        operations: "owner_operations",
        legal: "owner_legal",
        finance: "owner_finance"
      })
    });

    const event = makeEvent("@_user_1 https://example.feishu.cn/docx/DUP_DOC_TOKEN", {
      eventId: "evt_duplicate_delivery",
      messageId: "om_duplicate_delivery"
    });
    const firstRun = workflow.handleMessage(event);
    await waitUntil(
      () => feishu.textMessages.filter((message) => message.text?.includes("已开始审查")).length === 1
    );

    await workflow.handleMessage(event);
    assert.equal(
      feishu.textMessages.filter((message) => message.text?.includes("已开始审查")).length,
      1
    );

    await firstRun;
    assert.equal(reviewer.calls.length, 4);
    assert.equal(feishu.privateCards.length, 4);
    assert.equal(feishu.groupCards.length, 1);

    const state = JSON.parse(
      await readFile(path.join(dataDir, "chat-bot-state.json"), "utf8")
    );
    assert.equal(state.contracts[0].latestVersion, 1);
    assert.equal(state.processedMessageEvents.length, 1);
    assert.equal(state.processedMessageEvents[0].status, "completed");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testRoleReviewRetryDoesNotSendSyntheticFallbackCards() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new FakeFeishu();
    const reviewer = new FakeReviewer();
    reviewer.failOnceForRole = "legal";
    const workflow = new ContractChatWorkflow({
      contractChatId: chatId,
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerDefaults({
        commercial: "owner_commercial",
        operations: "owner_operations",
        legal: "owner_legal",
        finance: "owner_finance"
      })
    });

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/RETRY_DOC_TOKEN")
    );

    assert.equal(reviewer.calls.length, 5);
    assert.equal(
      reviewer.calls.filter((call) => call.reviewProfile.key === "legal").length,
      2
    );
    assert.equal(feishu.privateCards.length, 4);
    assert.equal(feishu.groupCards.length, 1);
    const emittedCards = JSON.stringify([...feishu.privateCards, ...feishu.groupCards]);
    assert.doesNotMatch(emittedCards, /AI output format/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testEnvOwnerDefaultsOverrideChatRegistration() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    const store = new ContractCaseStore(dataDir);
    for (const roleKey of roleKeys) {
      await store.upsertOwner(
        makeRegisteredOwner({
          roleKey,
          userId: `chat_${roleKey}`,
          displayName: `chat ${roleKey}`
        })
      );
    }

    const owners = await resolveOwners(
      store,
      makeOwnerDefaults({
        commercial: "env_commercial",
        operations: "env_operations",
        legal: "env_legal",
        finance: "env_finance"
      })
    );

    assert.equal(owners.commercial.userId, "env_commercial");
    assert.equal(owners.operations.userId, "env_operations");
    assert.equal(owners.legal.userId, "env_legal");
    assert.equal(owners.finance.userId, "env_finance");
    assert.equal(owners.commercial.source, "env");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testReviewTestCcReceivesAllRoleCardsWithoutDuplicates() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new FakeFeishu();
    const reviewer = new FakeReviewer();
    const workflow = new ContractChatWorkflow({
      contractChatId: chatId,
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerDefaults({
        commercial: "owner_commercial",
        operations: "example_identity_5d4e289f",
        legal: "owner_legal",
        finance: "owner_finance"
      }),
      reviewTestCc: {
        enabled: true,
        userIds: ["example_identity_6911d0cc", "example_identity_5d4e289f"]
      }
    });

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/CC_DOC_TOKEN")
    );

    assert.equal(reviewer.calls.length, 4);
    assert.equal(feishu.privateCards.filter((card) => card.userId === "example_identity_6911d0cc").length, 4);
    assert.equal(feishu.privateCards.filter((card) => card.userId === "example_identity_5d4e289f").length, 4);
    assert.equal(feishu.privateCards.filter((card) => card.userId === "owner_commercial").length, 1);
    assert.equal(feishu.privateCards.filter((card) => card.userId === "owner_legal").length, 1);
    assert.equal(feishu.privateCards.filter((card) => card.userId === "owner_finance").length, 1);
    assert.equal(feishu.privateCards.length, 11);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testSyntheticHistoricalVersionDoesNotBlockRereview() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new FakeFeishu();
    const reviewer = new FakeReviewer();
    const workflow = new ContractChatWorkflow({
      contractChatId: chatId,
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerDefaults({
        commercial: "owner_commercial",
        operations: "owner_operations",
        legal: "owner_legal",
        finance: "owner_finance"
      })
    });

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/BAD_HISTORY_TOKEN")
    );
    assert.equal(reviewer.calls.length, 4);

    const statePath = path.join(dataDir, "chat-bot-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.contracts[0].versions[0].roleResults.legal = {
      contract_type: "service agreement",
      risk_level: "medium",
      suggestion: "manual_review",
      confidence: 0.7,
      must_focus: [
        {
          title: "AI 输出格式异常",
          detail: "Synthetic fallback result should not be treated as usable history."
        }
      ],
      actions: ["请人工复核 AI 输出。"],
      tips: ["AI result is for reference only."]
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/BAD_HISTORY_TOKEN")
    );

    assert.equal(reviewer.calls.length, 8);
    assert.equal(feishu.privateCards.length, 8);
    assert.equal(feishu.groupCards.length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testFailedHistoricalVersionWithUsableRoleResultsBlocksDuplicateRereview() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-test-"));
  try {
    const store = new ContractCaseStore(dataDir);
    const feishu = new FakeFeishu();
    const reviewer = new FakeReviewer();
    const workflow = new ContractChatWorkflow({
      contractChatId: chatId,
      store,
      feishu,
      reviewer,
      ownerDefaults: makeOwnerDefaults({
        commercial: "owner_commercial",
        operations: "owner_operations",
        legal: "owner_legal",
        finance: "owner_finance"
      })
    });

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/DELIVERY_FAILED_TOKEN")
    );
    assert.equal(reviewer.calls.length, 4);

    const statePath = path.join(dataDir, "chat-bot-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.contracts[0].versions[0].status = "failed";
    state.contracts[0].versions[0].error = "Maximum call stack size exceeded";
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

    await workflow.handleMessage(
      makeEvent("@_user_1 https://example.feishu.cn/docx/DELIVERY_FAILED_TOKEN")
    );

    assert.equal(reviewer.calls.length, 4);
    assert.equal(feishu.privateCards.length, 4);
    assert.equal(feishu.groupCards.length, 2);
    const updatedState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(updatedState.contracts[0].latestVersion, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function testAiEndpointResolution() {
  assert.equal(
    resolveChatCompletionUrl("https://ark.cn-beijing.volces.com/api/v3"),
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
  );
  assert.equal(
    resolveChatCompletionUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    resolveChatCompletionUrl("https://example.com/custom/chat/completions"),
    "https://example.com/custom/chat/completions"
  );
}

function testReviewModelModesAndMiniFallback() {
  assert.equal(resolveReviewModelMode("doubao-seed-2-0-mini-260428"), "mini");
  assert.equal(resolveReviewModelMode("doubao-seed-2-0-pro-260215"), "pro");
  assert.equal(resolveReviewModelMode("gpt-4o-mini"), "standard");

  const input = makeReviewInput();
  const parsed = parseReviewResultForTest(
    JSON.stringify({
      contract_type: "service agreement",
      risk_level: "medium",
      suggestion: "supplement_required",
      confidence: 0.8,
      must_focus: [{ title: "scope", detail: "scope is unclear" }],
      actions: ["clarify scope"],
      tips: ["manual review required"]
    }),
    input,
    "doubao-seed-2-0-mini-260428"
  );
  assert.equal(parsed.contract_type, "service agreement");

  const fallback = parseReviewResultForTest(
    "{}",
    input,
    "doubao-seed-2-0-mini-260428"
  );
  assert.equal(fallback.suggestion, "manual_review");

  assert.throws(() => parseReviewResultForTest("{}", input, "doubao-seed-2-0-pro-260215"));
}

function testLarkLoggerHandlesCircularSdkObjects() {
  const circular = { name: "sdk object" };
  circular.self = circular;
  assert.doesNotThrow(() => silentLarkLogger.warn("circular sdk object", circular));
}

function makeRawMessage(text, options = {}) {
  const messageType = options.messageType ?? "text";
  const mentionName = Object.hasOwn(options, "mentionName")
    ? options.mentionName
    : "Contract Bot";
  const content =
    options.content === undefined
      ? JSON.stringify({ text })
      : JSON.stringify(options.content);
  return {
    event_id: options.eventId ?? `evt_${Math.random()}`,
    message: {
      message_id: options.messageId ?? `om_${Math.random()}`,
      chat_id: options.chatId ?? chatId,
      chat_type: "group",
      message_type: messageType,
      content,
      mentions: [
        {
          key: "@_user_1",
          ...(mentionName === undefined ? {} : { name: mentionName }),
          id: { user_id: "user_bot" }
        }
      ]
    },
    sender: {
      sender_id: {
        user_id: options.senderUserId ?? senderUserId,
        union_id: "on_test"
      }
    }
  };
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function makeEvent(text, options = {}) {
  const raw = makeRawMessage(text, options);
  if (options.mentioned === false) raw.message.mentions = [];
  return parseChatMessageEvent(raw);
}

function makeOwnerDefaults(userIds = {}) {
  return Object.fromEntries(
    roleKeys.map((roleKey) => [
      roleKey,
      {
        roleKey,
        roleLabel: roleLabels[roleKey],
        displayName: `${roleKey} owner`,
        ...(userIds[roleKey] ? { userId: userIds[roleKey] } : {}),
        source: userIds[roleKey] ? "env" : "missing"
      }
    ])
  );
}

function makeReviewInput() {
  return {
    contractId: "HT-TEST",
    version: 1,
    documentTitle: "CRC service agreement",
    documentUrl: "https://example.feishu.cn/docx/TEST",
    documentToken: "TEST",
    triggeredByName: "Test User",
    contract: {
      fileName: "test.txt",
      text: "contract body",
      extractionWarnings: []
    },
    reviewProfile: {
      key: "commercial",
      nodeName: "commercial review",
      title: "commercial review",
      reviewerRole: "commercial owner",
      skillReferences: [],
      focusAreas: ["scope", "payment"]
    }
  };
}

class FakeFeishu {
  rawContent = "first version contract text with payment and liability terms";
  wikiError = undefined;
  textMessages = [];
  privateCards = [];
  groupCards = [];

  async getDocxMetadata(documentId) {
    return { title: `Contract ${documentId}`, revisionId: 1 };
  }

  async getDocxRawContent() {
    return this.rawContent;
  }

  async getDocsContent(documentToken) {
    return {
      title: `Legacy Contract ${documentToken}`,
      content: this.rawContent
    };
  }

  async getWikiNodeInfo(nodeToken) {
    if (this.wikiError) throw this.wikiError;
    return {
      objType: "docx",
      objToken: "WIKI_DOCX_TOKEN",
      title: `Wiki Contract ${nodeToken}`
    };
  }

  async getUserDisplayName(userId) {
    return userId === senderUserId ? "Contact Name" : undefined;
  }

  async getChatMemberDisplayName(_chatId, userId) {
    if (userId === senderUserId) return "Chat Member Name";
    return undefined;
  }

  async sendTextToChatId(targetChatId, text) {
    this.textMessages.push({ chatId: targetChatId, text });
    return { ok: true };
  }

  async sendTextToUserId(userId, text) {
    this.textMessages.push({ userId, text });
    return { ok: true };
  }

  async sendInteractiveCardToChatId(targetChatId, card) {
    this.groupCards.push({ kind: "chat-card", chatId: targetChatId, card });
    return { ok: true };
  }

  async sendInteractiveCardToUserId(userId, card) {
    this.privateCards.push({ kind: "private-card", userId, card });
    return { ok: true };
  }

  lastTextToChat() {
    return this.textMessages.filter((message) => message.chatId).at(-1)?.text ?? "";
  }
}

class FakeReviewer {
  calls = [];
  failOnceForRole = undefined;
  failedOnceRoles = new Set();

  async review(input) {
    this.calls.push(input);
    if (
      this.failOnceForRole === input.reviewProfile.key &&
      !this.failedOnceRoles.has(input.reviewProfile.key)
    ) {
      this.failedOnceRoles.add(input.reviewProfile.key);
      throw new Error(
        "AI response was not a complete structured review result after schema repair: empty JSON"
      );
    }
    return makeFakeReviewResult(input);
  }
}

class SlowReviewer extends FakeReviewer {
  async review(input) {
    this.calls.push(input);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return makeFakeReviewResult(input);
  }
}

function makeFakeReviewResult(input) {
  return {
    contract_type: "service agreement",
    risk_level: "medium",
    suggestion: "supplement_required",
    confidence: 0.82,
    must_focus: [
      {
        title: `${input.reviewProfile.key} focus`,
        detail: "Clarify acceptance, payment, scope, and liability."
      }
    ],
    actions: ["Add objective acceptance criteria."],
    tips: ["AI result is for human review only."]
  };
}

await testIntentParsing();
await testWorkflow();
await testStoreReadsUtf8BomStateFile();
await testWildcardChatIdAcceptsAnyGroup();
await testDuplicateFeishuEventIgnoredWhileFirstRunIsInProgress();
await testRoleReviewRetryDoesNotSendSyntheticFallbackCards();
await testEnvOwnerDefaultsOverrideChatRegistration();
await testReviewTestCcReceivesAllRoleCardsWithoutDuplicates();
await testSyntheticHistoricalVersionDoesNotBlockRereview();
await testFailedHistoricalVersionWithUsableRoleResultsBlocksDuplicateRereview();
testAiEndpointResolution();
testReviewModelModesAndMiniFallback();
testLarkLoggerHandlesCircularSdkObjects();

console.log("bot-flow tests passed");
