import "dotenv/config";

process.env.LOG_LEVEL ??= "fatal";

const { loadConfig } = await import("../dist/src/config.js");
const { ContractCaseStore } = await import("../dist/src/chat/contractCaseStore.js");
const { resolveOwners } = await import("../dist/src/chat/responsibleOwners.js");
const { TaskCoordinator } = await import("../dist/src/chat/taskCoordinator.js");
const { roleKeys } = await import("../dist/src/domain/types.js");
const { FeishuClient } = await import("../dist/src/feishu/feishuClient.js");

const config = loadConfig();
const store = new ContractCaseStore(config.dataDir);
const feishu = new FeishuClient(config.feishu);
const taskCoordinator = new TaskCoordinator(config.tasks, store, feishu);

const contractIdFilter = normalize(process.env.BACKFILL_CONTRACT_ID);
const chatIdFilter = normalize(process.env.BACKFILL_CHAT_ID) ??
  (config.contractChatId !== "*" ? config.contractChatId : undefined);

const summary = {
  scanned: 0,
  skipped: 0,
  processed: 0,
  failures: []
};

if (!config.tasks.enabled) {
  console.log(JSON.stringify({
    status: "skip",
    message:
      "FEISHU_TASKS_ENABLED is false. Set it to true and restart/build before backfilling tasks."
  }, null, 2));
  process.exit(0);
}

const owners = await resolveOwners(store, config.owners);
const contracts = await store.listContracts();

for (const contract of contracts) {
  if (chatIdFilter && contract.chatId !== chatIdFilter) {
    summary.skipped += 1;
    continue;
  }
  if (contractIdFilter && contract.contractId.toUpperCase() !== contractIdFilter.toUpperCase()) {
    summary.skipped += 1;
    continue;
  }

  summary.scanned += 1;
  const version = latestReviewVersionWithResults(contract);
  if (!version) {
    summary.skipped += 1;
    continue;
  }

  const missingRoles = roleKeys.filter((roleKey) => {
    if (contract.roleStatuses?.[roleKey]?.status === "completed") return false;
    if (contract.roleTasks?.[roleKey]?.taskGuid) return false;
    return owners[roleKey].some((owner) => owner.userId);
  });

  if (missingRoles.length === 0) {
    summary.skipped += 1;
    continue;
  }

  const result = await taskCoordinator.syncReviewVersion({
    contract,
    version: version.version,
    owners,
    results: version.roleResults,
    triggeredByName: version.triggeredByName ?? "未知提交人",
    reviewKindLabel: version.intent === "revision_done" ? "修改完毕后复审" : "首次审查",
    roles: missingRoles
  });

  summary.processed += 1;
  if (result.failures.length > 0) {
    summary.failures.push({
      contractId: contract.contractId,
      version: version.version,
      roles: missingRoles,
      failures: result.failures
    });
  }
}

console.log(JSON.stringify({
  status: summary.failures.length > 0 ? "fail" : "pass",
  chatIdFilter: chatIdFilter ?? "*",
  contractIdFilter: contractIdFilter ?? null,
  ...summary
}, null, 2));

if (summary.failures.length > 0) process.exitCode = 1;

function latestReviewVersionWithResults(contract) {
  return contract.versions
    .slice()
    .reverse()
    .find((version) =>
      version.status === "completed" &&
      version.roleResults &&
      roleKeys.every((roleKey) => isUsableReviewResult(version.roleResults[roleKey]))
    );
}

function isUsableReviewResult(result) {
  return Boolean(
    result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      Array.isArray(result.must_focus) &&
      Array.isArray(result.actions) &&
      Array.isArray(result.tips)
  );
}

function normalize(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
