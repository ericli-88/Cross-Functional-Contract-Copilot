# 合同审查飞书机器人：正式部署教程

目标：电脑关机以后，机器人仍然可以在飞书里响应。这意味着机器人不能再依赖你本机的 PowerShell 和 trycloudflare 临时地址，而要放到一台长期在线的云服务器上，并使用固定 HTTPS 域名。

## 1. 结论先说清楚

最成熟、最不折腾的架构是：

```text
飞书群聊
  -> 飞书开放平台事件回调
  -> https://contracts.example.com/feishu/events
  -> 云服务器 443
  -> Caddy 自动 HTTPS 反向代理
  -> Docker 容器里的 Node.js 机器人
  -> 豆包 Ark / 飞书 OpenAPI
```

本地 `trycloudflare.com` 只适合开发测试。正式版不要用它，因为它的域名会变，且没有生产稳定性保证。

## 2. 你需要准备什么

你需要准备：

1. 一台云服务器，推荐 Ubuntu 24.04 LTS 或 Ubuntu 22.04 LTS。
2. 一个域名，例如 `contracts.example.com`。
3. 域名 DNS A 记录指向云服务器公网 IP。
4. 云服务器安全组放行：
   - TCP 80
   - TCP 443
   - SSH 22，只给你自己的 IP 更安全
5. 当前项目代码。
6. 当前 `.env` 里的真实密钥，但不要上传到公开仓库。

服务器配置建议：

```text
最低可用：1 核 2GB RAM
更稳推荐：2 核 4GB RAM
系统盘：40GB+
地区：优先选离飞书/豆包网络稳定的区域，例如中国大陆或香港
```

## 3. 为什么不用你电脑

你本机现在能跑，是因为：

```text
PowerShell 运行 Node 服务
cloudflared 把本机 3000 暴露成公网 URL
飞书把事件推到这个公网 URL
```

但你关机以后：

```text
Node 服务停了
cloudflared 隧道断了
trycloudflare 地址失效
飞书回调打不到你的服务
```

所以正式版必须放到一台不会关机、可公网访问的服务器上。

## 4. 在云服务器安装 Docker

SSH 登录服务器：

```bash
ssh root@你的服务器公网IP
```

安装 Docker Engine 和 Docker Compose 插件。以下是 Ubuntu 常用命令：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

验证：

```bash
docker --version
docker compose version
```

## 5. 上传代码到服务器

推荐目录：

```bash
mkdir -p /opt/feishu-contract-chat-bot
```

你可以用 Git，也可以用压缩包/SCP。重点是服务器上最终要有这些文件：

```text
/opt/feishu-contract-chat-bot/package.json
/opt/feishu-contract-chat-bot/pnpm-lock.yaml
/opt/feishu-contract-chat-bot/Dockerfile
/opt/feishu-contract-chat-bot/docker-compose.yml
/opt/feishu-contract-chat-bot/src/...
/opt/feishu-contract-chat-bot/.claude/...
```

不要把本地 `node_modules`、`dist`、日志文件传过去。

## 6. 在服务器创建 .env

进入项目：

```bash
cd /opt/feishu-contract-chat-bot
cp deploy/production.env.template .env
nano .env
```

正式环境推荐这样填：

```env
NODE_ENV=production
PORT=4302
HOST_PORT=4302
PUBLIC_BASE_URL=https://contracts.example.com
```

飞书应用部分填你的真实值：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=新飞书应用 App Secret
FEISHU_ENCRYPT_KEY=事件与回调里的 Encrypt Key
FEISHU_VERIFICATION_TOKEN=事件与回调里的 Verification Token
FEISHU_CONTRACT_CHAT_ID=*
FEISHU_BOT_MENTION_NAME=合同审查机器人
```

豆包部分：

```env
ARK_API_KEY=你的豆包 Ark Key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_VISION_MODEL=doubao-seed-2-0-pro-260215
```

负责人可以先留空，让负责人在群里注册；也可以直接填 user_id：

```env
OWNER_COMMERCIAL_USER_ID=
OWNER_OPERATIONS_USER_ID=
OWNER_LEGAL_USER_ID=
OWNER_FINANCE_USER_ID=
```

## 7. 启动机器人容器

在服务器项目目录运行：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f --tail=100
```

本机健康检查：

```bash
curl http://127.0.0.1:4302/healthz
```

应该看到：

```json
{"ok":true}
```

## 8. 配置 HTTPS 反向代理

推荐用 Caddy，因为它会自动申请和续期 HTTPS 证书。

安装 Caddy 后，编辑：

```bash
sudo nano /etc/caddy/Caddyfile
```

填：

```caddyfile
contracts.example.com {
	reverse_proxy 127.0.0.1:4302
}
```

重载：

```bash
sudo systemctl reload caddy
```

公网检查：

```bash
curl https://contracts.example.com/healthz
```

应该看到：

```json
{"ok":true}
```

## 9. 飞书后台填写回调地址

飞书开放平台进入你的应用：

```text
开发配置
-> 事件与回调
-> 事件配置
-> 订阅方式：将事件发送至开发者服务器
-> 请求地址
```

填：

```text
https://contracts.example.com/feishu/events
```

保存后，如果飞书提示需要发布版本：

```text
版本管理与发布
-> 创建版本
-> 发布
```

## 10. 群里第一次测试

先把机器人拉进目标群。

`.env` 里 `FEISHU_CONTRACT_CHAT_ID=*` 时，机器人会响应所有群，适合第一次拿 chat_id。

在群里发：

```text
@合同审查机器人 我是谁
```

机器人会回复 `chat_id`。把它写回服务器 `.env`：

```env
FEISHU_CONTRACT_CHAT_ID=oc_xxx
```

然后重启容器：

```bash
docker compose up -d
```

## 11. 正式合同测试

在目标群发：

```text
@合同审查机器人 https://xxx.feishu.cn/docx/xxxx
```

预期行为：

1. 第一次出现这份文档：首次审查。
2. 同一份文档后续再次出现：修改后复审。
3. 内容没变化：只在群里发“未生成新版本”卡片。
4. 内容变化：群里发 general 卡片，并私信商务、运营、法务、财务负责人。

## 12. 日常维护命令

看服务是否活着：

```bash
docker compose ps
curl https://contracts.example.com/healthz
```

看日志：

```bash
docker compose logs -f --tail=200
```

重启：

```bash
docker compose restart
```

更新代码后重新构建：

```bash
docker compose up -d --build
```

停止：

```bash
docker compose down
```

## 13. 重要判断标准

正式部署成功的标准不是“服务启动了”，而是下面全部通过：

```text
https://contracts.example.com/healthz 返回 {"ok":true}
飞书后台 URL 验证通过
机器人能在目标群回复“我是谁”
机器人能读取飞书合同文档
机器人能调用豆包 Ark
机器人能给负责人私信
```

这些都通过后，你电脑关机也不会影响机器人。
