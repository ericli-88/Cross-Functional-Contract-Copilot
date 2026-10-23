# Setup and configuration

## Local installation

Use Node.js 22 or 24 and pnpm 11.9.0. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and `pnpm demo` first. These checks are offline and require no credentials.

Copy `.env.example` to `.env`: `Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env` on macOS/Linux. Supply your own app credentials and model endpoint. The application uses an HTTP webhook, not WebSocket event delivery.

## Feishu console

1. Create an enterprise custom app and enable its bot capability.
2. Copy App ID, App Secret, and Verification Token. If event encryption is enabled, configure the same Encrypt Key locally.
3. Set the event subscription to a developer server at `https://your-domain.example/feishu/events`; subscribe to `im.message.receive_v1`.
4. Enable required scopes, publish an application version, and add the bot to the target group. The app availability range must include participants.
5. Grant the bot access to the test document. Confirm that the intended collaborators can access the original document.
6. Set `FEISHU_CONTRACT_CHAT_ID` to the intended group. `*` is supported for a controlled initial setup, but a fixed group is preferable for production. Restart after editing `.env`.

Start development with `pnpm dev`, or run `pnpm build` and `pnpm start`. The default port is 3000; `GET /healthz` returns `{"ok":true}`. For a local HTTPS tunnel, a separately installed Cloudflare Tunnel can use `cloudflared tunnel --url http://localhost:3000`. Update the console callback when a temporary hostname changes.

## Runtime language

The current deployment uses primarily Chinese command patterns, cards, and model output. English portfolio figures are documentation views, not commands to copy into a live bot. Exact command literals are implemented in [`intentParser.ts`](../src/chat/intentParser.ts) and returned by the runtime help formatter in [`reviewCard.ts`](../src/review/reviewCard.ts). A document URL plus a bot mention triggers review without an additional language-specific review phrase.

## Environment configuration

- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`: required app identity and event verification.
- `FEISHU_ENCRYPT_KEY`: use the event encryption key when encryption is enabled.
- `FEISHU_BOT_MENTION_NAME`: match the bot's display name in group mentions.
- `FEISHU_CONTRACT_CHAT_ID`: group scope.
- `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`: generic OpenAI-compatible Chat Completions configuration.
- `ARK_API_KEY`, `ARK_BASE_URL`, `ARK_VISION_MODEL` / `ARK_MODEL`: ARK configuration, with priority over generic variables.
- Legacy `ANTHROPIC_*` variable names remain compatible; the protocol is still Chat Completions, not Anthropic Messages.
- `OWNER_{COMMERCIAL,OPERATIONS,LEGAL,FINANCE}_USER_IDS`: comma-separated configured owners. Corresponding `_NAMES` values align by position. Singular `_USER_ID` / `_NAME` variables are also supported.
- Environment owners take precedence over chat registration. Registration stores one owner per role; multiple owners are configured through environment defaults.
- `FEISHU_DOCUMENT_ARCHIVE_ENABLED`, `FEISHU_TASKS_ENABLED`: optional integration switches.
- `FEISHU_CONTRACT_ROOT_FOLDER_TOKEN`: optional archive root. `DATA_DIR` defaults to `./data`.
- `REVIEW_TEST_CC_ENABLED` and `REVIEW_TEST_CC_USER_IDS`: optional test-recipient routing; disabled by default.

Set one coherent provider configuration. Avoid combining a key, model and URL from different services. Use a model or endpoint available in your own account.

## Permission groups

Scope names below reflect the implementation and inherited deployment materials. Verify exact scope alternatives in your tenant's console and publish the application after changes.

| Integration | Scope identifiers |
| --- | --- |
| Group messages and bot sends | `im:message.group_at_msg:readonly`, `im:message.group_msg`, `im:message.group_msg.include_bot:read`, `im:message:send_as_bot` |
| Group identity and display names | `im:chat:readonly`, `contact:user.base:readonly`, `contact:user.basic_profile:readonly` |
| Documents and wiki | `docx:document:readonly`, `docs:document.content:read`, `drive:drive:readonly`, `drive:drive.metadata:readonly`, `wiki:wiki:readonly`, `wiki:node:read` |
| Folders, shortcuts and permissions | `drive:file`, `space:folder:create`, `space:document:shortcut`, `docs:permission.member:create`, `docs:permission.setting:write_only` |
| Document snapshots | `drive:drive:version` |
| Tasks and comments | `task:task:write`, `task:comment:write` |
| Optional import diagnostics | `docs:document:import`; ordinary attachment chat review does not invoke import |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup fails | Node version, installed dependencies, required environment variables, port conflicts |
| Healthy service, no group response | Public HTTPS callback, event subscription, published app version, group scope and mention |
| Callback 403 | Verification Token and Encrypt Key match the console |
| Document read fails | Document authorization, application scopes and published version |
| Model request fails | Active key, available model, correct endpoint, quota and timeout |
| Task/archive failure | Published write scopes; review the restricted local diagnostic output |
| Unreadable attachment | Convert legacy DOC/scanned files; use a readable DOCX or online document |

`pnpm diagnose` can read real group metadata/messages. Keep its output private. No live API test is required for the offline verification scope.
