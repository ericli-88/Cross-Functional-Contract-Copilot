# Verification and evidence

Verification date: **October 23, 2026**. The accepted scope is a buildable framework and repeatable offline workflow. Live AI API execution and end-to-end production Feishu validation are outside that scope.

## Reproducible checks

| Check | What it establishes |
| --- | --- |
| `pnpm install --frozen-lockfile` | Dependencies install from the committed lockfile |
| `pnpm typecheck` | Strict TypeScript checks |
| `pnpm test` | Encoding, build, five regression/integration test programs |
| `pnpm demo` | 11 workflow scenes, deterministic review fixtures, no network calls; English documentation export |
| Compiled entry-point startup | The compiled server starts with offline placeholder configuration and responds to `/healthz` |
| `python scripts/verify-screenshots.py` | Verifies selected screenshot hashes, dimensions and PNG format without modifying assets |

CI uses Windows/Linux with Node.js 22/24. The current result is available in [GitHub Actions](https://github.com/ericli-88/cross-functional-contract-copilot/actions). Do not infer live permissions or model quality from a passing offline job.

## Test coverage by program

- `bot-flow.test.mjs`: message/link/reply parsing, first/repeated review, duplicate events, owner precedence, CC deduplication, retry paths, model profiles and schema handling.
- `workflow-v2.test.mjs`: attachments and text PDF, original-document URLs and snapshots, task reuse, completion/deletion/reopening, cross-role owner authorization, concurrency, delivery fallback and archive permission failures.
- `feishu-api-contracts.test.mjs`: SDK payload/response contracts with substitutes; not live authorization.
- `store-migration.test.mjs`: supported historical state migration and preservation.
- `http.test.mjs`: real local HTTP health, URL challenges, plaintext/decrypted token checks, encrypted events, signature rejection and encrypted challenges.

The authentication regression found and fixed an SDK integration gap: without an Encrypt Key, a wrong Verification Token could previously reach the workflow. The application now checks plaintext/decrypted tokens explicitly and retains encrypted-event signature verification.

## How the figures relate to the code

`pnpm demo` runs `ContractChatWorkflow`, local storage, archive and task coordinators against in-memory Feishu and deterministic AI adapters. Assertions check versions, tasks, notifications and skipped calls. Raw Chinese-language cards are exported to `docs/demo/scenes.json`.

`scripts/export-portfolio.mjs` checks the required scene IDs and actual role definitions, then exports English editorial summaries to `docs/demo/portfolio.json`. The selected figures are simulated native Feishu desktop conversations, made with official visual references and built-in ImageGen editing. They use fictional English names and workflow-based message copy. They are not live captures or generated live contract-review results. English documentation does not imply English command/card/model-output support.

The previous presentation-style custom renderer was removed. The new images preserve native navigation, chat lists, sender rows, cards, buttons and composer controls. See [Screenshot provenance and prompts](design/SCREENSHOTS.md) for the full visual workflow.

## Current behavioral corrections

Commercial and Operations share their checklist. Any configured owner may update another department. Completion deletes the associated role task; reopening recreates a task on a later changed-content review. These are documented behaviors covered by the current source/tests, not stricter controls or an immutable task history.

## Optional live diagnostics

No further live API calls are part of this update. For a future explicitly chosen smoke test, set `LIVE_ENV_FILE` to a private configuration path and run `pnpm verify:live`. This defaults to authentication and target-group reads. `LIVE_AI_SMOKE=1` sends a synthetic contract to the configured model and can incur provider fees.

Do not commit live diagnostic output. Real task creation, file import and message-sending switches in the inherited diagnostic scripts are opt-in operations. Docker and production deployment need separate validation in the target environment. No business-impact, coverage-percentage or model-quality benchmark is claimed.
