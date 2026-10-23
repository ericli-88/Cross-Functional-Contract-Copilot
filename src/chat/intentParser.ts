import type { RoleKey } from "../domain/types.js";
import { extractFirstDocumentReference } from "./documentLinks.js";

export type ChatIntent =
  | { kind: "register_owner"; roleKey: RoleKey }
  | { kind: "register_all_owners" }
  | { kind: "whoami" }
  | { kind: "initial_review"; documentUrl: string; documentToken: string; documentType: "docx" | "docs" | "wiki" }
  | { kind: "revision_done"; documentUrl: string; documentToken: string; documentType: "docx" | "docs" | "wiki" }
  | { kind: "delete_contract_record"; documentUrl: string; documentToken: string; documentType: "docx" | "docs" | "wiki" }
  | {
      kind: "set_role_completion";
      roleKey?: RoleKey;
      contractId?: string;
      documentUrl?: string;
      documentToken?: string;
      documentType?: "docx" | "docs" | "wiki";
      completed: boolean;
    }
  | { kind: "help" }
  | { kind: "ignore" };

const registrationPatterns: Array<[RoleKey, RegExp]> = [
  ["commercial", /我是\s*商务负责人|我是\s*商务|注册\s*商务/u],
  ["operations", /我是\s*运营负责人|我是\s*运营|注册\s*运营/u],
  ["legal", /我是\s*法务负责人|我是\s*法务|注册\s*法务/u],
  ["finance", /我是\s*财务负责人|我是\s*财务|注册\s*财务/u]
];

export function parseChatIntent(text: string): ChatIntent {
  const normalized = stripAtMentions(text).replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return { kind: "ignore" };

  for (const [roleKey, pattern] of registrationPatterns) {
    if (pattern.test(normalized)) return { kind: "register_owner", roleKey };
  }

  if (/我是\s*全部负责|我是\s*所有负责|测试模式|把\s*负责人?\s*设成我/u.test(normalized)) {
    return { kind: "register_all_owners" };
  }

  if (
    /我是谁|我的\s*(?:open_?id|user_?id|id)|查看.*id|调试信息|debug/u.test(normalized) ||
    isLikelyWhoAmI(normalized)
  ) {
    return { kind: "whoami" };
  }

  if (/帮助|help|怎么用/u.test(normalized)) {
    return { kind: "help" };
  }

  const completion = parseRoleCompletion(normalized);
  if (completion) return completion;

  const document = extractFirstDocumentReference(normalized);
  if (!document) {
    if (/审查|审核|预审|修改完毕|修改好了|已修改|更新|复审|删除|清除|清空|重置|移除/u.test(normalized)) {
      return { kind: "help" };
    }
    return { kind: "ignore" };
  }

  if (/删除.*(?:合同)?记录|清除.*(?:合同)?记录|清空.*(?:合同)?记录|移除.*(?:合同)?记录|重置.*(?:合同)?记录|忘记.*(?:这份|该份)?合同/u.test(normalized)) {
    return {
      kind: "delete_contract_record",
      documentUrl: document.url,
      documentToken: document.token,
      documentType: document.type
    };
  }

  if (/修改完毕|修改好了|已修改|更新完成|改完了|复审|重新审查/u.test(normalized)) {
    return {
      kind: "revision_done",
      documentUrl: document.url,
      documentToken: document.token,
      documentType: document.type
    };
  }

  return {
    kind: "initial_review",
    documentUrl: document.url,
    documentToken: document.token,
    documentType: document.type
  };
}

function parseRoleCompletion(
  text: string
): Extract<ChatIntent, { kind: "set_role_completion" }> | undefined {
  const completed = /(?:已完成|完成处理|处理完成|确认完成)/u.test(text);
  const reopened = /(?:恢复处理|重新打开|继续处理|撤销完成)/u.test(text);
  if (!completed && !reopened) return undefined;

  const roleKey = registrationPatterns.find(([, pattern]) => pattern.test(`我是${text}`))?.[0]
    ?? findRoleKey(text);
  const contractId = text.match(/HT-\d{8}-\d{4}/iu)?.[0]?.toUpperCase();
  const document = extractFirstDocumentReference(text);
  return {
    kind: "set_role_completion",
    ...(roleKey ? { roleKey } : {}),
    ...(contractId ? { contractId } : {}),
    ...(document
      ? {
          documentUrl: document.url,
          documentToken: document.token,
          documentType: document.type
        }
      : {}),
    completed: !reopened
  };
}

function findRoleKey(text: string): RoleKey | undefined {
  if (/商务/u.test(text)) return "commercial";
  if (/运营/u.test(text)) return "operations";
  if (/法务/u.test(text)) return "legal";
  if (/财务/u.test(text)) return "finance";
  return undefined;
}

function stripAtMentions(text: string): string {
  return text.replace(/<at\b[^>]*>.*?<\/at>/giu, " ").replace(/@_user_\d+/gu, " ");
}

function isLikelyWhoAmI(text: string): boolean {
  const compact = text.replace(/\s+/gu, "");
  if (!compact.startsWith("我是")) return false;
  if (/商务|运营|法务|财务|全部|所有|负责|测试模式/u.test(compact)) return false;
  return compact.length <= 8;
}
