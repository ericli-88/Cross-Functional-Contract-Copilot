import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ChatWorkspaceRecord,
  ContractCaseRecord,
  ContractRoleStatusRecord,
  ContractVersionRecord,
  OwnerRecord,
  RoleTaskRecord,
  RoleKey
} from "../domain/types.js";

interface StoreState {
  contracts: ContractCaseRecord[];
  owners: Partial<Record<RoleKey, OwnerRecord>>;
  lastContractSequence: number;
  processedMessageEvents: MessageEventRecord[];
  chatWorkspaces: ChatWorkspaceRecord[];
}

const initialState: StoreState = {
  contracts: [],
  owners: {},
  lastContractSequence: 0,
  processedMessageEvents: [],
  chatWorkspaces: []
};

interface MessageEventRecord {
  eventId: string;
  messageId: string;
  chatId: string;
  status: "processing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export class ContractCaseStore {
  private readonly statePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.statePath = path.join(dataDir, "chat-bot-state.json");
  }

  async getOwner(roleKey: RoleKey): Promise<OwnerRecord | undefined> {
    const state = await this.readState();
    return state.owners[roleKey];
  }

  async listOwners(): Promise<Partial<Record<RoleKey, OwnerRecord>>> {
    const state = await this.readState();
    return state.owners;
  }

  async upsertOwner(owner: OwnerRecord): Promise<void> {
    await this.withMutation(async (state) => {
      state.owners[owner.roleKey] = owner;
      return state;
    });
  }

  async tryStartMessageEvent(input: {
    eventId: string;
    messageId: string;
    chatId: string;
  }): Promise<boolean> {
    let started = false;
    await this.withMutation(async (state) => {
      const existing = state.processedMessageEvents.find(
        (event) => event.eventId === input.eventId || event.messageId === input.messageId
      );
      if (existing) return state;

      const now = new Date().toISOString();
      state.processedMessageEvents.push({
        eventId: input.eventId,
        messageId: input.messageId,
        chatId: input.chatId,
        status: "processing",
        createdAt: now,
        updatedAt: now
      });
      state.processedMessageEvents = state.processedMessageEvents.slice(-500);
      started = true;
      return state;
    });

    return started;
  }

  async finishMessageEvent(
    eventId: string,
    status: "completed" | "failed",
    error?: string
  ): Promise<void> {
    await this.withMutation(async (state) => {
      const event = state.processedMessageEvents.find(
        (candidate) => candidate.eventId === eventId
      );
      if (!event) return state;

      event.status = status;
      event.updatedAt = new Date().toISOString();
      if (error) event.error = error;
      return state;
    });
  }

  async findByDocumentToken(documentType: string, documentToken: string): Promise<ContractCaseRecord | undefined> {
    const state = await this.readState();
    return state.contracts.find(
      (contract) =>
        (contract.documentType === documentType &&
          contract.documentToken === documentToken) ||
        contract.documentAliases?.some(
          (alias) =>
            alias.documentType === documentType && alias.documentToken === documentToken
        )
    );
  }

  async findByDocumentTokenInChat(
    chatId: string,
    documentType: string,
    documentToken: string
  ): Promise<ContractCaseRecord | undefined> {
    const state = await this.readState();
    return state.contracts.find(
      (contract) =>
        contract.chatId === chatId &&
        ((contract.documentType === documentType &&
          contract.documentToken === documentToken) ||
          contract.documentAliases?.some(
            (alias) =>
              alias.documentType === documentType && alias.documentToken === documentToken
          ))
    );
  }

  async findBySourceKey(chatId: string, sourceKey: string): Promise<ContractCaseRecord | undefined> {
    const state = await this.readState();
    return state.contracts.find(
      (contract) => contract.chatId === chatId && contract.sourceKeys?.includes(sourceKey)
    );
  }

  async findByRelatedMessageId(
    chatId: string,
    messageId: string
  ): Promise<ContractCaseRecord | undefined> {
    const state = await this.readState();
    return state.contracts.find(
      (contract) =>
        contract.chatId === chatId &&
        (contract.latestGroupCardMessageId === messageId ||
          contract.sourceMessageIds?.includes(messageId) ||
          contract.versions.some((version) =>
            [version.messageId, version.sourceMessageId].includes(messageId)
          ))
    );
  }

  async findByContractId(
    chatId: string,
    contractId: string
  ): Promise<ContractCaseRecord | undefined> {
    const state = await this.readState();
    return state.contracts.find(
      (contract) =>
        contract.chatId === chatId &&
        contract.contractId.toUpperCase() === contractId.toUpperCase()
    );
  }

  async findLatestContractInChat(chatId: string): Promise<ContractCaseRecord | undefined> {
    const state = await this.readState();
    return state.contracts
      .filter((contract) => contract.chatId === chatId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  async listContractsInChat(chatId: string): Promise<ContractCaseRecord[]> {
    const state = await this.readState();
    return state.contracts.filter((contract) => contract.chatId === chatId);
  }

  async listContracts(): Promise<ContractCaseRecord[]> {
    const state = await this.readState();
    return state.contracts;
  }

  async deleteByDocumentToken(
    documentType: string,
    documentToken: string,
    chatId?: string
  ): Promise<ContractCaseRecord | undefined> {
    let deleted: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const index = state.contracts.findIndex(
        (contract) =>
          (!chatId || contract.chatId === chatId) &&
          ((contract.documentType === documentType &&
            contract.documentToken === documentToken) ||
            contract.documentAliases?.some(
              (alias) =>
                alias.documentType === documentType &&
                alias.documentToken === documentToken
            ))
      );
      if (index === -1) return state;

      const [record] = state.contracts.splice(index, 1);
      deleted = record;
      return state;
    });

    return deleted;
  }

  async createContract(input: {
    chatId: string;
    documentType: ContractCaseRecord["documentType"];
    documentToken: string;
    documentUrl: string;
    documentTitle: string;
    createdByUserId?: string;
  }): Promise<ContractCaseRecord> {
    let created: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const existing = state.contracts.find(
        (contract) =>
          contract.chatId === input.chatId &&
          contract.documentType === input.documentType &&
          contract.documentToken === input.documentToken
      );
      if (existing) {
        created = existing;
        return state;
      }

      state.lastContractSequence += 1;
      const contractId = formatContractId(state.lastContractSequence);
      created = {
        contractId,
        chatId: input.chatId,
        documentType: input.documentType,
        documentToken: input.documentToken,
        documentUrl: input.documentUrl,
        documentTitle: input.documentTitle,
        createdAt: new Date().toISOString(),
        createdByUserId: input.createdByUserId,
        latestVersion: 0,
        versions: [],
        sourceKeys: [],
        sourceMessageIds: [],
        documentAliases: [
          {
            documentType: input.documentType,
            documentToken: input.documentToken
          }
        ],
        roleTasks: {},
        roleStatuses: {}
      };
      state.contracts.push(created);
      return state;
    });

    if (!created) throw new Error("Contract creation did not produce a record");
    return created;
  }

  async appendVersion(
    contractId: string,
    version: ContractVersionRecord
  ): Promise<ContractCaseRecord> {
    let updated: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const contract = state.contracts.find((candidate) => candidate.contractId === contractId);
      if (!contract) throw new Error(`Contract not found: ${contractId}`);

      contract.versions.push(version);
      contract.latestVersion = Math.max(contract.latestVersion, version.version);
      updated = contract;
      return state;
    });

    if (!updated) throw new Error("Version append did not produce a record");
    return updated;
  }

  async updateVersion(
    contractId: string,
    versionNumber: number,
    patch: Partial<ContractVersionRecord>
  ): Promise<ContractCaseRecord> {
    let updated: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const contract = state.contracts.find((candidate) => candidate.contractId === contractId);
      if (!contract) throw new Error(`Contract not found: ${contractId}`);
      const version = contract.versions.find((candidate) => candidate.version === versionNumber);
      if (!version) {
        throw new Error(`Contract version not found: ${contractId} v${versionNumber}`);
      }

      Object.assign(version, patch);
      updated = contract;
      return state;
    });

    if (!updated) throw new Error("Version update did not produce a record");
    return updated;
  }

  async updateContract(
    contractId: string,
    patch: Partial<ContractCaseRecord>
  ): Promise<ContractCaseRecord> {
    let updated: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const contract = state.contracts.find((candidate) => candidate.contractId === contractId);
      if (!contract) throw new Error(`Contract not found: ${contractId}`);
      Object.assign(contract, patch);
      updated = contract;
      return state;
    });
    if (!updated) throw new Error("Contract update did not produce a record");
    return updated;
  }

  async addContractSource(input: {
    contractId: string;
    sourceKey?: string;
    sourceMessageId?: string;
    documentAlias?: {
      documentType: "docx" | "docs" | "file";
      documentToken: string;
    };
  }): Promise<ContractCaseRecord> {
    let updated: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const contract = state.contracts.find((candidate) => candidate.contractId === input.contractId);
      if (!contract) throw new Error(`Contract not found: ${input.contractId}`);

      contract.sourceKeys = appendUnique(contract.sourceKeys, input.sourceKey);
      contract.sourceMessageIds = appendUnique(
        contract.sourceMessageIds,
        input.sourceMessageId
      );
      if (input.documentAlias) {
        const aliases = contract.documentAliases ?? [];
        if (!aliases.some(
          (alias) =>
            alias.documentType === input.documentAlias?.documentType &&
            alias.documentToken === input.documentAlias.documentToken
        )) {
          aliases.push(input.documentAlias);
        }
        contract.documentAliases = aliases;
      }
      updated = contract;
      return state;
    });
    if (!updated) throw new Error("Contract source update did not produce a record");
    return updated;
  }

  async getChatWorkspace(chatId: string): Promise<ChatWorkspaceRecord | undefined> {
    const state = await this.readState();
    return state.chatWorkspaces.find((workspace) => workspace.chatId === chatId);
  }

  async upsertChatWorkspace(workspace: ChatWorkspaceRecord): Promise<void> {
    await this.withMutation(async (state) => {
      const index = state.chatWorkspaces.findIndex(
        (candidate) => candidate.chatId === workspace.chatId
      );
      if (index >= 0) state.chatWorkspaces[index] = workspace;
      else state.chatWorkspaces.push(workspace);
      return state;
    });
  }

  async setRoleTask(
    contractId: string,
    roleKey: RoleKey,
    task: RoleTaskRecord
  ): Promise<ContractCaseRecord> {
    let updated: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const contract = state.contracts.find((candidate) => candidate.contractId === contractId);
      if (!contract) throw new Error(`Contract not found: ${contractId}`);
      contract.roleTasks ??= {};
      contract.roleTasks[roleKey] = task;
      updated = contract;
      return state;
    });
    if (!updated) throw new Error("Role task update did not produce a record");
    return updated;
  }

  async deleteRoleTask(
    contractId: string,
    roleKey: RoleKey
  ): Promise<ContractCaseRecord> {
    let updated: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const contract = state.contracts.find((candidate) => candidate.contractId === contractId);
      if (!contract) throw new Error(`Contract not found: ${contractId}`);
      if (contract.roleTasks) delete contract.roleTasks[roleKey];
      updated = contract;
      return state;
    });
    if (!updated) throw new Error("Role task deletion did not produce a record");
    return updated;
  }

  async setRoleStatus(
    contractId: string,
    roleKey: RoleKey,
    status: ContractRoleStatusRecord
  ): Promise<ContractCaseRecord> {
    let updated: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const contract = state.contracts.find((candidate) => candidate.contractId === contractId);
      if (!contract) throw new Error(`Contract not found: ${contractId}`);
      contract.roleStatuses ??= {};
      contract.roleStatuses[roleKey] = status;
      const roleTask = contract.roleTasks?.[roleKey];
      if (roleTask) {
        roleTask.status = status.status;
        roleTask.completedAt = status.completedAt;
        roleTask.completedByUserId = status.completedByUserId;
        roleTask.completedByName = status.completedByName;
        roleTask.completedAtVersion = status.completedAtVersion;
      }
      updated = contract;
      return state;
    });
    if (!updated) throw new Error("Role status update did not produce a record");
    return updated;
  }

  private async readState(): Promise<StoreState> {
    try {
      const contents = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(stripUtf8Bom(contents)) as StoreState;
      return {
        contracts: Array.isArray(parsed.contracts)
          ? parsed.contracts.map(migrateContractRecord)
          : [],
        owners: parsed.owners ?? {},
        lastContractSequence:
          typeof parsed.lastContractSequence === "number"
            ? parsed.lastContractSequence
            : 0,
        processedMessageEvents: Array.isArray(parsed.processedMessageEvents)
          ? parsed.processedMessageEvents
          : [],
        chatWorkspaces: Array.isArray(parsed.chatWorkspaces)
          ? parsed.chatWorkspaces
          : []
      };
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return {
          contracts: [],
          owners: {},
          lastContractSequence: 0,
          processedMessageEvents: [],
          chatWorkspaces: []
        };
      }
      throw error;
    }
  }

  private async writeState(state: StoreState): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const tempPath = path.join(this.dataDir, `.chat-bot-state.${randomUUID()}.tmp`);
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, this.statePath);
  }

  private async withMutation(operation: (state: StoreState) => Promise<StoreState> | StoreState): Promise<void> {
    const previous = this.mutationQueue;
    let release: () => void = () => undefined;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const state = await this.readState();
      await this.writeState(await operation(state));
    } finally {
      release();
    }
  }
}

function appendUnique(values: string[] | undefined, value: string | undefined): string[] {
  const result = values ? [...values] : [];
  if (value && !result.includes(value)) result.push(value);
  return result;
}

function migrateContractRecord(contract: ContractCaseRecord): ContractCaseRecord {
  const versions = Array.isArray(contract.versions)
    ? contract.versions.map((version) => ({
        ...version,
        documentToken: version.documentToken ?? contract.documentToken,
        documentUrl: version.documentUrl ?? contract.documentUrl,
        documentTitle: version.documentTitle ?? contract.documentTitle
      }))
    : [];
  const aliases = contract.documentAliases?.length
    ? [...contract.documentAliases]
    : [{ documentType: contract.documentType, documentToken: contract.documentToken }];
  const sourceKeys = contract.sourceKeys ? [...contract.sourceKeys] : [];
  if (contract.documentType === "file" && sourceKeys.length === 0) {
    sourceKeys.push(makeLegacyAttachmentSourceKey(contract.chatId, contract.documentTitle));
  }
  const sourceMessageIds = contract.sourceMessageIds
    ? [...contract.sourceMessageIds]
    : versions
        .flatMap((version) => [version.sourceMessageId, version.messageId])
        .filter((value): value is string => Boolean(value));
  const roleTasks = contract.roleTasks ?? {};
  const roleStatuses = { ...(contract.roleStatuses ?? {}) };
  for (const [roleKey, task] of Object.entries(roleTasks) as Array<
    [RoleKey, RoleTaskRecord]
  >) {
    if (!roleStatuses[roleKey] && task.status === "completed") {
      roleStatuses[roleKey] = {
        status: "completed",
        completedAt: task.completedAt,
        completedByUserId: task.completedByUserId,
        completedByName: task.completedByName,
        completedAtVersion: task.completedAtVersion
      };
    }
  }
  return {
    ...contract,
    versions,
    sourceKeys: [...new Set(sourceKeys)],
    sourceMessageIds: [...new Set(sourceMessageIds)],
    documentAliases: aliases,
    roleTasks,
    roleStatuses
  };
}

function makeLegacyAttachmentSourceKey(chatId: string, fileName: string): string {
  const normalizedName = fileName
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.(docx?|txt|md|markdown|html?)$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return `attachment:${chatId}:${normalizedName || fileName.toLowerCase()}`;
}

function stripUtf8Bom(contents: string): string {
  return contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
}

function formatContractId(sequence: number): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `HT-${yyyy}${mm}${dd}-${String(sequence).padStart(4, "0")}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}
