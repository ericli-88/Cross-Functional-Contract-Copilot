# Current capability inventory

This inventory describes the current source code, not a proposed roadmap. Runtime integrations require valid tenant permissions and model configuration. Offline tests exercise adapters and fixtures; they do not prove live service availability.

## 1. Department-specific review guidance

| Capability | Current behavior | Evidence |
| --- | --- | --- |
| Four functional reviewers | Finance, Operations, Commercial, Legal each receive a separate role-scoped review call | [`reviewProfile.ts`](../src/review/reviewProfile.ts), [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Finance | Payment milestones/cycles, retainage, invoice/payment separation, overdue-payment protection | [`finance-review.md`](../.claude/skills/clinical-contract-review/references/finance-review.md) |
| Operations | Delivery feasibility, scope, change fees, client duties, acceptance | [`reviewProfile.ts`](../src/review/reviewProfile.ts) |
| Commercial | Same current focus areas and checklist references as Operations, with a separate role name and result | [`reviewProfile.ts`](../src/review/reviewProfile.ts) |
| Legal | Balanced obligations, liability limits, IP, data boundaries, termination and disputes | [`legal-review.md`](../.claude/skills/clinical-contract-review/references/legal-review.md) |
| Proposed contract changes | Concrete action items and reviewer reminders; not automatic edits to source text | [`prompt.ts`](../src/review/prompt.ts), [`reviewSchema.ts`](../src/review/reviewSchema.ts) |
| Structured results | Contract type, risk, recommendation, confidence, 1-8 concerns, 1-8 actions, 1-5 reminders | [`reviewSchema.ts`](../src/review/reviewSchema.ts) |
| Reference library | Inline role-specific reference text is included in prompts; additional contract-type checklists are retained in the library, not all automatically selected | [`skillReferences.ts`](../src/review/skillReferences.ts), [`reviewProfile.ts`](../src/review/reviewProfile.ts) |
| Model adapters | OpenAI-compatible Chat Completions; ARK variables take priority over generic and legacy names | [`config.ts`](../src/config.ts), [`claudeReviewer.ts`](../src/review/claudeReviewer.ts) |
| Output resilience | JSON validation, model-profile repair/fallback paths, Chinese-language correction, role retry; service errors can stop a review | [`claudeReviewer.ts`](../src/review/claudeReviewer.ts), [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |

The four calls are workflow orchestration, not a team of autonomous planning agents. Commercial and Operations should not be advertised as having independently implemented policies.

## 2. Contract intake and identity

| Capability | Current behavior | Evidence |
| --- | --- | --- |
| Mention-triggered group workflow | Process recognized bot mentions or command-like events in the configured group scope | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Online links | Parse `docx`, legacy `docs`, and `wiki`; resolve wiki to its underlying document | [`documentLinks.ts`](../src/chat/documentLinks.ts), [`feishuClient.ts`](../src/feishu/feishuClient.ts) |
| Rich-text/title links | Extract URLs from supported structured message fields | [`messageParsing.ts`](../src/chat/messageParsing.ts) |
| Reply-based submission | Read a replied-to message to find its document URL or file | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| DOCX | Extract document, header and footer text from the ZIP/XML package | [`attachmentText.ts`](../src/chat/attachmentText.ts) |
| TXT / Markdown / HTML | Read UTF-8 text; HTML is not rendered or fully normalized | [`attachmentText.ts`](../src/chat/attachmentText.ts) |
| Text PDF | Basic text extraction; not an OCR engine or a general-purpose PDF renderer | [`attachmentText.ts`](../src/chat/attachmentText.ts) |
| Legacy DOC | Recognized, then rejected with a request to convert to DOCX or an online document | [`attachmentText.ts`](../src/chat/attachmentText.ts) |
| Contract IDs and source aliases | Track a contract across related links/messages; associate same-group attachments by normalized filename | [`contractCaseStore.ts`](../src/chat/contractCaseStore.ts), [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Original online URL | Use the submitted document link in cards and tasks | [`reviewCard.ts`](../src/review/reviewCard.ts), [`taskCoordinator.ts`](../src/chat/taskCoordinator.ts) |
| Attachment boundary | No automatic online-document conversion or contract-opening URL in the chat workflow | [`workflow-v2.test.mjs`](../tests/workflow-v2.test.mjs) |

Different contracts with the same normalized attachment filename can be associated incorrectly; use stable, unique names. Online-document text normalization caps input at 300,000 characters and records a truncation warning; this is not a universal safe model-context guarantee.

## 3. Ownership, notifications and follow-up

| Capability | Current behavior | Evidence |
| --- | --- | --- |
| Owner registration | Register one role, register all roles for testing, or configure defaults in environment variables | [`intentParser.ts`](../src/chat/intentParser.ts), [`responsibleOwners.ts`](../src/chat/responsibleOwners.ts) |
| Multiple owners | Multiple environment-configured user IDs can jointly own one role task; chat registration stores one owner per role | [`config.ts`](../src/config.ts), [`contractCaseStore.ts`](../src/chat/contractCaseStore.ts) |
| Owner precedence | Configured environment owners take precedence over chat registration | [`responsibleOwners.ts`](../src/chat/responsibleOwners.ts) |
| Identity/help commands | Return user/group identity or usage guidance; report missing owner setup | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts), [`reviewCard.ts`](../src/review/reviewCard.ts) |
| Group overview | Role summaries, department states, contract/version identity and available links | [`reviewCard.ts`](../src/review/reviewCard.ts) |
| V1 private cards | Send the relevant role entry card to each owner using Feishu user IDs | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Active role tasks | One active task per contract/role; reuse it across review versions while active | [`taskCoordinator.ts`](../src/chat/taskCoordinator.ts) |
| Per-version comments | Append complete role guidance and refresh the active task description | [`taskCoordinator.ts`](../src/chat/taskCoordinator.ts) |
| Later-version DM suppression | Normally no repeated owner DM when the active task exists and synchronization succeeds; task-disabled/failure paths differ | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Optional test CC | Send role cards to configured test recipients, deduplicating recipient IDs within a role | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Delivery fallback | Report delivery failures and send affected-role fallback private cards when task synchronization fails | [`workflow-v2.test.mjs`](../tests/workflow-v2.test.mjs) |

## 4. Versions, archives and human status

| Capability | Current behavior | Evidence |
| --- | --- | --- |
| Initial review / re-review | First usable review becomes V1; changed content on an existing contract creates subsequent versions | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| No-change detection | Hash normalized content and skip new AI review/version/task/owner-DM work when unchanged | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Failed-version handling | Retry failed records without usable results; preserve useful prior results for duplicate detection | [`bot-flow.test.mjs`](../tests/bot-flow.test.mjs) |
| Online-document archive | Group folder, contract subfolder, original-document shortcut and `docx` snapshots when enabled and permitted | [`documentArchive.ts`](../src/chat/documentArchive.ts) |
| Permission handling | Attempt organization-editable document sharing and group folder access; report archive permission problems without necessarily stopping review | [`documentArchive.ts`](../src/chat/documentArchive.ts) |
| Human completion | Record completed state, actor and version; suppress subsequent task updates and owner reminders for that role | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Task deletion on completion | Delete the associated Feishu role task and its local mapping; this is not a persistent closed-task archive | [`taskCoordinator.ts`](../src/chat/taskCoordinator.ts) |
| Reopen | Restore active department status; create a replacement task on the next changed-content review | [`taskCoordinator.ts`](../src/chat/taskCoordinator.ts), [`workflow-v2.test.mjs`](../tests/workflow-v2.test.mjs) |
| Status authorization | Any configured owner can update any department; non-owners are rejected | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts), [`workflow-v2.test.mjs`](../tests/workflow-v2.test.mjs) |
| Contract resolution for status | Identify by contract ID, document URL, related message/card, or supported contextual lookup | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Card refresh | Publish a status card and attempt to refresh the most recent group overview | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Local record reset | Delete the selected contract's local review record; preserve the source document and owner configuration | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |

Completion does not eliminate model calls for that role: the model layer still generates all four results on a changed-content review. Local version results persist, but deleting a task can remove its comment history. Record reset is not role-restricted inside the configured group and is not a remote-document cleanup command.

## 5. Backend and operations

| Capability | Current behavior | Evidence |
| --- | --- | --- |
| HTTP event service | Express, `/feishu/events`, `im.message.receive_v1`; not a WebSocket client | [`app.ts`](../src/app.ts), [`index.ts`](../src/index.ts) |
| Callback authentication | Validate plaintext/decrypted Verification Tokens; retain SDK signature checks for encrypted events | [`messageEventMiddleware.ts`](../src/feishu/messageEventMiddleware.ts), [`http.test.mjs`](../tests/http.test.mjs) |
| Fast acknowledgement | Start workflow processing in the background after callback handling | [`messageEventMiddleware.ts`](../src/feishu/messageEventMiddleware.ts) |
| Event deduplication | Track processed/in-progress event IDs | [`contractCaseStore.ts`](../src/chat/contractCaseStore.ts) |
| Contract serialization | Serialize concurrent review requests for the same contract identity | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Bounded role concurrency | Run role calls in batches of two | [`contractChatWorkflow.ts`](../src/chat/contractChatWorkflow.ts) |
| Local persistence | JSON contracts, versions, owners, aliases, task/status mappings, events and workspaces; temporary file plus rename for mutations | [`contractCaseStore.ts`](../src/chat/contractCaseStore.ts) |
| Migration | Read UTF-8 BOM state and migrate supported historical records | [`store-migration.test.mjs`](../tests/store-migration.test.mjs) |
| Health and diagnostics | `/healthz`, configuration/API diagnostics, opt-in import checks, task backfill, Windows helper scripts | [`scripts/`](../scripts/) |
| Deployment configuration | Dockerfile, Compose and Caddy example; not proof of a tested production deployment | [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) |
| Automated validation | Type checks, five test programs, 11-scenario offline demo, Linux/Windows and Node 22/24 CI | [`VERIFICATION.md`](VERIFICATION.md) |

## Explicitly not implemented or not established

- Separate Commercial/Operations policies.
- Automatic contract drafting, source-text replacement, Word redlines, annotations or tracked changes.
- OCR, scanned-document understanding, signatures, approval authority or jurisdiction-specific legal certification.
- English runtime commands/cards/model output; portfolio figures are English documentation views.
- A database-backed, multi-instance deployment or an immutable remote audit log.
- Durable task-comment history after completion deletes a task.
- Live end-to-end tenant validation, measured business impact, model-quality benchmarks or production performance claims.
