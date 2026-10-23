# 安装与飞书配置

## 本地启动

使用 Node.js 22/24 和 pnpm 11.9.0，执行 README 中的安装步骤，复制 `.env.example` 并填写凭证。`pnpm dev` 监听代码变化，生产运行 `pnpm build` 后执行 `pnpm start`。

项目采用 HTTP 回调，不是 Python 长连接项目。开放平台事件地址为公网 HTTPS 域名加 `/feishu/events`。本机可使用自行安装的 Cloudflare Tunnel：`cloudflared tunnel --url http://localhost:3000`。临时域名每次变化后都要更新开放平台请求地址；生产建议固定域名。

## 飞书控制台

1. 创建企业自建应用，启用机器人。
2. 在凭证页复制 App ID、App Secret；在事件加密策略页复制 Verification Token，启用加密时填写 Encrypt Key。
3. 事件订阅方式选择开发者服务器，填写 HTTPS 回调，订阅 `im.message.receive_v1`。
4. 开通所需权限并发布应用版本。把机器人加入目标群，应用可用范围包含参与者。
5. 确保机器人有文档读取权限，目标群成员可编辑原文档。
6. 测试群可先用 `FEISHU_CONTRACT_CHAT_ID=*`，发送 `@机器人 我是谁` 后把实际群 ID 写回配置。修改 `.env` 后需重启。

## 权限分组

以下权限来自现有实现和项目部署资料；控制台可能显示细分权限或等价权限，按实际 API 报错核对并发布。

| 功能 | 权限标识 |
| --- | --- |
| 群消息与机器人发送 | `im:message.group_at_msg:readonly`、`im:message.group_msg`、`im:message.group_msg.include_bot:read`、`im:message:send_as_bot` |
| 群信息与用户显示名 | `im:chat:readonly`、`contact:user.base:readonly`、`contact:user.basic_profile:readonly` |
| 在线文档与知识库读取 | `docx:document:readonly`、`docs:document.content:read`、`drive:drive:readonly`、`drive:drive.metadata:readonly`、`wiki:wiki:readonly`、`wiki:node:read` |
| 文件夹、快捷方式与权限 | `drive:file`、`space:folder:create`、`space:document:shortcut`、`docs:permission.member:create`、`docs:permission.setting:write_only` |
| docx 版本快照 | `drive:drive:version` |
| 任务、状态与版本评论 | `task:task:write`、`task:comment:write` |
| 可选导入诊断／扩展 | `docs:document:import`；普通附件聊天流程不调用导入 |

## 配置要点

`ARK_*` 优先于 `AI_*`，再兼容旧 `ANTHROPIC_*` 变量名；实际网络协议是 Chat Completions，并不调用 Anthropic Messages。设置一组服务商配置即可，避免跨服务商混用 key、URL、model。

单数 `OWNER_*_USER_ID` 与复数 `OWNER_*_USER_IDS` 兼容；复数优先。相同职能可有多个负责人。固定环境变量负责人优先于群内注册结果。测试抄送默认关闭。

`FEISHU_DOCUMENT_ARCHIVE_ENABLED=false` 可关闭归档与共享权限调整；`FEISHU_TASKS_ENABLED=false` 可关闭任务写入。数据目录由 `DATA_DIR` 指定，默认 `./data`。

## 排错

| 现象 | 检查 |
| --- | --- |
| 服务启动失败 | Node 版本、依赖安装、必填环境变量、端口占用 |
| 健康检查正常但群里无响应 | 公网 HTTPS、回调路径、事件订阅、应用发布、目标群、机器人是否被 @ |
| 回调 403 | Verification Token 是否一致；加密事件是否使用相同 Encrypt Key |
| 文档读取失败 | 文档授权、应用权限与已发布版本；wiki 是否能解析底层文档 |
| 模型失败 | key 是否启用、模型是否可用、URL 是否正确、服务商配额与超时 |
| 任务／归档失败 | 对应写权限是否发布；检查中文提示与受限日志 |
| 附件不识别 | 扩展名与正文是否可抽取；扫描 PDF、旧 DOC 请转换 |

默认日志可能包含群消息与文档元数据，勿提交公开仓库。`pnpm diagnose` 可能读取真实群消息，其输出也应保存在本地。

## 官方接口资料

- [飞书消息事件与消息 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1)
- [飞书 docx 原始文本](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content)
- [飞书 Node SDK](https://github.com/larksuite/node-sdk)
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
