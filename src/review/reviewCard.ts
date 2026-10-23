import type { ContractCaseRecord, OwnerGroups, OwnerRecord, RoleKey } from "../domain/types.js";
import { roleKeys, roleLabels } from "../domain/types.js";
import type { ContractReviewResult } from "./reviewSchema.js";

export interface FeishuInteractiveCard {
  config: {
    wide_screen_mode: true;
  };
  header: {
    template: "red" | "orange" | "green" | "blue";
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  elements: Array<
    | {
        tag: "markdown";
        content: string;
      }
    | {
        tag: "action";
        actions: Array<{
          tag: "button";
          text: { tag: "plain_text"; content: string };
          type?: "default" | "primary" | "danger";
          multi_url: {
            url: string;
            pc_url: string;
            ios_url: string;
            android_url: string;
          };
        }>;
      }
  >;
}

const riskHeaderTemplates = {
  high: "red",
  medium: "orange",
  low: "green"
} satisfies Record<ContractReviewResult["risk_level"], FeishuInteractiveCard["header"]["template"]>;

const riskLabels = {
  high: "高",
  medium: "中",
  low: "低"
} satisfies Record<ContractReviewResult["risk_level"], string>;

const suggestionLabels = {
  suggest_approve: "建议通过",
  supplement_required: "补充材料或修改后再审",
  manual_review: "需要人工重点复核"
} satisfies Record<ContractReviewResult["suggestion"], string>;

export function formatDetailedRoleCard(input: {
  contract: ContractCaseRecord;
  version: number;
  roleKey: RoleKey;
  owners: OwnerRecord[];
  result: ContractReviewResult;
  triggeredByName: string;
  reviewKindLabel: string;
  taskUrl?: string;
}): FeishuInteractiveCard {
  const { contract, version, roleKey, owners, result, triggeredByName, reviewKindLabel } = input;
  const actorLabel =
    reviewKindLabel === "修改完毕后复审" ? "最近一次提交人" : "本次提交人";
  return {
    config: { wide_screen_mode: true },
    header: {
      template: riskHeaderTemplates[result.risk_level],
      title: {
        tag: "plain_text",
        content: `合同 AI 审查｜${roleLabels[roleKey]}｜${contract.contractId} V${version}`
      }
    },
    elements: [
      {
        tag: "markdown",
        content: [
          `**负责人：${formatOwnerNames(owners)}**`,
          `**合同名称：${contract.documentTitle}**`,
          `**合同编号：${contract.contractId}**`,
          `**流程：${reviewKindLabel}**`,
          `**版本：V${version}**`,
          `**${actorLabel}：${triggeredByName}**`,
          formatContractLinkLine("打开 V" + version + " 合同", versionDocumentUrl(contract, version)),
          input.taskUrl ? `**任务与历史：[打开${roleLabels[roleKey]}任务](${input.taskUrl})**` : undefined,
          `**风险等级：${riskLabels[result.risk_level]}**`,
          `**处理建议：${suggestionLabels[result.suggestion]}**`,
          `**置信度：${Math.round(result.confidence * 100)}%**`,
          "",
          "**部门处理状态**",
          ...formatRoleStatusLines(contract),
          "",
          "详细审查建议已写入对应飞书任务。请点击下方按钮查看任务、合同和历史文件。"
        ].filter((line): line is string => line !== undefined).join("\n")
      }
      ,
      formatActionElement([
        input.taskUrl ? { label: "打开任务 / 历史", url: input.taskUrl, primary: true } : undefined,
        { label: "打开合同", url: versionDocumentUrl(contract, version) },
        contract.folderUrl ? { label: "合同文件夹", url: contract.folderUrl } : undefined
      ])
    ].filter((element): element is FeishuInteractiveCard["elements"][number] => Boolean(element))
  };
}

export function formatGeneralGroupCard(input: {
  contract: ContractCaseRecord;
  version: number;
  owners: OwnerGroups;
  results: Record<RoleKey, ContractReviewResult>;
  triggeredByName: string;
  reviewKindLabel: string;
  missingOwnerMessage?: string;
}): FeishuInteractiveCard {
  const {
    contract,
    version,
    owners,
    results,
    triggeredByName,
    reviewKindLabel,
    missingOwnerMessage
  } = input;
  const actorLabel =
    reviewKindLabel === "修改完毕后复审" ? "最近一次提交人" : "本次提交人";
  const activeResultRoleKeys = (Object.keys(results) as RoleKey[]).filter(
    (roleKey) => contract.roleStatuses?.[roleKey]?.status !== "completed"
  );
  const roleLines = activeResultRoleKeys.flatMap((roleKey, index) => {
    const result = results[roleKey];
    const firstFocus = result.must_focus[0];
    const lines = [
      `**${roleLabels[roleKey]}：${riskLabels[result.risk_level]}风险，${suggestionLabels[result.suggestion]}**`,
      firstFocus ? `- ${sanitize(firstFocus.title)}：${sanitize(firstFocus.detail)}` : undefined,
      result.actions[0] ? `- 建议：${sanitize(result.actions[0])}` : undefined
    ].filter((line): line is string => Boolean(line));

    return index === 0 ? lines : ["", ...lines];
  });

  const mentions = roleKeys
    .filter((roleKey) => contract.roleStatuses?.[roleKey]?.status !== "completed")
    .flatMap((roleKey) => owners[roleKey].map(formatAtMention))
    .join(" ");

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: `合同 AI 审查完成｜${contract.contractId} V${version}`
      }
    },
    elements: [
      {
        tag: "markdown",
        content: [
          mentions,
          "",
          `**合同名称：${contract.documentTitle}**`,
          `**合同编号：${contract.contractId}**`,
          `**流程：${reviewKindLabel}**`,
          `**版本：V${version}**`,
          `**${actorLabel}：${triggeredByName}**`,
          formatContractLinkLine("打开 V" + version + " 合同", versionDocumentUrl(contract, version)),
          contract.folderUrl ? `**版本文件夹：[查看合同归档](${contract.folderUrl})**` : undefined,
          "",
          "**部门处理状态**",
          ...formatRoleStatusLines(contract),
          "",
          "**各职能 general 建议**",
          ...(roleLines.length > 0
            ? roleLines
            : ["所有职能均已确认完成，本次不再生成新的部门提醒。"]),
          "",
          "详细建议已写入各职能任务；首次审查会私信任务入口，后续版本在同一任务内持续更新。",
          missingOwnerMessage ? `\n${missingOwnerMessage}` : undefined
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n")
      },
      formatActionElement([
        { label: "打开合同", url: versionDocumentUrl(contract, version), primary: true },
        contract.folderUrl ? { label: "查看历史文件", url: contract.folderUrl } : undefined
      ])
    ].filter((element): element is FeishuInteractiveCard["elements"][number] => Boolean(element))
  };
}

export function formatNoChangeCard(input: {
  contract: ContractCaseRecord;
  currentVersion: number;
  triggeredByName: string;
  reviewKindLabel: string;
}): FeishuInteractiveCard {
  const actorLabel =
    input.reviewKindLabel === "修改完毕后复审"
      ? "最近一次提交人"
      : "本次提交人";
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "green",
      title: {
        tag: "plain_text",
        content: `未生成新版本｜${input.contract.contractId}`
      }
    },
    elements: [
      {
        tag: "markdown",
        content: [
          `**合同名称：${input.contract.documentTitle}**`,
          `**流程：${input.reviewKindLabel}**`,
          `**当前版本：V${input.currentVersion}**`,
          `**${actorLabel}：${input.triggeredByName}**`,
          formatContractLinkLine("打开当前合同", input.contract.documentUrl),
          "",
          "**部门处理状态**",
          ...formatRoleStatusLines(input.contract),
          "",
          "机器人重新读取了飞书文档，但内容和上一次审查版本一致。",
          "本次只发送这张群内说明卡片，不创建新的审查版本，也不私信负责人。"
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n")
      },
      formatActionElement([
        { label: "打开合同", url: input.contract.documentUrl, primary: true },
        input.contract.folderUrl
          ? { label: "查看历史文件", url: input.contract.folderUrl }
          : undefined
      ])
    ].filter((element): element is FeishuInteractiveCard["elements"][number] => Boolean(element))
  };
}

export function formatRoleStatusCard(input: {
  contract: ContractCaseRecord;
  roleKey: RoleKey;
  completed: boolean;
  actorName: string;
}): FeishuInteractiveCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: input.completed ? "green" : "blue",
      title: {
        tag: "plain_text",
        content: `${roleLabels[input.roleKey]}${input.completed ? "已确认完成" : "已恢复处理"}｜${input.contract.contractId}`
      }
    },
    elements: [
      {
        tag: "markdown",
        content: [
          `**合同名称：${input.contract.documentTitle}**`,
          `**操作人：${input.actorName}**`,
          `**${roleLabels[input.roleKey]}状态：${input.completed ? "负责人已确认处理完成" : "处理中"}**`,
          "",
          input.completed
            ? `后续版本将不再给${roleLabels[input.roleKey]}负责人发送提醒，也不会继续向该职能任务追加版本建议。`
            : `后续版本会恢复向${roleLabels[input.roleKey]}负责人发送任务更新。`,
          "",
          "以上状态由负责人主动确认，不是 AI 判断。",
          "",
          "**全部部门状态**",
          ...formatRoleStatusLines(input.contract)
        ].join("\n")
      },
      formatActionElement([
        { label: "打开合同", url: input.contract.documentUrl, primary: true },
        input.contract.folderUrl
          ? { label: "查看历史文件", url: input.contract.folderUrl }
          : undefined
      ])
    ].filter((element): element is FeishuInteractiveCard["elements"][number] => Boolean(element))
  };
}

export function formatHelpText(botMentionName = "合同审批Bot"): string {
  const botAt = `@${botMentionName.replace(/^@/u, "").trim() || "合同审批Bot"}`;
  return [
    "合同审核群聊 Bot 使用方式：",
    "",
    "方式一：发送飞书文档链接（完整功能，推荐）",
    `${botAt} https://xxx.feishu.cn/docx/xxxx`,
    "目前只有飞书在线文档链接会作为可点击的合同链接使用。请先确认发到群里的飞书链接本身已经对本群成员可编辑。",
    "如果用户发的是飞书文档链接，群里的 general 卡片、负责人私信卡片、任务描述、任务评论和卡片按钮都会使用这一个飞书链接。",
    "同一份飞书文档第一次出现会按首次审查处理；之后再次发送同一份文档，会按修改后复审处理。",
    "",
    "方式二：回复群里的普通文件附件（基础功能）",
    `在回复框里输入：${botAt}`,
    "普通文件附件不会被机器人转换成飞书在线文档，也不会生成可点击的合同链接。",
    "机器人只会尽量读取附件里的文字并做基础审查；卡片、私信和任务里会显示“普通文件附件，不支持跳转链接”。",
    "支持：DOCX、部分文字型 PDF、TXT、Markdown、HTML。旧版 DOC 请先另存为 DOCX；扫描件或图片版 PDF 暂时不能识别。",
    "",
    "负责人确认本部门已处理完成：",
    `${botAt} HT-20260812-0001 商务已完成`,
    `${botAt} HT-20260812-0001 运营已完成`,
    `${botAt} HT-20260812-0001 法务已完成`,
    `${botAt} HT-20260812-0001 财务已完成`,
    "",
    "也可以回复该合同的群卡片，并省略合同编号，例如：",
    `${botAt} 财务已完成`,
    "确认后，后续版本不再提醒该部门。这个状态只由负责人确认，AI 不会自动判断。",
    "",
    "恢复本部门继续处理：",
    `${botAt} HT-20260812-0001 商务恢复处理`,
    `${botAt} HT-20260812-0001 运营恢复处理`,
    `${botAt} HT-20260812-0001 法务恢复处理`,
    `${botAt} HT-20260812-0001 财务恢复处理`,
    "",
    "回复该合同的群卡片时，也可以省略合同编号，例如：",
    `${botAt} 商务恢复处理`,
    `${botAt} 运营恢复处理`,
    `${botAt} 法务恢复处理`,
    `${botAt} 财务恢复处理`,
    "",
    "删除某一份合同的本地审查记录：",
    `${botAt} 删除记录 https://xxx.feishu.cn/docx/xxxx`,
    "",
    "删除后，机器人不会再记得这份合同之前审查过；下次再次发送同一飞书链接时，会按新合同重新首审。"
  ].join("\n");
}

function formatAtMention(owner: OwnerRecord): string {
  return owner.userId
    ? `<at id=${owner.userId}></at>`
    : `@${owner.displayName}`;
}

function formatOwnerNames(owners: OwnerRecord[]): string {
  const names = owners.filter((owner) => owner.userId).map((owner) => owner.displayName);
  return names.length > 0 ? names.join("、") : "未配置";
}

function formatRoleStatusLines(contract: ContractCaseRecord): string[] {
  return roleKeys.map((roleKey) => {
    const status = contract.roleStatuses?.[roleKey];
    if (status?.status === "completed") {
      const actor = status.completedByName ? `，由 ${status.completedByName} 确认` : "";
      const version = status.completedAtVersion ? `（V${status.completedAtVersion}）` : "";
      return `- ${roleLabels[roleKey]}：已确认完成${version}${actor}`;
    }
    return `- ${roleLabels[roleKey]}：处理中`;
  });
}

function versionDocumentUrl(contract: ContractCaseRecord, version: number): string {
  return contract.versions.find((item) => item.version === version)?.documentUrl ?? contract.documentUrl;
}

function formatContractLinkLine(label: string, url: string): string {
  if (/^https?:\/\//u.test(url)) return `**合同链接：[${label}](${url})**`;
  return `**合同链接：普通文件附件，不支持跳转链接**`;
}

function formatActionElement(
  actions: Array<{ label: string; url: string; primary?: boolean } | undefined>
): FeishuInteractiveCard["elements"][number] | undefined {
  const available = actions.filter(
    (action): action is { label: string; url: string; primary?: boolean } =>
      Boolean(action?.url && /^https?:\/\//u.test(action.url))
  );
  if (available.length === 0) return undefined;
  return {
    tag: "action",
    actions: available.map((action) => ({
      tag: "button",
      text: { tag: "plain_text", content: action.label },
      type: action.primary ? "primary" : "default",
      multi_url: {
        url: action.url,
        pc_url: action.url,
        ios_url: action.url,
        android_url: action.url
      }
    }))
  };
}

function sanitize(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/```/gu, "").trim();
}
