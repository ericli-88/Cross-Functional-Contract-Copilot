export const roleKeys = ["commercial", "operations", "legal", "finance"] as const;
export type RoleKey = (typeof roleKeys)[number];

export const roleLabels = {
  commercial: "商务",
  operations: "运营",
  legal: "法务",
  finance: "财务"
} satisfies Record<RoleKey, string>;

export const roleNodeNames = {
  commercial: "商务审批",
  operations: "运营审批",
  legal: "法务审批",
  finance: "财务审批"
} satisfies Record<RoleKey, string>;

export const riskLevels = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof riskLevels)[number];

export const reviewSuggestions = [
  "suggest_approve",
  "supplement_required",
  "manual_review"
] as const;
export type ReviewSuggestion = (typeof reviewSuggestions)[number];

export interface ReviewProfile {
  key: RoleKey;
  nodeName: string;
  title: string;
  reviewerRole: string;
  skillReferences: string[];
  focusAreas: string[];
}

export interface ContractText {
  fileName: string;
  text: string;
  extractionWarnings: string[];
}

export interface ChatContractReviewInput {
  contractId: string;
  version: number;
  documentTitle: string;
  documentUrl: string;
  documentToken: string;
  triggeredByName?: string;
  contract: ContractText;
  reviewProfile: ReviewProfile;
}

export interface OwnerRecord {
  roleKey: RoleKey;
  roleLabel: string;
  displayName: string;
  userId?: string;
  registeredAt?: string;
  source: "env" | "chat_registration" | "missing";
}

export type OwnerGroups = Record<RoleKey, OwnerRecord[]>;

export interface ChatWorkspaceRecord {
  chatId: string;
  folderToken: string;
  folderName?: string;
  folderUrl?: string;
  createdAt: string;
}

export interface RoleTaskRecord {
  roleKey: RoleKey;
  taskGuid: string;
  taskUrl?: string;
  status: "active" | "completed";
  createdAt: string;
  completedAt?: string;
  completedByUserId?: string;
  completedByName?: string;
  completedAtVersion?: number;
}

export interface ContractRoleStatusRecord {
  status: "active" | "completed";
  completedAt?: string;
  completedByUserId?: string;
  completedByName?: string;
  completedAtVersion?: number;
}

export interface ChatMessageEvent {
  eventId: string;
  messageId: string;
  parentMessageId?: string;
  rootMessageId?: string;
  chatId: string;
  chatType?: string;
  messageType: string;
  text: string;
  senderUserId?: string;
  senderUnionId?: string;
  mentions: Array<{
    key?: string;
    name?: string;
    userId?: string;
  }>;
  raw: unknown;
}

export interface DocumentReference {
  url: string;
  token: string;
  type: "docx" | "docs" | "wiki";
}

export interface ContractVersionRecord {
  version: number;
  status: "started" | "completed" | "failed" | "skipped";
  intent: "initial_review" | "revision_done";
  contentHash: string;
  textLength: number;
  triggeredByUserId?: string;
  triggeredByName?: string;
  messageId: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
  roleResults?: Partial<Record<RoleKey, unknown>>;
  documentToken?: string;
  documentUrl?: string;
  documentTitle?: string;
  feishuVersionId?: string;
  sourceMessageId?: string;
}

export interface ContractCaseRecord {
  contractId: string;
  chatId: string;
  documentToken: string;
  documentType: "docx" | "docs" | "file";
  documentUrl: string;
  documentTitle: string;
  createdAt: string;
  createdByUserId?: string;
  latestVersion: number;
  versions: ContractVersionRecord[];
  sourceKeys?: string[];
  sourceMessageIds?: string[];
  documentAliases?: Array<{
    documentType: "docx" | "docs" | "file";
    documentToken: string;
  }>;
  folderToken?: string;
  folderUrl?: string;
  shortcutCreated?: boolean;
  roleTasks?: Partial<Record<RoleKey, RoleTaskRecord>>;
  roleStatuses?: Partial<Record<RoleKey, ContractRoleStatusRecord>>;
  latestGroupCardMessageId?: string;
}
