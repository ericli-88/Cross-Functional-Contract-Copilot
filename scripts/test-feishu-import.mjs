import "dotenv/config";

import { readFileSync } from "node:fs";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import JSZip from "jszip";

import { loadConfig } from "../dist/src/config.js";
import { extractMissingScopes } from "../dist/src/feishu/feishuErrors.js";
import { silentLarkLogger } from "../dist/src/feishu/sdkLogger.js";

const config = loadConfig();

const client = new lark.Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  logger: silentLarkLogger,
  appType: lark.AppType.SelfBuild
});

const result = {
  ok: false,
  startedAt: new Date().toISOString(),
  config: {
    archiveEnabled: config.documentArchive.enabled,
    rootFolderTokenConfigured: Boolean(config.documentArchive.rootFolderToken),
    sourceExtension: process.env.DIAGNOSE_IMPORT_EXTENSION ?? "txt",
    targetType: process.env.DIAGNOSE_IMPORT_TARGET_TYPE ?? "docx",
    uploadMode: process.env.DIAGNOSE_IMPORT_UPLOAD_MODE ?? "file"
  },
  steps: {},
  cleanup: []
};

function recordStep(name, status, details = {}) {
  result.steps[name] = { status, ...details };
}

function compactResponse(response) {
  return JSON.parse(JSON.stringify(response, (_key, value) => {
    if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength}]`;
    if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength}]`;
    return value;
  }));
}

function readFileToken(uploadResponse) {
  return (
    uploadResponse?.file_token ??
    uploadResponse?.data?.file_token ??
    uploadResponse?.data?.data?.file_token
  );
}

function readTicket(createResponse) {
  return (
    createResponse?.data?.ticket ??
    createResponse?.data?.data?.ticket ??
    createResponse?.ticket
  );
}

function readImportResult(queryResponse) {
  return (
    queryResponse?.data?.result ??
    queryResponse?.data?.data?.result ??
    queryResponse?.result
  );
}

function readImportedToken(importResult) {
  return importResult?.token ?? importResult?.file_token ?? importResult?.obj_token;
}

function readImportedUrl(importResult) {
  return importResult?.url ?? importResult?.document_url;
}

function assertCodeZero(response, operation) {
  if (typeof response?.code === "number" && response.code !== 0) {
    const error = new Error(`${operation} failed: code=${response.code}, msg=${response.msg ?? ""}`);
    error.response = { data: response };
    throw error;
  }
}

async function main() {
  if (!config.documentArchive.enabled) {
    throw new Error("FEISHU_DOCUMENT_ARCHIVE_ENABLED is not true");
  }

  let tempFolderToken;
  let sourceFileToken;
  let importedDocumentToken;

  try {
    const createFolderResponse = await client.drive.file.createFolder({
      data: {
        name: `Codex import smoke ${Date.now()}`,
        folder_token: config.documentArchive.rootFolderToken
      }
    });
    assertCodeZero(createFolderResponse, "create temporary folder");
    tempFolderToken = createFolderResponse?.data?.token;
    recordStep("create_temporary_folder", "pass", {
      folderTokenPresent: Boolean(tempFolderToken),
      raw: compactResponse(createFolderResponse)
    });
    if (!tempFolderToken) throw new Error("create folder response did not contain folder token");

    const requestedSourceExtension = process.env.DIAGNOSE_IMPORT_EXTENSION ?? "txt";
    const targetType = process.env.DIAGNOSE_IMPORT_TARGET_TYPE ?? "docx";
    const source = process.env.DIAGNOSE_IMPORT_FILE_PATH
      ? makeSourceFileFromPath(process.env.DIAGNOSE_IMPORT_FILE_PATH, requestedSourceExtension)
      : await makeSourceFile(requestedSourceExtension);
    const sourceExtension = source.fileExtension;
    const uploadMode = process.env.DIAGNOSE_IMPORT_UPLOAD_MODE ?? "file";
    const uploadResponse =
      uploadMode === "media"
        ? await client.drive.media.uploadAll({
            data: {
              file_name: source.fileName,
              parent_type: "ccm_import_open",
              parent_node: "",
              size: source.data.byteLength,
              extra: JSON.stringify({
                obj_type: targetType,
                file_extension: sourceExtension
              }),
              file: source.data
            }
          })
        : await client.drive.file.uploadAll({
            data: {
              file_name: source.fileName,
              parent_type: "explorer",
              parent_node: tempFolderToken,
              size: source.data.byteLength,
              file: source.data
            }
          });
    assertCodeZero(uploadResponse, "upload source media");
    const fileToken = readFileToken(uploadResponse);
    sourceFileToken = uploadMode === "file" ? fileToken : undefined;
    recordStep("upload_source_media", "pass", {
      fileTokenPresent: Boolean(fileToken),
      raw: compactResponse(uploadResponse)
    });
    if (!fileToken) throw new Error("upload response did not contain file_token");

    const createImportResponse = await client.drive.importTask.create({
      data: {
        file_extension: sourceExtension,
        file_token: fileToken,
        type: targetType,
        file_name: process.env.DIAGNOSE_IMPORT_FILE_NAME_WITH_EXTENSION === "1"
          ? `Codex import smoke doc ${Date.now()}.${sourceExtension}`
          : `Codex import smoke doc ${Date.now()}`,
        point: {
          mount_type: 1,
          mount_key: tempFolderToken
        }
      }
    });
    assertCodeZero(createImportResponse, "create import task");
    const ticket = readTicket(createImportResponse);
    recordStep("create_import_task", "pass", {
      ticketPresent: Boolean(ticket),
      raw: compactResponse(createImportResponse)
    });
    if (!ticket) throw new Error("import task create response did not contain ticket");

    let finalImportResult;
    const pollResponses = [];
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      if (attempt > 1) await delay(1000);
      const queryResponse = await client.drive.importTask.get({ path: { ticket } });
      assertCodeZero(queryResponse, "query import task");
      const importResult = readImportResult(queryResponse);
      pollResponses.push({
        attempt,
        jobStatus: importResult?.job_status,
        jobErrorMsg: importResult?.job_error_msg,
        tokenPresent: Boolean(readImportedToken(importResult)),
        urlPresent: Boolean(readImportedUrl(importResult)),
        raw: compactResponse(queryResponse)
      });
      if (importResult?.job_status === 2) {
        finalImportResult = importResult;
        break;
      }
      if (importResult?.job_status === 0 && readImportedToken(importResult)) {
        finalImportResult = importResult;
        break;
      }
    }
    recordStep("query_import_task", finalImportResult?.job_status === 0 ? "pass" : "fail", {
      finalJobStatus: finalImportResult?.job_status,
      finalJobErrorMsg: finalImportResult?.job_error_msg,
      importedTokenPresent: Boolean(readImportedToken(finalImportResult)),
      importedUrl: readImportedUrl(finalImportResult) ?? null,
      pollResponses
    });
    if (finalImportResult?.job_status !== 0) {
      throw new Error(`import task did not succeed: ${finalImportResult?.job_error_msg ?? "unknown import error"}`);
    }
    importedDocumentToken = readImportedToken(finalImportResult);
    if (!importedDocumentToken) throw new Error("successful import result did not contain document token");

    const permissionResponse = await client.drive.permissionPublic.patch({
      data: { link_share_entity: "tenant_editable" },
      params: { type: targetType === "doc" ? "doc" : "docx" },
      path: { token: importedDocumentToken }
    });
    assertCodeZero(permissionResponse, "set imported document tenant editable");
    recordStep("set_tenant_editable", "pass", {
      raw: compactResponse(permissionResponse)
    });

    result.ok = true;
    result.importedDocument = {
      token: importedDocumentToken,
      url: readImportedUrl(finalImportResult) ?? null
    };
  } catch (error) {
    result.error = {
      message: error instanceof Error ? error.message : String(error),
      missingScopes: extractMissingScopes(error),
      responseData: error?.response?.data ? compactResponse(error.response.data) : undefined
    };
  } finally {
    if (importedDocumentToken) {
      try {
        const deleteDocResponse = await client.drive.file.delete({
          params: { type: result.config.targetType === "doc" ? "doc" : "docx", async: false },
          path: { file_token: importedDocumentToken }
        });
        result.cleanup.push({
          target: "imported_docx",
          status: "pass",
          raw: compactResponse(deleteDocResponse)
        });
      } catch (error) {
        result.cleanup.push({
          target: "imported_docx",
          status: "fail",
          message: error instanceof Error ? error.message : String(error),
          responseData: error?.response?.data ? compactResponse(error.response.data) : undefined
        });
      }
    }
    if (sourceFileToken) {
      try {
        const deleteSourceFileResponse = await client.drive.file.delete({
          params: { type: "file", async: false },
          path: { file_token: sourceFileToken }
        });
        result.cleanup.push({
          target: "source_file",
          status: "pass",
          raw: compactResponse(deleteSourceFileResponse)
        });
      } catch (error) {
        result.cleanup.push({
          target: "source_file",
          status: "fail",
          message: error instanceof Error ? error.message : String(error),
          responseData: error?.response?.data ? compactResponse(error.response.data) : undefined
        });
      }
    }
    if (tempFolderToken) {
      try {
        const deleteFolderResponse = await client.drive.file.delete({
          params: { type: "folder", async: false },
          path: { file_token: tempFolderToken }
        });
        result.cleanup.push({
          target: "temporary_folder",
          status: "pass",
          raw: compactResponse(deleteFolderResponse)
        });
      } catch (error) {
        result.cleanup.push({
          target: "temporary_folder",
          status: "fail",
          message: error instanceof Error ? error.message : String(error),
          responseData: error?.response?.data ? compactResponse(error.response.data) : undefined
        });
      }
    }
    result.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSourceFileFromPath(filePath, fallbackExtension) {
  const extension = path.extname(filePath).replace(/^\./u, "") || fallbackExtension;
  result.config.sourceExtension = extension;
  return {
    fileName: path.basename(filePath),
    fileExtension: extension,
    data: readFileSync(filePath)
  };
}

async function makeSourceFile(extension) {
  const text = [
    "Contract import smoke test",
    "",
    "Party A: Test Company",
    "Party B: Vendor",
    "Payment term: 30 days.",
    "This file should be imported into an editable Feishu document."
  ].join("\n");

  if (extension === "md" || extension === "markdown") {
    return {
      fileName: `codex-import-smoke.${extension}`,
      fileExtension: extension,
      data: Buffer.from(`# ${text}`, "utf8")
    };
  }

  if (extension === "html") {
    return {
      fileName: "codex-import-smoke.html",
      fileExtension: "html",
      data: Buffer.from(
        `<!doctype html><html><body><h1>Contract import smoke test</h1><p>${text}</p></body></html>`,
        "utf8"
      )
    };
  }

  if (extension === "docx") {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
    zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
    zip.folder("word")?.file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Contract import smoke test</w:t></w:r></w:p>
    <w:p><w:r><w:t>Party A: Test Company</w:t></w:r></w:p>
    <w:p><w:r><w:t>Party B: Vendor</w:t></w:r></w:p>
    <w:p><w:r><w:t>Payment term: 30 days.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`);
    return {
      fileName: "codex-import-smoke.docx",
      fileExtension: "docx",
      data: await zip.generateAsync({ type: "nodebuffer" })
    };
  }

  return {
    fileName: `codex-import-smoke.${extension}`,
    fileExtension: extension,
    data: Buffer.from(text, "utf8")
  };
}

await main();
