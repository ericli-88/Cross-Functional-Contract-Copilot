import * as lark from "@larksuiteoapi/node-sdk";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

import type { ChatMessageEvent } from "../domain/types.js";
import { logger } from "../logger.js";
import { parseChatMessageEvent } from "../chat/messageParsing.js";
import { silentLarkLogger } from "./sdkLogger.js";

interface MessageWorkflowPort {
  handleMessage(event: ChatMessageEvent): Promise<void>;
}

export interface MessageEventMiddlewareConfig {
  encryptKey?: string;
  verificationToken: string;
}

export function createMessageEventMiddleware(
  config: MessageEventMiddlewareConfig,
  workflow: MessageWorkflowPort
): RequestHandler {
  const dispatcher = new lark.EventDispatcher({
    verificationToken: config.verificationToken,
    logger: silentLarkLogger,
    ...(config.encryptKey ? { encryptKey: config.encryptKey } : {})
  }).register({
    "im.message.receive_v1": async (data: unknown) => {
      const event = parseChatMessageEvent(data);
      logger.info(
        {
          eventId: event.eventId,
          chatId: event.chatId,
          chatType: event.chatType,
          messageType: event.messageType,
          senderUserId: event.senderUserId,
          mentionCount: event.mentions.length,
          text: event.text
        },
        "parsed feishu message event"
      );
      runWorkflowInBackground(workflow, event);
      return {};
    }
  });

  const middleware = lark.adaptExpress(dispatcher, {
    autoChallenge: true
  });

  return async (req, res, next) => {
    // The SDK validates signatures only when encryptKey is configured. Always
    // verify the event token as well, including tokens inside encrypted payloads.
    if (!hasValidEventToken(req.body, config)) {
      res.status(403).json({ ok: false, error: "invalid_event_token" });
      return;
    }
    logger.info(
      {
        path: req.path,
        eventType: readEventType(req.body),
        hasChallenge: Boolean(readUrlVerificationChallenge(req.body, config.verificationToken))
      },
      "received feishu message callback"
    );

    const challenge = readUrlVerificationChallenge(req.body, config.verificationToken);
    if (challenge) {
      res.json({ challenge });
      return;
    }

    try {
      await middleware(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function hasValidEventToken(body: unknown, config: MessageEventMiddlewareConfig): boolean {
  try {
    if (!isRecord(body)) return false;
    let payload = body;
    if (typeof body.encrypt === "string") {
      if (!config.encryptKey) return false;
      const decoded: unknown = JSON.parse(new lark.AESCipher(config.encryptKey).decrypt(body.encrypt));
      if (!isRecord(decoded)) return false;
      payload = decoded;
    }
    const header = isRecord(payload.header) ? payload.header : undefined;
    const token = readString(header?.token) ?? readString(payload.token);
    if (!token) return false;
    const actual = Buffer.from(token);
    const expected = Buffer.from(config.verificationToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function runWorkflowInBackground(
  workflow: MessageWorkflowPort,
  event: ChatMessageEvent
): void {
  setImmediate(() => {
    void workflow.handleMessage(event).catch((error) => {
      logger.error(
        {
          err: error,
          eventId: event.eventId,
          messageId: event.messageId,
          chatId: event.chatId
        },
        "chat contract workflow failed"
      );
    });
  });
}

function readUrlVerificationChallenge(body: unknown, verificationToken: string): string | undefined {
  if (!isRecord(body)) return undefined;

  const rootToken = readString(body.token);
  const rootChallenge = readString(body.challenge);
  const rootType = readString(body.type);
  if (
    rootChallenge &&
    rootToken === verificationToken &&
    (!rootType || rootType === "url_verification")
  ) {
    return rootChallenge;
  }

  const header = isRecord(body.header) ? body.header : undefined;
  const event = isRecord(body.event) ? body.event : undefined;
  const eventType = readString(header?.event_type) ?? readString(body.event_type);
  const headerToken = readString(header?.token) ?? readString(body.token);
  const eventChallenge = readString(event?.challenge) ?? rootChallenge;
  if (
    eventChallenge &&
    headerToken === verificationToken &&
    eventType === "url_verification"
  ) {
    return eventChallenge;
  }

  return undefined;
}

function readEventType(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const header = isRecord(body.header) ? body.header : undefined;
  return readString(header?.event_type) ?? readString(body.event_type) ?? readString(body.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
