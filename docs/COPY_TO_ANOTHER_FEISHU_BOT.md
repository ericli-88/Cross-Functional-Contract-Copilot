# 把当前合同审查机器人复制到另一个飞书机器人

结论：代码可以复用，不需要重写业务逻辑。你要改的是“配置”和“飞书后台绑定”。

但要分两种情况：

## 1. 只想把当前机器人切换成另一个飞书机器人

这种最简单：同一份代码，同一个服务，只换 `.env` 里的飞书应用信息。

需要改：

```env
FEISHU_APP_ID=新机器人应用的 App ID
FEISHU_APP_SECRET=新机器人应用的 App Secret
FEISHU_ENCRYPT_KEY=新机器人事件回调 Encrypt Key
FEISHU_VERIFICATION_TOKEN=新机器人事件回调 Verification Token
FEISHU_BOT_MENTION_NAME=新机器人在群里被 @ 时显示的名字
FEISHU_CONTRACT_CHAT_ID=*
```

然后重启服务。

飞书后台新机器人里也要填：

```text
https://你的公网域名/feishu/events
```

之后在新群里发：

```text
@新机器人名字 我是谁
```

拿到 `chat_id` 后，把 `.env` 改成：

```env
FEISHU_CONTRACT_CHAT_ID=oc_xxx
```

再重启服务。

## 2. 想让旧机器人和新机器人同时运行

这种不能只改当前 `.env`，因为一个运行中的服务一次只能使用一套：

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_VERIFICATION_TOKEN
FEISHU_ENCRYPT_KEY
FEISHU_CONTRACT_CHAT_ID
```

如果两个飞书应用同时共用同一个 `/feishu/events`，当前代码无法同时验证两套 token/secret。

最稳的做法是：同一份代码部署两份实例。

示例：

```text
/opt/contract-bot-a
/opt/contract-bot-b
```

两个目录代码一样，但 `.env` 不一样。

第一个机器人：

```env
HOST_PORT=4302
PORT=4302
PUBLIC_BASE_URL=https://contracts-a.example.com
FEISHU_APP_ID=cli_旧机器人
FEISHU_BOT_MENTION_NAME=合同审查机器人A
```

第二个机器人：

```env
HOST_PORT=4303
PORT=4302
PUBLIC_BASE_URL=https://contracts-b.example.com
FEISHU_APP_ID=cli_新机器人
FEISHU_BOT_MENTION_NAME=合同审查机器人B
```

注意：第二个机器人的容器内部仍然可以用 `PORT=4302`，但映射到宿主机时用 `HOST_PORT=4303`。

Caddy 配置：

```caddyfile
contracts-a.example.com {
	reverse_proxy 127.0.0.1:4302
}

contracts-b.example.com {
	reverse_proxy 127.0.0.1:4303
}
```

飞书后台分别填：

```text
旧机器人：https://contracts-a.example.com/feishu/events
新机器人：https://contracts-b.example.com/feishu/events
```

## 3. 新机器人后台到底去哪里找这些值

进入飞书开放平台的新应用。

### App ID / App Secret

```text
凭证与基础信息
-> App ID
-> App Secret
```

填到：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

### Encrypt Key / Verification Token

```text
事件与回调
-> 加密策略
```

填到：

```env
FEISHU_ENCRYPT_KEY=xxx
FEISHU_VERIFICATION_TOKEN=xxx
```

### 机器人名字

```text
机器人
-> 机器人名称
```

这个名字必须和你群里 @ 它时显示的一致。

填到：

```env
FEISHU_BOT_MENTION_NAME=新机器人名字
```

### 目标群 chat_id

第一次先填：

```env
FEISHU_CONTRACT_CHAT_ID=*
```

然后把新机器人拉进目标群，在群里发：

```text
@新机器人名字 我是谁
```

机器人回复里的 `chat_id` 填回：

```env
FEISHU_CONTRACT_CHAT_ID=oc_xxx
```

## 4. 新机器人后台权限必须和旧机器人一致

至少要确认这些类别已经开通并发布：

新工作流除了原有读取与消息权限，还必须包含：

```text
docs:document:import
drive:file
space:folder:create
space:document:shortcut
docs:permission.member:create
docs:permission.setting:write_only
drive:drive:version
task:task:write
task:comment:write
```

新机器人使用独立的应用云空间、任务和本地 `data/chat-bot-state.json`。若希望两个机器人同时运行，应部署两个实例并使用两个独立 `DATA_DIR`，不要让两个进程同时写同一个状态文件。

```text
消息读取/发送
群聊读取
用户基础信息读取
contact:contact.base:readonly
docx 文档读取
drive/wiki 读取
```

如果你复制的是当前应用能力，最稳的方式是把旧机器人已经开通的权限逐项对照新机器人，全部打开后发布版本。

## 5. 数据是否要复制

一般不要复制 `data/`。

原因：

```text
data/ 里保存的是旧机器人审查过的合同版本、内容 hash、负责人注册状态。
```

新机器人如果面向新的测试群或新业务，建议从空数据开始。

如果你明确希望“新机器人继承旧机器人的历史合同记录和负责人注册”，才复制：

```text
data/
```

## 6. 最终测试清单

新机器人上线后按顺序测试：

```text
@新机器人名字 帮助
@新机器人名字 我是谁
@新机器人名字 我是全部负责人
@新机器人名字 https://xxx.feishu.cn/docx/xxxx
```

看到群内审查卡片和私信卡片后，才算复制成功。
