import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContractCaseStore } from "../dist/src/chat/contractCaseStore.js";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "contract-bot-migration-"));
try {
  const oldContract = {
    contractId: "HT-20260801-0001",
    chatId: "oc_old_chat",
    documentType: "file",
    documentToken: "om_old_file:file_key",
    documentUrl: "Feishu file attachment: old contract.docx",
    documentTitle: "Old Contract.docx",
    createdByUserId: "old_user",
    createdByName: "旧提交人",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    latestVersion: 1,
    latestContentHash: "old_hash",
    versions: [
      {
        version: 1,
        messageId: "om_old_trigger",
        triggeredByUserId: "old_user",
        triggeredByName: "旧提交人",
        reviewKind: "initial",
        contentHash: "old_hash",
        reviewedAt: "2026-08-01T00:00:00.000Z",
        results: {}
      }
    ]
  };
  await writeFile(
    path.join(dataDir, "chat-bot-state.json"),
    JSON.stringify({
      contracts: [oldContract],
      owners: {},
      lastContractSequence: 1,
      processedMessageEvents: []
    }),
    "utf8"
  );

  const store = new ContractCaseStore(dataDir);
  const migrated = await store.findBySourceKey(
    "oc_old_chat",
    "attachment:oc_old_chat:old contract"
  );
  assert.equal(migrated?.contractId, oldContract.contractId);
  assert.deepEqual(migrated?.documentAliases, [
    { documentType: "file", documentToken: "om_old_file:file_key" }
  ]);
  assert.equal(migrated?.versions[0]?.documentToken, "om_old_file:file_key");
  assert.equal(
    migrated?.versions[0]?.documentUrl,
    "Feishu file attachment: old contract.docx"
  );
  assert.ok(migrated?.sourceMessageIds.includes("om_old_trigger"));

  await store.upsertChatWorkspace({
    chatId: "oc_old_chat",
    folderToken: "folder_old_chat",
    folderUrl: "https://example.feishu.cn/drive/folder/folder_old_chat",
    createdAt: "2026-08-12T00:00:00.000Z"
  });

  const persisted = JSON.parse(
    await readFile(path.join(dataDir, "chat-bot-state.json"), "utf8")
  );
  assert.equal(persisted.contracts.length, 1);
  assert.equal(persisted.contracts[0].contractId, oldContract.contractId);
  assert.equal(persisted.chatWorkspaces.length, 1);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

console.log("store migration tests passed");
