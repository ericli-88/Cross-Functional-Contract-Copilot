import express from "express";
import { pinoHttp } from "pino-http";

import type { ChatMessageEvent } from "./domain/types.js";
import { createMessageEventMiddleware } from "./feishu/messageEventMiddleware.js";
import { logger } from "./logger.js";

interface WorkflowPort {
  handleMessage(event: ChatMessageEvent): Promise<void>;
}

interface CreateAppDeps {
  workflow: WorkflowPort;
  feishu: {
    encryptKey?: string;
    verificationToken: string;
  };
}

export function createApp(deps: CreateAppDeps) {
  const app = express();

  app.use(pinoHttp({ logger }));
  app.get("/healthz", healthz);
  app.post("/healthz", healthz);
  app.post(
    "/feishu/events",
    express.json({ limit: "5mb" }),
    createMessageEventMiddleware(deps.feishu, deps.workflow)
  );

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      logger.error({ err: error }, "request failed");
      res.status(500).json({
        ok: false,
        error: "internal_error"
      });
    }
  );

  return app;
}

function healthz(_req: express.Request, res: express.Response): void {
  res.json({ ok: true });
}
