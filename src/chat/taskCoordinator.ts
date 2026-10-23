import {
  roleKeys,
  roleLabels,
  type ContractCaseRecord,
  type OwnerGroups,
  type RoleKey
} from "../domain/types.js";
import type { FeishuClient } from "../feishu/feishuClient.js";
import { describeFeishuError } from "../feishu/feishuErrors.js";
import { logger } from "../logger.js";
import type { ContractReviewResult } from "../review/reviewSchema.js";
import type { ContractCaseStore } from "./contractCaseStore.js";

export interface TaskCoordinatorOptions {
  enabled: boolean;
}

export class TaskCoordinator {
  constructor(
    private readonly options: TaskCoordinatorOptions,
    private readonly store: ContractCaseStore,
    private readonly feishu: FeishuClient
  ) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  async syncReviewVersion(input: {
    contract: ContractCaseRecord;
    version: number;
    owners: OwnerGroups;
    results: Record<RoleKey, ContractReviewResult>;
    triggeredByName: string;
    reviewKindLabel: string;
    roles?: RoleKey[];
  }): Promise<{
    contract: ContractCaseRecord;
    failures: string[];
    failedRoleKeys: RoleKey[];
  }> {
    if (!this.options.enabled) {
      return { contract: input.contract, failures: [], failedRoleKeys: [] };
    }

    let contract = input.contract;
    const failures: string[] = [];
    const failedRoleKeys: RoleKey[] = [];
    for (const roleKey of input.roles ?? roleKeys) {
      if (contract.roleStatuses?.[roleKey]?.status === "completed") continue;
      const assigneeUserIds = unique(
        input.owners[roleKey]
          .map((owner) => owner.userId)
          .filter((userId): userId is string => Boolean(userId))
      );
      if (assigneeUserIds.length === 0) continue;

      try {
        const summary = `[${roleLabels[roleKey]}] ${contract.contractId} ${contract.documentTitle}`;
        const latestDescription = formatTaskDescription({
          contract,
          version: input.version,
          roleKey,
          result: input.results[roleKey],
          triggeredByName: input.triggeredByName
        });
        let task = contract.roleTasks?.[roleKey];
        if (!task) {
          const created = await this.feishu.createTask({
            summary,
            description: latestDescription,
            assigneeUserIds,
            clientToken: `${contract.contractId}-${roleKey}`,
            contractUrl: httpUrlOrUndefined(versionDocumentUrl(contract, input.version))
          });
          contract = await this.store.setRoleTask(contract.contractId, roleKey, {
            roleKey,
            taskGuid: created.taskGuid,
            taskUrl: created.taskUrl,
            status: "active",
            createdAt: new Date().toISOString()
          });
          task = contract.roleTasks?.[roleKey];
        } else {
          await this.feishu.updateTask({
            taskGuid: task.taskGuid,
            summary,
            description: latestDescription
          });
        }

        if (!task) throw new Error("任务创建成功后未写入本地存档");
        const comment = formatTaskVersionComment({
          contract,
          version: input.version,
          roleKey,
          result: input.results[roleKey],
          triggeredByName: input.triggeredByName,
          reviewKindLabel: input.reviewKindLabel
        });
        const chunks = splitTaskComment(comment, 7500);
        for (let index = 0; index < chunks.length; index += 1) {
          const prefix = chunks.length > 1 ? `（第 ${index + 1}/${chunks.length} 部分）\n` : "";
          await this.feishu.addTaskComment(task.taskGuid, `${prefix}${chunks[index]}`);
        }
      } catch (error) {
        failedRoleKeys.push(roleKey);
        const message = describeFeishuError(error);
        failures.push(`${roleLabels[roleKey]}任务：${message}`);
        logger.error(
          {
            err: error,
            contractId: contract.contractId,
            version: input.version,
            roleKey
          },
          "failed to synchronize contract role task"
        );
      }
    }

    return { contract, failures, failedRoleKeys };
  }

  async setRoleCompletion(input: {
    contract: ContractCaseRecord;
    roleKey: RoleKey;
    completed: boolean;
    actorUserId: string;
    actorName: string;
  }): Promise<ContractCaseRecord> {
    const current = input.contract.roleStatuses?.[input.roleKey]?.status ?? "active";
    const target = input.completed ? "completed" : "active";
    if (current === target) return input.contract;

    let contract = input.contract;
    const task = contract.roleTasks?.[input.roleKey];
    if (this.options.enabled && task && input.completed) {
      await this.feishu.deleteTask(task.taskGuid);
      contract = await this.store.deleteRoleTask(contract.contractId, input.roleKey);
    }

    return this.store.setRoleStatus(contract.contractId, input.roleKey, {
      status: target,
      ...(input.completed
        ? {
            completedAt: new Date().toISOString(),
            completedByUserId: input.actorUserId,
            completedByName: input.actorName,
            completedAtVersion: contract.latestVersion
          }
        : {})
    });
  }
}

function formatTaskDescription(input: {
  contract: ContractCaseRecord;
  version: number;
  roleKey: RoleKey;
  result: ContractReviewResult;
  triggeredByName: string;
}): string {
  return [
    `合同：${input.contract.contractId}`,
    `职能：${roleLabels[input.roleKey]}`,
    `当前版本：V${input.version}`,
    `最近提交人：${input.triggeredByName}`,
    `风险等级：${riskLabel(input.result.risk_level)}`,
    `AI 建议：${suggestionLabel(input.result.suggestion)}`,
    `合同链接：${formatTaskContractLink(input.contract, input.version)}`,
    input.contract.folderUrl ? `历史文件夹：${input.contract.folderUrl}` : "",
    "",
    "完整的每一版 AI 建议都保存在本任务的评论中。是否处理完成只由负责人确认，AI 不会自动判断。"
  ].filter(Boolean).join("\n");
}

function formatTaskVersionComment(input: {
  contract: ContractCaseRecord;
  version: number;
  roleKey: RoleKey;
  result: ContractReviewResult;
  triggeredByName: string;
  reviewKindLabel: string;
}): string {
  return [
    `【${input.contract.contractId} V${input.version} ${roleLabels[input.roleKey]}审查建议】`,
    `流程：${input.reviewKindLabel}`,
    `提交人：${input.triggeredByName}`,
    `合同链接：${formatTaskContractLink(input.contract, input.version)}`,
    `风险等级：${riskLabel(input.result.risk_level)}`,
    `处理建议：${suggestionLabel(input.result.suggestion)}`,
    `置信度：${Math.round(input.result.confidence * 100)}%`,
    "",
    "必须关注",
    ...input.result.must_focus.map(
      (item, index) => `${index + 1}. ${sanitize(item.title)}：${sanitize(item.detail)}`
    ),
    "",
    "建议动作 / 修改建议",
    ...input.result.actions.map((item, index) => `${index + 1}. ${sanitize(item)}`),
    "",
    "审批提示",
    ...input.result.tips.map((item, index) => `${index + 1}. ${sanitize(item)}`),
    "",
    "说明：以上为 AI 辅助建议，不代表问题已解决，也不会替负责人作出完成决定。"
  ].join("\n");
}

function versionDocumentUrl(contract: ContractCaseRecord, version: number): string {
  return contract.versions.find((item) => item.version === version)?.documentUrl ?? contract.documentUrl;
}

function formatTaskContractLink(contract: ContractCaseRecord, version: number): string {
  return httpUrlOrUndefined(versionDocumentUrl(contract, version)) ?? "普通文件附件，不支持跳转链接";
}

function httpUrlOrUndefined(value: string): string | undefined {
  return /^https?:\/\//u.test(value) ? value : undefined;
}

function splitTaskComment(value: string, maxLength: number): string[] {
  if (value.length <= maxLength) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/u, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sanitize(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/```/gu, "").trim();
}

function riskLabel(value: ContractReviewResult["risk_level"]): string {
  return value === "high" ? "高" : value === "medium" ? "中" : "低";
}

function suggestionLabel(value: ContractReviewResult["suggestion"]): string {
  if (value === "suggest_approve") return "建议通过";
  if (value === "supplement_required") return "补充材料或修改后再审";
  return "需要人工重点复核";
}
