# Security and data handling

Never commit `.env`, credential backups, `data/`, logs, real contracts, or private diagnostic output. This public repository uses placeholder configuration and fictional demo records.

## Data flow

At runtime, contract text, role reference material, and selected document metadata are sent to the configured AI provider. Confirm that this is permitted by your organization's data policy.

With document archiving enabled, the bot attempts to make linked online documents editable within the organization and grants the contract group access to its archive folder. Set `FEISHU_DOCUMENT_ARCHIVE_ENABLED=false` if this sharing behavior is inappropriate. Set `FEISHU_TASKS_ENABLED=false` to disable task synchronization.

## Access and lifecycle boundaries

Environment-configured owners override chat registration. Any configured owner can update any department's completion status. Local-record reset is available within the configured group and is not restricted to a role owner. Use a controlled group and a fixed `FEISHU_CONTRACT_CHAT_ID` in production.

Completing a department deletes its associated Feishu role task and local mapping. Reopening restores active status; the next changed-content review creates a replacement task. Do not treat task comments as an immutable audit trail.

Local JSON storage is intended for a single instance. Restrict and back up the state directory. Logs can contain message text and document identifiers, so limit log access and retention.

## Reporting

Use GitHub private vulnerability reporting if enabled. Do not publish secrets, contracts, or personal information in an issue. If a credential is exposed, revoke and rotate it at the provider immediately.
