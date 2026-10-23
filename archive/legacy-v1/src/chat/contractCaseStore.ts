import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ContractCaseRecord,
  ContractVersionRecord,
  OwnerRecord,
  RoleKey
} from "../domain/types.js";

interface StoreState {
  contracts: ContractCaseRecord[];
  owners: Partial<Record<RoleKey, OwnerRecord>>;
  lastContractSequence: number;
  processedMessageEvents: MessageEventRecord[];
}

const initialState: StoreState = {
  contracts: [],
  owners: {},
  lastContractSequence: 0,
  processedMessageEvents: []
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
        contract.documentType === documentType &&
        contract.documentToken === documentToken
    );
  }

  async deleteByDocumentToken(
    documentType: string,
    documentToken: string
  ): Promise<ContractCaseRecord | undefined> {
    let deleted: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const index = state.contracts.findIndex(
        (contract) =>
          contract.documentType === documentType &&
          contract.documentToken === documentToken
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
    documentType: "docx" | "docs";
    documentToken: string;
    documentUrl: string;
    documentTitle: string;
    createdByUserId?: string;
  }): Promise<ContractCaseRecord> {
    let created: ContractCaseRecord | undefined;
    await this.withMutation(async (state) => {
      const existing = state.contracts.find(
        (contract) =>
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
        versions: []
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

  private async readState(): Promise<StoreState> {
    try {
      const contents = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(stripUtf8Bom(contents)) as StoreState;
      return {
        contracts: Array.isArray(parsed.contracts) ? parsed.contracts : [],
        owners: parsed.owners ?? {},
        lastContractSequence:
          typeof parsed.lastContractSequence === "number"
            ? parsed.lastContractSequence
            : 0,
        processedMessageEvents: Array.isArray(parsed.processedMessageEvents)
          ? parsed.processedMessageEvents
          : []
      };
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return {
          contracts: [],
          owners: {},
          lastContractSequence: 0,
          processedMessageEvents: []
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
