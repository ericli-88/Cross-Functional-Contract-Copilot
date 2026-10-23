# Deployment

Use a fixed HTTPS hostname reverse-proxied to one Node.js application instance. The callback is `https://your-domain.example/feishu/events`. Complete [Setup](SETUP.md) and offline checks first.

## Docker Compose

Install Docker Engine and Compose on your deployment host. Copy `.env.example` to `.env`, configure credentials, model, owners and a fixed group ID, then run:

```sh
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:4302/healthz
docker compose logs --tail 100
```

Compose uses port 4302 and persists `DATA_DIR=/app/data` in the `bot_data` named volume. A direct local `pnpm start` defaults to port 3000. `HOST_PORT` can override the host mapping. If the reverse proxy runs on the same host, bind the service to loopback, for example `127.0.0.1:${HOST_PORT:-4302}:4302`. See `deploy/Caddyfile.example` for a hostname/proxy example.

Docker files are supplied as deployment configuration; the local Docker Engine was unavailable during the recorded verification, so image build and production rollout are not claimed as tested.

## Direct Node.js service

```sh
pnpm install --frozen-lockfile
pnpm build
NODE_ENV=production pnpm start
```

In PowerShell, set `$env:NODE_ENV='production'` before `pnpm start`. Use an appropriate system service or process supervisor for restarts and bounded logging. Existing PowerShell helpers are local development/maintenance tools; check their port, tunnel and process assumptions before use.

## State and updates

Back up `.env` and `data/chat-bot-state.json` before updating. State contains contract identities, versions, hashes, owners and review results. Restrict access and use encrypted backups. Current JSON storage is single-instance; do not run replicas against the same state file.

Build and test changes, then restart. Keep the Compose data volume. `docker compose down -v` deletes named volumes and should not be part of normal updates. Stop the application before restoring state.

The application can adjust organization-level document sharing, and marking a department complete deletes its role task. Confirm these behaviors with the target organization's policies. Test with a fictional document before real contracts. `pnpm tasks:backfill` writes missing tasks and should only be used intentionally after permission repair.
