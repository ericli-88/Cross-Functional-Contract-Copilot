import type { ContractCaseRecord, OwnerRecord, RoleKey } from "../domain/types.js";
import { roleLabels } from "../domain/types.js";
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
  elements: Array<{
    tag: "markdown";
    content: string;
  }>;
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
  owner: OwnerRecord;
  result: ContractReviewResult;
  triggeredByName: string;
  reviewKindLabel: string;
}): FeishuInteractiveCard {
  const { contract, version, roleKey, owner, result, triggeredByName, reviewKindLabel } = input;
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
          `**负责人：${owner.displayName}**`,
          `**合同名称：${contract.documentTitle}**`,
          `**合同编号：${contract.contractId}**`,
          `**流程：${reviewKindLabel}**`,
          `**版本：V${version}**`,
          `**${actorLabel}：${triggeredByName}**`,
          `**合同链接：${contract.documentUrl}**`,
          `**风险等级：${riskLabels[result.risk_level]}**`,
          `**处理建议：${suggestionLabels[result.suggestion]}**`,
          `**置信度：${Math.round(result.confidence * 100)}%**`,
          "",
          "**必须关注**",
          ...result.must_focus.map((item, index) => {
            return `${index + 1}. **${sanitize(item.title)}**：${sanitize(item.detail)}`;
          }),
          "",
          "**建议动作 / 修改建议**",
          ...result.actions.map((action, index) => `${index + 1}. ${sanitize(action)}`),
          "",
          "**审批提示**",
          ...result.tips.map((tip, index) => `${index + 1}. ${sanitize(tip)}`)
        ].join("\n")
      }
    ]
  };
}

export function formatGeneralGroupCard(input: {
  contract: ContractCaseRecord;
  version: number;
  owners: Record<RoleKey, OwnerRecord>;
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
  const roleLines = (Object.keys(results) as RoleKey[]).flatMap((roleKey, index) => {
    const result = results[roleKey];
    const firstFocus = result.must_focus[0];
    const lines = [
      `**${roleLabels[roleKey]}：${riskLabels[result.risk_level]}风险，${suggestionLabels[result.suggestion]}**`,
      firstFocus ? `- ${sanitize(firstFocus.title)}：${sanitize(firstFocus.detail)}` : undefined,
      result.actions[0] ? `- 建议：${sanitize(result.actions[0])}` : undefined
    ].filter((line): line is string => Boolean(line));

    return index === 0 ? lines : ["", ...lines];
  });

  const mentions = (Object.keys(owners) as RoleKey[])
    .map((roleKey) => formatAtMention(owners[roleKey]))
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
          `**合同链接：${contract.documentUrl}**`,
          "",
          "**各职能 general 建议**",
          ...roleLines,
          "",
          "详细建议已分别私信给已配置 user_id 的负责人。",
          missingOwnerMessage ? `\n${missingOwnerMessage}` : undefined
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n")
      }
    ]
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
          `**合同链接：${input.contract.documentUrl}**`,
          "",
          "机器人重新读取了飞书文档，但内容和上一次审查版本一致。",
          "本次只发送这张群内说明卡片，不创建新的审查版本，也不私信负责人。"
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n")
      }
    ]
  };
}

export function formatHelpText(botMentionName = "合同机器人"): string {
  const botAt = `@${botMentionName.replace(/^@/u, "").trim() || "合同机器人"}`;
  return [
    "合同审核群聊 Bot 使用方式：",
    "",
    "合同审查 / 复审：",
    `${botAt} https://xxx.feishu.cn/docx/xxxx`,
    "同一份文档第一次出现会首审，之后每次出现都会按修改完毕后复审处理。",
    "",
    "删除某一份合同的本地审查记录：",
    `${botAt} 删除记录 https://xxx.feishu.cn/docx/xxxx`,
    "删除后，机器人不会再记得这份合同之前审查过；下次再次发送同一链接时，会按新合同重新首审。"
  ].join("\n");
}

function formatAtMention(owner: OwnerRecord): string {
  return owner.userId
    ? `<at id=${owner.userId}></at>`
    : `@${owner.displayName}`;
}

function sanitize(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/```/gu, "").trim();
}
