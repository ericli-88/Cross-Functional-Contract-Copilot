import assert from "node:assert/strict";

import { FeishuClient } from "../dist/src/feishu/feishuClient.js";

const calls = [];
const record = (name, response) => async (payload) => {
  calls.push({ name, payload });
  return typeof response === "function" ? response(payload) : response;
};

const fakeSdk = {
  drive: {
    file: {
      createFolder: record("createFolder", {
        code: 0,
        data: { token: "folder_contracts", url: "https://example.feishu.cn/drive/folder/folder_contracts" }
      }),
      createShortcut: record("createShortcut", { code: 0, data: {} })
    },
    permissionMember: {
      create: record("grantChatFolder", { code: 0, data: {} })
    },
    permissionPublic: {
      patch: record("setTenantEditable", { code: 0, data: {} })
    },
    media: {
      uploadAll: record("uploadImportMedia", { file_token: "uploaded_file_token" })
    },
    importTask: {
      create: record("createImportTask", { code: 0, data: { ticket: "import_ticket" } }),
      get: record("getImportTask", {
        code: 0,
        data: {
          result: {
            job_status: 0,
            token: "imported_docx_token",
            url: "https://example.feishu.cn/docx/imported_docx_token"
          }
        }
      })
    },
    fileVersion: {
      create: record("createDocumentVersion", { code: 0, data: { version: "version_1" } })
    }
  },
  task: {
    v2: {
      task: {
        create: record("createTask", {
          code: 0,
          data: {
            task: {
              guid: "task_guid",
              url: "https://example.feishu.cn/task/task_guid"
            }
          }
        }),
        patch: record("patchTask", { code: 0, data: {} }),
        delete: record("deleteTask", { code: 0, data: {} }),
        get: record("getTask", {
          code: 0,
          data: {
            task: {
              completed_at: "0",
              url: "https://example.feishu.cn/task/task_guid"
            }
          }
        })
      },
      comment: {
        create: record("createTaskComment", { code: 0, data: {} })
      }
    }
  }
};

const client = new FeishuClient({
  appId: "cli_test",
  appSecret: "test_secret",
  verificationToken: "test_token"
});
client.client = fakeSdk;

const folder = await client.createFolder("合同审核 - 测试群", "root_folder");
assert.equal(folder.folderToken, "folder_contracts");
assert.deepEqual(call("createFolder").payload, {
  data: { name: "合同审核 - 测试群", folder_token: "root_folder" }
});

await client.grantChatFolderFullAccess("folder_contracts", "oc_test_chat");
assert.deepEqual(call("grantChatFolder").payload, {
  data: {
    member_type: "openchat",
    member_id: "oc_test_chat",
    perm: "full_access",
    type: "chat"
  },
  params: { type: "folder", need_notification: false },
  path: { token: "folder_contracts" }
});

const imported = await client.importFileAsDocx({
  fileName: "contract.docx",
  fileExtension: "docx",
  data: Buffer.from("contract"),
  folderToken: "folder_contracts",
  documentTitle: "HT-TEST V1 contract"
});
assert.equal(imported.documentToken, "imported_docx_token");
assert.equal(call("uploadImportMedia").payload.data.parent_type, "ccm_import_open");
assert.equal(call("uploadImportMedia").payload.data.parent_node, "");
assert.deepEqual(JSON.parse(call("uploadImportMedia").payload.data.extra), {
  obj_type: "docx",
  file_extension: "docx"
});
assert.deepEqual(call("createImportTask").payload.data.point, {
  mount_type: 1,
  mount_key: "folder_contracts"
});
assert.equal(call("createImportTask").payload.data.type, "docx");

await client.setTenantEditable("imported_docx_token");
assert.deepEqual(call("setTenantEditable").payload, {
  data: { link_share_entity: "tenant_editable" },
  params: { type: "docx" },
  path: { token: "imported_docx_token" }
});

await client.createDocumentShortcut({
  documentToken: "source_docx",
  documentType: "docx",
  parentFolderToken: "folder_contracts"
});
assert.deepEqual(call("createShortcut").payload.data, {
  parent_token: "folder_contracts",
  refer_entity: { refer_token: "source_docx", refer_type: "docx" }
});

assert.equal(
  await client.createDocumentVersion({ documentToken: "source_docx", name: "HT-TEST V1 审查快照" }),
  "version_1"
);
assert.deepEqual(call("createDocumentVersion").payload, {
  data: { name: "HT-TEST V1 审查快照", obj_type: "docx" },
  params: { user_id_type: "user_id" },
  path: { file_token: "source_docx" }
});

const task = await client.createTask({
  summary: "[财务] HT-TEST contract",
  description: "V1 财务建议",
  assigneeUserIds: ["finance_1", "finance_2"],
  clientToken: "HT-TEST-finance",
  contractUrl: imported.documentUrl
});
assert.equal(task.taskGuid, "task_guid");
const createTaskPayload = call("createTask").payload;
assert.equal(createTaskPayload.params.user_id_type, "user_id");
assert.equal(createTaskPayload.data.client_token, "HT-TEST-finance");
assert.deepEqual(createTaskPayload.data.members, [
  { id: "finance_1", type: "user", role: "assignee" },
  { id: "finance_2", type: "user", role: "assignee" }
]);
assert.equal(createTaskPayload.data.origin.href.url, imported.documentUrl);

await client.addTaskComment("task_guid", "HT-TEST V1 完整建议");
assert.deepEqual(call("createTaskComment").payload.data, {
  content: "HT-TEST V1 完整建议",
  resource_type: "task",
  resource_id: "task_guid"
});

await client.updateTask({ taskGuid: "task_guid", completedAt: "0" });
assert.deepEqual(call("patchTask").payload.data, {
  task: { completed_at: "0" },
  update_fields: ["completed_at"]
});

const remoteTask = await client.getTask("task_guid");
assert.equal(remoteTask.completedAt, "0");
assert.equal(remoteTask.taskUrl, "https://example.feishu.cn/task/task_guid");

await client.deleteTask("task_guid");
assert.deepEqual(call("deleteTask").payload, {
  path: { task_guid: "task_guid" }
});

function call(name) {
  const result = calls.find((item) => item.name === name);
  assert.ok(result, `missing SDK call: ${name}`);
  return result;
}

console.log("feishu API contract tests passed");
