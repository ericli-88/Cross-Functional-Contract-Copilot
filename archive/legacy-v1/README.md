# 合同审核群聊 Bot

这是一个运行在你电脑或服务器上的飞书群聊机器人后台服务。群里有人 `@机器人` 发送飞书新版文档链接后，服务会读取文档纯文本，调用 AI 从商务、运营、法务、财务四个视角审查合同，然后在群里发总览，并把详细建议私信给对应负责人。

## 当前支持

- 飞书新版文档链接：URL 中包含 `/docx/`
- 飞书旧版文档链接：URL 中包含 `/docs/`
- 飞书知识库链接：URL 中包含 `/wiki/`，机器人会先解析成实际 docx 文档再读取
- 飞书富文本/文档标题链接：真实链接藏在 `href/url` 时也能识别
- 只发 `@机器人 + 文档链接` 也会默认开始首次审查
- 消息事件：`im.message.receive_v1`
- 回调地址：`/feishu/events`
- 本地测试群：`.env` 里 `FEISHU_CONTRACT_CHAT_ID=*` 时响应所有群
- 四个审核角色：商务、运营、法务、财务
- AI 接口：OpenAI-compatible Chat Completions，例如火山方舟兼容接口
- 负责人识别和私信发送只使用飞书 `user_id`，不再使用 `open_id`
- 机器人 @ 识别使用 `FEISHU_BOT_MENTION_NAME`，例如 `合同审查机器人`

## 你现在先这样测

1. 启动服务：

```powershell
cd "<project-directory>"
$env:PATH="C:\Users\Eric Li\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;C:\Users\Eric Li\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;" + $env:PATH
pnpm.cmd dev
```

如果你自己电脑已经装了 Node.js 20+，也可以直接：

```powershell
pnpm dev
```

2. 打开另一个 PowerShell，检查服务：

```powershell
curl http://127.0.0.1:3000/healthz
```

看到这个就说明本地服务活着：

```json
{"ok":true}
```

3. 开公网临时隧道：

```powershell
cloudflared tunnel --url http://localhost:3000
```

终端会出现一个 `https://xxxxx.trycloudflare.com` 地址。

4. 飞书开放平台填写事件回调：

```text
https://xxxxx.trycloudflare.com/feishu/events
```

位置：飞书开放平台 -> 你的应用 -> 事件与回调 -> 事件配置 -> 请求地址。

5. 在测试群里先发：

```text
@合同机器人 我是谁
```

机器人会回复 `chat_id`。拿到后，把 `.env` 改成：

```env
FEISHU_CONTRACT_CHAT_ID=oc_你刚刚拿到的值
```

然后重启服务。

6. 单人测试时注册自己为全部负责人：

```text
@合同机器人 我是全部负责人
```

这样四份详细审核建议都会按你的 user_id 私信给你。

7. 发起合同审查：

```text
@合同机器人 https://xxx.feishu.cn/docx/xxxx
```

旧版 docs 和知识库 wiki 链接也可以直接发：

```text
@合同机器人 https://xxx.feishu.cn/docs/xxxx
@合同机器人 https://xxx.feishu.cn/wiki/xxxx
```

同一份文档第一次出现会自动首审；之后任何人再次 `@机器人 + 同一份文档链接`，都会自动按“修改完毕后复审”处理。内容变了就生成新版本、群发 general 卡片、私信各负责人；内容没变就只在群里发一张“未生成新版本”的说明卡片。

## .env 必填项

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ENCRYPT_KEY=xxx
FEISHU_VERIFICATION_TOKEN=xxx
FEISHU_CONTRACT_CHAT_ID=*
FEISHU_BOT_MENTION_NAME=合同审查机器人
ARK_API_KEY=你的火山方舟 API Key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_VISION_MODEL=doubao-seed-2-0-pro-260215
```

这三个 `ARK_*` 会被优先读取。机器人内部调用的是 OpenAI-compatible Chat Completions：

- `ARK_API_KEY`：放到 HTTP Header 的 `Authorization: Bearer ...`
- `ARK_BASE_URL`：会自动拼成 `https://ark.cn-beijing.volces.com/api/v3/chat/completions`
- `ARK_VISION_MODEL`：当前作为合同文本审查模型使用

机器人会按 `ARK_VISION_MODEL` 的模型名自动识别运行模式，不需要改代码：

```env
# 稳定优先，当前推荐
ARK_VISION_MODEL=doubao-seed-2-0-pro-260215

# 速度优先，机器人会自动进入 mini 安全模式
ARK_VISION_MODEL=doubao-seed-2-0-mini-260428
```

- 模型名包含 `doubao`/`seed` 和 `pro`：按 pro 稳定模式运行，保持原来的审核输出风格。
- 模型名包含 `doubao`/`seed` 和 `mini`：按 mini 安全模式运行，会降低温度、加强 JSON 格式要求、自动拆掉 `result/data/output` 外壳、补齐缺失字段，并在必要时做一次格式修复重试；如果 mini 仍然输出异常，机器人会发中文“需要人工复核”的兜底卡片，而不是把技术报错直接丢到群里。
- 每次改完 `.env` 的模型名，都要重启本地服务，新模型才会生效。

代码也兼容旧写法：

```env
AI_API_KEY=你的火山方舟或 OpenAI-compatible API Key
AI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
AI_MODEL=doubao-seed-2-0-lite-260428
ANTHROPIC_AUTH_TOKEN=你的火山方舟 API Key
ANTHROPIC_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ANTHROPIC_MODEL=doubao-seed-2-0-lite-260428
```

如果你想不靠群里注册负责人，也可以直接固定四个负责人 user_id：

```env
OWNER_COMMERCIAL_NAME=商务负责人
OWNER_COMMERCIAL_USER_ID=bxxxxxxxx
OWNER_OPERATIONS_NAME=运营负责人
OWNER_OPERATIONS_USER_ID=bxxxxxxxx
OWNER_LEGAL_NAME=法务负责人
OWNER_LEGAL_USER_ID=bxxxxxxxx
OWNER_FINANCE_NAME=财务负责人
OWNER_FINANCE_USER_ID=bxxxxxxxx
```

## 换到另一个飞书机器人

如果你要把这套代码接到另一个飞书自建应用/机器人上，代码本身不用重写，只需要换 `.env` 里的飞书应用配置，并在新机器人后台重新配置事件回调。

1. 打开飞书开放平台，进入新的自建应用。

2. 进入“凭证与基础信息”，复制这两项到 `.env`：

```env
FEISHU_APP_ID=新应用的 App ID，通常是 cli_xxx
FEISHU_APP_SECRET=新应用的 App Secret
```

3. 进入“事件与回调 -> 加密策略”，复制这两项到 `.env`：

```env
FEISHU_ENCRYPT_KEY=新应用的 Encrypt Key
FEISHU_VERIFICATION_TOKEN=新应用的 Verification Token
```

4. 先把目标群放开，方便新机器人第一次回你 `chat_id`：

```env
FEISHU_CONTRACT_CHAT_ID=*
```

新机器人名字也要填进去。这个值就是你在群里 @ 它时显示的名字，不是 App ID，也不是 open_id：

```env
FEISHU_BOT_MENTION_NAME=新机器人名字
```

5. 保持豆包/火山方舟配置不变，除非带教老师给了新的 Key：

```env
ARK_API_KEY=你的火山方舟 API Key
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_VISION_MODEL=doubao-seed-2-0-pro-260215
```

6. 新机器人后台确认这些权限已经开通并发布：

```text
im:message.group_at_msg:readonly
im:message.group_msg.include_bot:read
im:message.group_msg
im:message:send_as_bot
im:chat:readonly
docx:document:readonly
docs:document.content:read
drive:drive:readonly
drive:drive.metadata:readonly
wiki:wiki:readonly
wiki:node:read
contact:user.base:readonly
contact:user.basic_profile:readonly
```

7. 新机器人后台进入“事件与回调 -> 事件配置”，请求地址填当前公网隧道地址：

```text
https://xxxxx.trycloudflare.com/feishu/events
```

如果你重开了 `cloudflared`，`xxxxx.trycloudflare.com` 会变，所以这里要同步改成新的地址。

8. 在新机器人后台订阅事件：

```text
接收消息 im.message.receive_v1
```

9. 把新机器人添加到要测试的飞书群里，然后在群里发：

```text
@新机器人名字 我是谁
```

机器人会回复 `chat_id` 和你的 `sender_user_id`。把回复里的 `chat_id` 写回 `.env`：

```env
FEISHU_CONTRACT_CHAT_ID=oc_刚刚机器人回复的值
```

10. 重启服务，再注册负责人：

```text
@新机器人名字 我是全部负责人
```

多人真实使用时，让对应同事分别发：

```text
@新机器人名字 我是商务负责人
@新机器人名字 我是运营负责人
@新机器人名字 我是法务负责人
@新机器人名字 我是财务负责人
```

也可以直接把他们的 `user_id` 固定写入 `.env` 的 `OWNER_*_USER_ID`。

11. 最后发一条真实合同链接测试：

```text
@新机器人名字 https://xxx.feishu.cn/docx/xxxx
```

同一份文档后续复审也发同样格式，不需要写“审查合同”或“修改完毕”：

```text
@新机器人名字 https://xxx.feishu.cn/docx/xxxx
```

## 飞书后台要确认的配置

- 机器人能力：已启用并发布
- 事件订阅：已订阅 `im.message.receive_v1`
- 请求地址：`https://你的公网域名/feishu/events`
- 权限：需要包含 `im:message.group_at_msg:readonly`、`im:message.group_msg.include_bot:read`、`im:message.group_msg`、`im:message:send_as_bot`、`im:chat:readonly`、`docx:document:readonly`、`docs:document.content:read`、`drive:drive:readonly`、`drive:drive.metadata:readonly`、`wiki:wiki:readonly`、`wiki:node:read`
- 应用可用范围：包含你和测试群成员
- 测试文档权限：组织内获得链接可阅读，或明确授权给机器人/测试群

## 一键诊断

每次怀疑“机器人没理我”时，先跑：

```powershell
cd "<project-directory>"
$env:PATH="C:\Users\Eric Li\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;C:\Users\Eric Li\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;" + $env:PATH
pnpm.cmd diagnose
```

如果要顺便验证“能不能真实发消息到群里”：

```powershell
$env:DIAGNOSE_SEND_TEST_MESSAGE="1"
pnpm.cmd diagnose
```

如果要验证某个 wiki 链接能不能读：

```powershell
$env:DIAGNOSE_WIKI_NODE_TOKEN="wiki 链接 /wiki/ 后面的那串 token"
pnpm.cmd diagnose
```

如果要验证某个 docx 链接能不能读：

```powershell
$env:DIAGNOSE_DOCX_TOKEN="docx 链接 /docx/ 后面的那串 token"
pnpm.cmd diagnose
```

诊断里最重要的几项：

- `public_healthz=pass`：公网隧道能访问到本机服务
- `feishu_url_verification=pass`：飞书 URL 验证格式能通过
- `feishu_target_chat=pass`：机器人能找到目标群
- `feishu_send_test_message=pass`：机器人能真实往群里发消息
- `feishu_recent_group_messages=pass`：机器人能读目标群最近消息
- `feishu_wiki_docx_raw_content=pass`：wiki 链接能解析并读出正文
- `ai_endpoint_reachable=pass`：AI key、base url、model 真能调用

## 常用群指令

```text
@合同机器人 帮助
@合同机器人 我是谁
@合同机器人 我是全部负责人
@合同机器人 我是商务负责人
@合同机器人 我是运营负责人
@合同机器人 我是法务负责人
@合同机器人 我是财务负责人
@合同机器人 https://xxx.feishu.cn/docx/xxxx
```

## 数据保存

运行状态保存在：

```text
data/chat-bot-state.json
```

里面会记录合同 token、审查版本、内容 hash、负责人 user_id 和 AI 审查结果。不要把 `.env` 和 `data/` 提交到公开仓库。
