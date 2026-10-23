import iconv from "iconv-lite";
import type { ChatMessageEvent } from "../domain/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getPath(input: unknown, path: string[]): unknown {
  let current = input;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function parseFeishuContentText(messageType: string, rawContent: unknown): string {
  let parsed: unknown;
  if (typeof rawContent === "string") {
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return rawContent;
    }
  } else {
    parsed = rawContent;
  }

  if (!isRecord(parsed)) return "";

  if (messageType === "text") {
    return repairLikelyMojibake(
      readNonBlankString(parsed.text) ?? collectTextFragments(parsed).join(" ").trim()
    );
  }

  if (messageType === "post") {
    return repairLikelyMojibake(flattenPostContent(parsed.content));
  }

  return repairLikelyMojibake(collectTextFragments(parsed).join(" ").trim());
}

function flattenPostContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    for (const item of row) {
      if (!isRecord(item)) continue;
      parts.push(...collectTextFragments(item));
    }
  }

  return parts.join(" ").trim();
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    const text = readNonBlankString(value);
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFragments(item));
  }

  if (!isRecord(value)) return [];

  const preferredKeys = ["text", "name", "title", "href", "url", "link"];
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const key of preferredKeys) {
    const text = readNonBlankString(value[key]);
    if (text && !seen.has(text)) {
      parts.push(text);
      seen.add(text);
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (preferredKeys.includes(key)) continue;
    for (const text of collectTextFragments(nested)) {
      if (!seen.has(text)) {
        parts.push(text);
        seen.add(text);
      }
    }
  }

  return parts;
}

function parseMentions(rawMentions: unknown): ChatMessageEvent["mentions"] {
  if (!Array.isArray(rawMentions)) return [];

  return rawMentions
    .filter(isRecord)
    .map((mention) => {
      const id = isRecord(mention.id) ? mention.id : {};
      return {
        key: readNonBlankString(mention.key),
        name: readNonBlankString(mention.name),
        userId: readNonBlankString(id.user_id)
      };
    });
}

export function parseChatMessageEvent(raw: unknown): ChatMessageEvent {
  const eventBody = findEventBody(raw);
  const eventId =
    readNonBlankString(getPath(raw, ["header", "event_id"])) ??
    readNonBlankString(getPath(eventBody, ["header", "event_id"])) ??
    readNonBlankString(getPath(raw, ["event_id"])) ??
    readNonBlankString(getPath(eventBody, ["event_id"])) ??
    readNonBlankString(getPath(raw, ["uuid"])) ??
    readNonBlankString(getPath(eventBody, ["uuid"]));
  if (!eventId) {
    throw new Error("Feishu message event does not contain event_id");
  }

  const message =
    getPath(raw, ["event", "message"]) ??
    getPath(raw, ["message"]) ??
    getPath(raw, ["data", "event", "message"]) ??
    getPath(raw, ["data", "message"]) ??
    getPath(eventBody, ["message"]);
  if (!isRecord(message)) {
    throw new Error(
      `Feishu message event does not contain message; top-level keys: ${summarizeKeys(raw)}; event keys: ${summarizeKeys(eventBody)}`
    );
  }

  const messageId = readNonBlankString(message.message_id);
  const chatId = readNonBlankString(message.chat_id);
  const messageType = readNonBlankString(message.message_type) ?? "unknown";
  if (!messageId || !chatId) {
    throw new Error("Feishu message event does not contain message_id or chat_id");
  }

  const senderId =
    getPath(raw, ["event", "sender", "sender_id"]) ??
    getPath(raw, ["sender", "sender_id"]) ??
    getPath(raw, ["data", "event", "sender", "sender_id"]) ??
    getPath(raw, ["data", "sender", "sender_id"]) ??
    getPath(eventBody, ["sender", "sender_id"]);
  const senderUserId = readNonBlankString(getPath(senderId, ["user_id"]));
  const senderUnionId = readNonBlankString(getPath(senderId, ["union_id"]));

  return {
    eventId,
    messageId,
    chatId,
    chatType: readNonBlankString(message.chat_type),
    messageType,
    parentMessageId: readNonBlankString(message.parent_id),
    rootMessageId: readNonBlankString(message.root_id),
    text: parseFeishuContentText(messageType, message.content),
    senderUserId,
    senderUnionId,
    mentions: parseMentions(message.mentions),
    raw
  };
}

function findEventBody(raw: unknown): unknown {
  const nestedEvent = getPath(raw, ["event"]);
  if (isRecord(nestedEvent)) return nestedEvent;

  const nestedDataEvent = getPath(raw, ["data", "event"]);
  if (isRecord(nestedDataEvent)) return nestedDataEvent;

  const nestedData = getPath(raw, ["data"]);
  if (isRecord(nestedData)) return nestedData;

  return raw;
}

function summarizeKeys(value: unknown): string {
  return isRecord(value) ? Object.keys(value).join(",") : "(not object)";
}

function repairLikelyMojibake(text: string): string {
  if (!looksLikeChineseMojibake(text)) return text;

  const repaired = iconv
    .decode(iconv.encode(text, "gb18030"), "utf8")
    .replace(/\uFFFD/gu, "")
    .trim();

  return scoreUsefulChinese(repaired) >= scoreUsefulChinese(text) ? repaired : text;
}

function looksLikeChineseMojibake(text: string): boolean {
  return chineseMojibakeMarkers.some((marker) => marker.length > 0 && text.includes(marker));
}

const chineseMojibakeMarkers = [
  "\u6211\u662f",
  "\u5ba1\u67e5",
  "\u5408\u540c",
  "\u673a\u5668\u4eba",
  "\u8d1f\u8d23\u4eba",
  "\u4fee\u6539",
  "\u5e2e\u52a9",
  "\u8c03\u8bd5",
  "\u600e\u4e48"
].map(toGb18030Mojibake);

function toGb18030Mojibake(value: string): string {
  return iconv.decode(Buffer.from(value, "utf8"), "gb18030").replace(/\uFFFD/gu, "");
}

function scoreUsefulChinese(text: string): number {
  const keywords = [
    "我是",
    "谁",
    "审查",
    "审核",
    "合同",
    "修改",
    "复审",
    "负责人",
    "商务",
    "运营",
    "法务",
    "财务",
    "帮助",
    "调试"
  ];
  return keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);
}
