import JSZip from "jszip";

import type { ContractText } from "../domain/types.js";

const textExtensions = new Set([".txt", ".md", ".csv"]);

export function isSupportedContractAttachment(fileName: string): boolean {
  const extension = getLowerExtension(fileName);
  return extension === ".docx" || textExtensions.has(extension);
}

export async function extractContractTextFromAttachment(input: {
  fileName: string;
  data: Buffer;
}): Promise<ContractText> {
  const extension = getLowerExtension(input.fileName);
  if (extension === ".docx") {
    return {
      fileName: input.fileName,
      text: await extractDocxText(input.data),
      extractionWarnings: ["Read from replied Feishu .docx file attachment"]
    };
  }

  if (textExtensions.has(extension)) {
    return {
      fileName: input.fileName,
      text: input.data.toString("utf8").trim(),
      extractionWarnings: ["Read from replied Feishu text file attachment"]
    };
  }

  throw new Error(
    `Unsupported replied file type: ${input.fileName}. Supported attachments: .docx, .txt, .md, .csv`
  );
}

function getLowerExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLowerCase() : "";
}

async function extractDocxText(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) {
    throw new Error("The replied .docx file did not contain word/document.xml");
  }

  const xmlPaths = [
    "word/document.xml",
    ...Object.keys(zip.files)
      .filter((name) => /^word\/(?:header|footer)\d+\.xml$/u.test(name))
      .sort()
  ];

  const sections: string[] = [];
  for (const xmlPath of xmlPaths) {
    const file = zip.file(xmlPath);
    if (!file) continue;
    const xml = await file.async("string");
    const text = extractTextFromWordXml(xml);
    if (text) sections.push(text);
  }

  const combined = sections.join("\n\n").trim();
  if (!combined) {
    throw new Error("The replied .docx file did not contain extractable text");
  }
  return combined;
}

function extractTextFromWordXml(xml: string): string {
  const parts: string[] = [];
  const tokenPattern =
    /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>/giu;

  for (const match of xml.matchAll(tokenPattern)) {
    const token = match[0];
    if (match[1] !== undefined) {
      parts.push(decodeXmlEntities(match[1]));
    } else if (/^<w:tab\b/iu.test(token)) {
      parts.push("\t");
    } else {
      parts.push("\n");
    }
  }

  return parts
    .join("")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/giu, (entity, decimal, hex) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        return entity;
    }
  });
}
