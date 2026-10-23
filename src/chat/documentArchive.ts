import type { ChatWorkspaceRecord, ContractCaseRecord } from "../domain/types.js";
import type { FeishuClient, ImportedFeishuDocument } from "../feishu/feishuClient.js";
import { logger } from "../logger.js";
import type { ContractCaseStore } from "./contractCaseStore.js";

export interface DocumentArchiveOptions {
  enabled: boolean;
  rootFolderToken: string;
}

export class DocumentArchive {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: DocumentArchiveOptions,
    private readonly store: ContractCaseStore,
    private readonly feishu: FeishuClient
  ) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  async prepareLinkedDocument(input: {
    contract: ContractCaseRecord;
    documentType: "docx" | "docs";
    documentToken: string;
    version: number;
  }): Promise<{
    contract: ContractCaseRecord;
    feishuVersionId?: string;
    warnings: string[];
  }> {
    if (!this.options.enabled) return { contract: input.contract, warnings: [] };

    return this.serial(async () => {
      let contract = input.contract;
      const warnings: string[] = [];

      try {
        contract = await this.ensureContractFolder(input.contract);
      } catch (error) {
        logger.warn(
          { err: error, contractId: input.contract.contractId },
          "linked feishu document archive folder setup failed; continuing review"
        );
        warnings.push("未能创建或更新本群合同归档文件夹");
      }

      try {
        await this.feishu.setTenantEditable(input.documentToken, input.documentType);
      } catch (error) {
        logger.warn(
          {
            err: error,
            contractId: contract.contractId,
            documentToken: input.documentToken,
            documentType: input.documentType
          },
          "linked feishu document tenant-editable update failed; continuing review"
        );
        warnings.push("未能自动把原飞书链接设置为企业内可编辑，请确认群里发送的链接本身已可编辑");
      }

      if (!contract.shortcutCreated && contract.folderToken) {
        try {
          await this.feishu.createDocumentShortcut({
            documentToken: input.documentToken,
            documentType: input.documentType,
            parentFolderToken: contract.folderToken
          });
          contract = await this.store.updateContract(contract.contractId, {
            shortcutCreated: true
          });
        } catch (error) {
          logger.warn(
            { err: error, contractId: contract.contractId, documentToken: input.documentToken },
            "linked feishu document shortcut creation failed; continuing review"
          );
          warnings.push("未能把原飞书链接创建为合同文件夹快捷方式");
        }
      }

      let feishuVersionId: string | undefined;
      if (input.documentType === "docx") {
        try {
          feishuVersionId = await this.feishu.createDocumentVersion({
            documentToken: input.documentToken,
            name: `${contract.contractId} V${input.version} 审查快照`
          });
        } catch (error) {
          logger.warn(
            { err: error, contractId: contract.contractId, documentToken: input.documentToken },
            "linked feishu document version snapshot creation failed; continuing review"
          );
          warnings.push("未能为原飞书链接创建版本快照");
        }
      }

      return { contract, feishuVersionId, warnings };
    });
  }

  async importAttachment(input: {
    contract: ContractCaseRecord;
    fileName: string;
    fileExtension: string;
    data: Buffer;
    version: number;
  }): Promise<{
    contract: ContractCaseRecord;
    imported: ImportedFeishuDocument;
  }> {
    if (!this.options.enabled) {
      throw new Error(
        "文件转飞书在线文档功能当前未启用。请把 FEISHU_DOCUMENT_ARCHIVE_ENABLED 设置为 true 并重启机器人。"
      );
    }

    return this.serial(async () => {
      const contract = await this.ensureContractFolder(input.contract);
      if (!contract.folderToken) {
        throw new Error("合同文件夹未成功创建，无法导入附件");
      }
      const imported = await this.feishu.importFileAsDocx({
        fileName: input.fileName,
        fileExtension: input.fileExtension,
        data: input.data,
        folderToken: contract.folderToken,
        documentTitle: `${contract.contractId} V${input.version} ${stripExtension(input.fileName)}`
      });
      await this.feishu.setTenantEditable(imported.documentToken, "docx");
      return { contract, imported };
    });
  }

  async removeDuplicateImportedDocument(documentToken: string): Promise<void> {
    await this.feishu.deleteDriveFile(documentToken, "docx").catch((error) => {
      logger.warn(
        { err: error, documentToken },
        "failed to remove unchanged imported document duplicate"
      );
    });
  }

  async ensureChatWorkspace(chatId: string): Promise<ChatWorkspaceRecord> {
    return this.serial(() => this.ensureChatWorkspaceUnlocked(chatId));
  }

  private async ensureContractFolder(
    inputContract: ContractCaseRecord
  ): Promise<ContractCaseRecord> {
    let contract = inputContract;
    const workspace = await this.ensureChatWorkspaceUnlocked(contract.chatId);

    if (!contract.folderToken) {
      const created = await this.feishu.createFolder(
        sanitizeFolderName(`${contract.contractId} ${contract.documentTitle}`),
        workspace.folderToken
      );
      contract = await this.store.updateContract(contract.contractId, {
        folderToken: created.folderToken,
        folderUrl: created.folderUrl
      });
    }
    return contract;
  }

  private async ensureChatWorkspaceUnlocked(chatId: string): Promise<ChatWorkspaceRecord> {
    let workspace = await this.store.getChatWorkspace(chatId);
    if (workspace?.folderName === "合同") return workspace;

    const created = await this.feishu.createFolder(
      "合同",
      this.options.rootFolderToken
    );
    await this.feishu.grantChatFolderFullAccess(created.folderToken, chatId);
    workspace = {
      chatId,
      folderToken: created.folderToken,
      folderName: "合同",
      folderUrl: created.folderUrl,
      createdAt: new Date().toISOString()
    };
    await this.store.upsertChatWorkspace(workspace);
    return workspace;
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: () => void = () => undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function sanitizeFolderName(value: string): string {
  const clean = value.replace(/[\\/:*?"<>|\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  return clean.slice(0, 120) || "合同审核";
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, "").trim() || "合同";
}
