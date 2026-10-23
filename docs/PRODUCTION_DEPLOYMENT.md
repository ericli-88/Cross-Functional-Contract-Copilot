# 生产部署

推荐固定 HTTPS 域名反向代理到单个 Node.js 实例。飞书事件地址为 `https://bot.example.com/feishu/events`。部署前先完成 [安装配置](SETUP.md)，跑通本地测试。

## Docker Compose

服务器需安装 Docker Engine 和 Compose。复制 `.env.example` 为 `.env`，填写自己的凭证、模型与负责人；生产环境将 `FEISHU_CONTRACT_CHAT_ID` 限定到目标群。

```sh
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:4302/healthz
docker compose logs --tail 100
```

Compose 将容器与宿主机端口设为 `4302`，并将 `DATA_DIR=/app/data` 持久化到命名卷 `bot_data`。普通本机 `pnpm start` 默认是 `3000`，两者不要混淆。可通过 `HOST_PORT` 修改宿主机端口。

反向代理运行在宿主机时，建议在 Compose 中把端口绑定为 `127.0.0.1:${HOST_PORT:-4302}:4302`，对外只开放反向代理的 HTTPS 入口。仓库的 `deploy/Caddyfile.example` 提供 Caddy 配置示意，域名应替换为自己的。

本机未运行 Docker Engine，当前镜像与容器部署未做实测。部署环境应执行构建、健康检查和飞书回调验证后再接入正式群。

## 直接运行 Node.js

```sh
pnpm install --frozen-lockfile
pnpm build
NODE_ENV=production pnpm start
```

Windows PowerShell 先执行 `$env:NODE_ENV='production'`，再运行 `pnpm start`。用系统服务或进程管理器守护 Node 进程，配置异常重启与日志保留。根目录现有 PowerShell 脚本为 Windows 开发／维护工具，默认端口和本机路径使用前需自行确认。

## 数据与更新

状态保存在 `data/chat-bot-state.json`，含合同身份、版本、hash、负责人和审查结果。请限制目录权限，并做加密备份。当前状态存储只适用于单实例，不要让多个副本并发写同一状态文件。

更新前备份 `.env` 与状态目录，运行测试后重新构建并重启。Compose 命名卷保留业务状态；不要执行 `docker compose down -v`，除非明确要删除数据。恢复时先停服务，再恢复状态文件。

## 上线检查

确认健康检查正常、HTTPS 证书有效、Verification Token 与 Encrypt Key 匹配、事件权限已发布、机器人已入群、负责人配置正确、合同文档可读。归档功能会调整组织内共享权限，需符合组织的数据规则。先用虚构文档验收，再处理真实合同。

`pnpm tasks:backfill` 会补建历史职能任务，不重新调用 AI；仅在任务权限修复且确需补建时执行。详细联调范围见 [验证记录](VERIFICATION.md)。
