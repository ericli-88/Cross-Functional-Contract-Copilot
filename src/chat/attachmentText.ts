import JSZip from "jszip";
import { inflateSync } from "node:zlib";

import type { ContractText } from "../domain/types.js";

const textExtensions = new Set([".txt", ".md", ".markdown", ".html", ".htm"]);
const importOnlyExtensions = new Set([".doc"]);

export function isSupportedContractAttachment(fileName: string): boolean {
  const extension = getLowerExtension(fileName);
  return extension === ".docx" || extension === ".pdf" || textExtensions.has(extension) || importOnlyExtensions.has(extension);
}

export function isPdfAttachment(fileName: string): boolean {
  return getLowerExtension(fileName) === ".pdf";
}

export function getContractAttachmentExtension(fileName: string): string {
  return getLowerExtension(fileName).replace(/^\./u, "");
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

  if (extension === ".pdf") {
    return {
      fileName: input.fileName,
      text: extractPdfText(input.data),
      extractionWarnings: ["Read text from replied Feishu PDF file attachment"]
    };
  }

  if (importOnlyExtensions.has(extension)) {
    throw new Error(
      "旧版 .doc 普通附件暂时无法直接抽取文字；请另存为 .docx，或发送飞书在线文档链接。机器人不会把普通附件转换成飞书在线文档。"
    );
  }

  throw new Error(
    `Unsupported replied file type: ${input.fileName}. Supported attachments: .doc, .docx, .pdf, .txt, .md, .markdown, .html`
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

function extractPdfText(data: Buffer): string {
  const sections: string[] = [];
  const latin = data.toString("latin1");
  const streamPattern = /<<(.*?)>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/giu;
  for (const match of latin.matchAll(streamPattern)) {
    const dictionary = match[1] ?? "";
    const rawStream = Buffer.from(match[2] ?? "", "latin1");
    const stream = /\/Filter\s*\/FlateDecode/u.test(dictionary)
      ? inflatePdfStream(rawStream)
      : rawStream;
    if (!stream) continue;
    const text = extractPdfTextOperators(stream.toString("latin1"));
    if (text) sections.push(text);
  }

  const combined = sections
    .join("\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!combined) {
    throw new Error("这份 PDF 没有可直接抽取的文字；如果它是扫描件或图片版 PDF，当前机器人无法 OCR 识别。请发送文字型 PDF、.docx，或飞书在线文档链接。");
  }
  return combined;
}

function inflatePdfStream(stream: Buffer): Buffer | undefined {
  const trimmed = trimPdfStreamBoundaries(stream);
  try {
    return inflateSync(trimmed);
  } catch {
    try {
      return inflateSync(stream);
    } catch {
      return undefined;
    }
  }
}

function trimPdfStreamBoundaries(stream: Buffer): Buffer {
  let start = 0;
  let end = stream.length;
  while (start < end && (stream[start] === 0x0a || stream[start] === 0x0d)) start += 1;
  while (end > start && (stream[end - 1] === 0x0a || stream[end - 1] === 0x0d)) end -= 1;
  return stream.subarray(start, end);
}

function extractPdfTextOperators(content: string): string {
  const parts: string[] = [];
  const textBlockPattern = /BT([\s\S]*?)ET/giu;
  for (const blockMatch of content.matchAll(textBlockPattern)) {
    const block = blockMatch[1] ?? "";
    for (const arrayMatch of block.matchAll(/\[((?:\s*(?:\((?:\\.|[^\\)])*\)|<[\da-f\s]+>|-?\d+(?:\.\d+)?))+\s*)\]\s*TJ/giu)) {
      const arrayText = extractPdfStrings(arrayMatch[1] ?? "").join("");
      if (arrayText) parts.push(arrayText);
    }
    for (const stringMatch of block.matchAll(/(\((?:\\.|[^\\)])*\)|<[\da-f\s]+>)\s*(?:'|"|Tj)/giu)) {
      const value = decodePdfStringToken(stringMatch[1] ?? "");
      if (value) parts.push(value);
    }
  }
  return parts.join("\n").trim();
}

function extractPdfStrings(value: string): string[] {
  const parts: string[] = [];
  for (const match of value.matchAll(/\((?:\\.|[^\\)])*\)|<[\da-f\s]+>/giu)) {
    const decoded = decodePdfStringToken(match[0]);
    if (decoded) parts.push(decoded);
  }
  return parts;
}

function decodePdfStringToken(token: string): string {
  if (token.startsWith("<") && token.endsWith(">")) {
    return decodePdfHexString(token.slice(1, -1));
  }
  return decodePdfLiteralString(token.slice(1, -1));
}

function decodePdfHexString(value: string): string {
  const hex = value.replace(/\s+/gu, "");
  if (!hex) return "";
  const normalized = hex.length % 2 === 0 ? hex : `${hex}0`;
  const bytes = Buffer.from(normalized, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.toString("utf16le").replace(/\u0000/gu, "");
  }
  return bytes.toString("utf8").replace(/\u0000/gu, "").trim();
}

function decodePdfLiteralString(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/gu, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "(":
      case ")":
      case "\\":
        return escaped;
      default:
        return String.fromCharCode(Number.parseInt(escaped, 8));
    }
  }).trim();
}
