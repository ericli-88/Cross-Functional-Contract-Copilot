import type { DocumentReference } from "../domain/types.js";

const feishuDocumentUrlPattern =
  /https?:\/\/[^\s<>"'，。；、)）\]]+\/(?<type>docx|docs|wiki)\/(?<token>[A-Za-z0-9_-]+)/giu;

export function extractFirstDocumentReference(text: string): DocumentReference | undefined {
  for (const match of text.matchAll(feishuDocumentUrlPattern)) {
    const groups = match.groups;
    const url = match[0];
    const type = groups?.type;
    const token = groups?.token;
    if ((type === "docx" || type === "docs" || type === "wiki") && token) {
      return { url, type, token };
    }
  }

  return undefined;
}

export function normalizeDocumentIdentity(document: DocumentReference): string {
  return `${document.type}:${document.token}`;
}
