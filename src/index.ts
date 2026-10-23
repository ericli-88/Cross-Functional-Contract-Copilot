import dotenv from "dotenv";

dotenv.config({ override: true });

import { createApp } from "./app.js";
import { ContractCaseStore } from "./chat/contractCaseStore.js";
import {
  ContractChatWorkflow,
  makeContractChatWorkflowOptions
} from "./chat/contractChatWorkflow.js";
import { loadConfig } from "./config.js";
import { FeishuClient } from "./feishu/feishuClient.js";
import { logger } from "./logger.js";
import { reviewWithClaude } from "./review/claudeReviewer.js";

const config = loadConfig();
const feishu = new FeishuClient(config.feishu);
const store = new ContractCaseStore(config.dataDir);

const workflow = new ContractChatWorkflow(
  makeContractChatWorkflowOptions(config, {
    store,
    feishu,
    reviewer: {
      review: (input) =>
        reviewWithClaude(input, {
          projectRoot: config.projectRoot,
          apiKey: config.claude.apiKey,
          authToken: config.claude.authToken,
          baseUrl: config.claude.baseUrl,
          model: config.claude.model,
          disableNonessentialTraffic: config.claude.disableNonessentialTraffic,
          maxTurns: config.claude.maxTurns,
          timeoutMs: config.claude.timeoutMs
        })
    }
  })
);

const app = createApp({
  workflow,
  feishu: {
    encryptKey: config.feishu.encryptKey,
    verificationToken: config.feishu.verificationToken
  }
});

app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      contractChatId: config.contractChatId
    },
    "feishu contract chat bot started"
  );
});
