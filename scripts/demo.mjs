import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DemoFeishu } from "./demo-feishu.mjs";
import { ContractCaseStore } from "../dist/src/chat/contractCaseStore.js";
import { ContractChatWorkflow } from "../dist/src/chat/contractChatWorkflow.js";
import { DocumentArchive } from "../dist/src/chat/documentArchive.js";
import { TaskCoordinator } from "../dist/src/chat/taskCoordinator.js";
import { roleKeys, roleLabels } from "../dist/src/domain/types.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-demo-"));
const scenes = [];
const feishu = new DemoFeishu();
feishu.getDocxMetadata = async () => ({ title: "星河科技 · 软件服务合同（虚构）", revisionId: 1 });
feishu.getUserDisplayName = async (id) => ({ submitter: "林晓", commercial_1: "林晓", operations_1: "周宁", legal_1: "陈悦", finance_1: "许安" })[id];
const owners = Object.fromEntries(roleKeys.map((role) => [role, [{ roleKey: role, roleLabel: roleLabels[role], displayName: ({commercial:"林晓",operations:"周宁",legal:"陈悦",finance:"许安"})[role], userId: `${role}_1`, source: "env" }]]));
let calls = 0;
const details = {
  commercial: ["服务范围边界", "交付项与变更收费未约定，建议补充工作说明书。", "明确交付清单、服务范围及变更报价机制。"],
  operations: ["验收标准不清", "验收缺少客观指标与反馈期限，影响排期和回款。", "补充验收指标、反馈期限与客户配合义务。"],
  legal: ["责任上限缺失", "赔偿范围与责任上限未约定，需要法务重点复核。", "补充责任上限、知识产权归属与终止结算条款。"],
  finance: ["付款周期过长", "验收后180日付款形成资金占用，且未约定逾期责任。", "协商分期付款并补充逾期付款责任。"]
};
const reviewer = { async review(input) {
  calls++;
  const [title, detail, action] = details[input.reviewProfile.key];
  return { contract_type: "软件服务合同", risk_level: input.reviewProfile.key === "legal" ? "high" : "medium", suggestion: "supplement_required", confidence: 0.88,
    must_focus: [{ title, detail }], actions: [action], tips: ["本结果为辅助建议，需由负责人复核。"] };
} };
let eventNumber = 0;
const event = (text, extra = {}) => ({ eventId: `demo_event_${++eventNumber}`, messageId: `om_demo_${eventNumber}`, chatId: "oc_demo_group", chatType: "group", messageType: "text", text, senderUserId: "submitter", mentions: [{ key: "@_user_1", name: "合同审查机器人", userId: "demo_bot" }], raw: {}, ...extra });
const saveScene = (id, title, userText, kind = "group") => {
  const card = kind === "private" ? feishu.privateCards.at(-1)?.card : feishu.groupCards.at(-1)?.card;
  scenes.push({ id, title, userText, kind, card, text: feishu.textMessages.at(-1)?.text ?? "" });
};
try {
  const store = new ContractCaseStore(dataDir);
  const workflow = new ContractChatWorkflow({ contractChatId: "*", botMentionName: "合同审查机器人", store, feishu, reviewer, ownerDefaults: owners,
    documentArchive: new DocumentArchive({ enabled: true, rootFolderToken: "" }, store, feishu), taskCoordinator: new TaskCoordinator({ enabled: true }, store, feishu) });
  await workflow.handleMessage(event("@_user_1 我是商务负责人", { senderUserId: "commercial_1" }));
  scenes.push({ id: "01-registration", title: "负责人注册与身份识别", userText: "@合同审查机器人 我是商务负责人", text: feishu.textMessages.at(-1)?.text, kind: "text" });
  const link = "https://example.feishu.cn/docx/DEMO_CONTRACT";
  feishu.docxText.set("DEMO_CONTRACT", "虚构软件服务合同：验收后180日付款，交付范围与责任上限未约定。");
  await workflow.handleMessage(event(`@_user_1 ${link}`));
  let contract = await store.findLatestContractInChat("oc_demo_group");
  assert.equal(contract.latestVersion, 1);
  assert.equal(feishu.createdTasks.length, 4);
  assert.equal(feishu.privateCards.length, 4);
  saveScene("02-link-review", "发送文档链接，启动四职能首审", `@合同审查机器人 ${link}`);
  saveScene("03-private-task", "负责人私信：审查结果与任务入口", "首次审查后，负责人收到对应职能入口卡片", "private");
  const taskCommentsV1 = structuredClone(feishu.taskComments);
  const beforeRepeat = calls;
  await workflow.handleMessage(event(`@_user_1 ${link}`));
  assert.equal(calls, beforeRepeat);
  saveScene("04-no-change", "内容未变，跳过重复审查", `@合同审查机器人 ${link}`);
  feishu.docxText.set("DEMO_CONTRACT", "虚构软件服务合同V2：增加交付清单，验收后90日付款，补充责任上限。");
  await workflow.handleMessage(event(`@_user_1 修改完毕 ${link}`));
  contract = await store.findLatestContractInChat("oc_demo_group");
  assert.equal(contract.latestVersion, 2);
  assert.equal(feishu.createdTasks.length, 4);
  assert.equal(feishu.privateCards.length, 4, "V2 reuses tasks and does not resend normal owner DMs");
  saveScene("05-revision", "修改后复审，建议追加到原任务", `@合同审查机器人 修改完毕 ${link}`);
  scenes.push({ id: "06-task-history", title: "一份合同，每个职能一个任务", kind: "task", task: feishu.createdTasks.find((task) => task.clientToken.endsWith("-finance")), comments: [...taskCommentsV1.filter((c) => c.taskGuid === "task-finance"), ...feishu.taskComments.slice(4).filter((c) => c.taskGuid === "task-finance")] });
  await workflow.handleMessage(event(`@_user_1 ${contract.contractId} 财务已完成`, { senderUserId: "finance_1" }));
  saveScene("07-completed", "负责人确认完成，同步群卡片状态", `@合同审查机器人 ${contract.contractId} 财务已完成`);
  await workflow.handleMessage(event(`@_user_1 ${contract.contractId} 财务恢复处理`, { senderUserId: "finance_1" }));
  saveScene("08-reopened", "恢复处理，继续接收后续版本更新", `@合同审查机器人 ${contract.contractId} 财务恢复处理`);
  feishu.messages.set("om_demo_attachment", { messageId: "om_demo_attachment", messageType: "file", fileKey: "demo_file", fileName: "示例服务合同.txt", text: "" });
  feishu.messageFiles.set("om_demo_attachment:demo_file", Buffer.from("虚构附件合同：软件服务一万元，验收后付款，责任上限未约定。"));
  await workflow.handleMessage(event("@_user_1", { parentMessageId: "om_demo_attachment" }));
  assert.equal(feishu.importedFiles.length, 0);
  saveScene("09-attachment", "回复普通附件，执行基础文字审查", "回复：示例服务合同.txt\n@合同审查机器人");
  scenes.push({ id: "10-archive", title: "按群归档，在线文档保留原链接与快照", kind: "archive", folders: feishu.createdFolders, versions: feishu.documentVersions, shortcuts: feishu.shortcuts });
  await workflow.handleMessage(event(`@_user_1 删除记录 ${link}`));
  scenes.push({ id: "11-reset", title: "清除本地合同审查记录", kind: "text", userText: `@合同审查机器人 删除记录 ${link}`, text: feishu.textMessages.at(-1)?.text });
  await mkdir("docs/demo", { recursive: true });
  await writeFile("docs/demo/scenes.json", JSON.stringify({ simulated: true, description: "Real workflow and card formatters; in-memory Feishu and deterministic AI fixtures. No real messages or contracts.", scenes }, null, 2) + "\n");
  console.log(`Offline demo passed: ${scenes.length} scenes; ${calls} fixture role reviews; reusable tasks, deduplication, completion and reply attachments verified.`);
} finally { await rm(dataDir, { recursive: true, force: true }); }
