# 验证记录

验收日期：2026-10-23。按用户确认的范围，以整体框架正确、可构建、离线流程可复现为准；不要求真实 AI API 或线上飞书全链路验收。

## 本地可重复检查

在 Windows、Node.js 24.22.1 上执行：

| 检查 | 结果与范围 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，从现有锁文件安装依赖 |
| `pnpm typecheck` | 通过，TypeScript strict |
| `pnpm test` | 通过，含编码与构建、五组测试程序 |
| `pnpm demo` | 通过，11 个场景，12 次固定样例角色审查，无网络调用 |
| 编译后启动与 `/healthz` | 使用占位配置启动入口，健康检查通过 |
| `python scripts/render-scenes.py` | 生成 11 张模拟界面 PNG，并人工检查排版 |

### 测试覆盖

- `bot-flow.test.mjs`：链接／回复消息解析、基本首审复审、事件去重、负责人优先级、抄送去重、失败重试、模型模式与输出结构。
- `workflow-v2.test.mjs`：基础附件、文字 PDF、原文档链接与快照、职能任务复用、完成与恢复、并发串行、任务失败补偿、归档权限失败降级。
- `feishu-api-contracts.test.mjs`：SDK 请求字段与响应结构，通过替身断言；不是在线权限测试。
- `store-migration.test.mjs`：历史本地状态迁移与数据保留。
- `http.test.mjs`：真实本地 HTTP 健康检查、明文 URL 验证、事件分发、错误 Token 拒绝、加密事件与签名验证、加密 URL 验证。

本次 HTTP 回归测试发现并修复：未配置 Encrypt Key 时，SDK 原逻辑允许错误 Verification Token 进入工作流。主线现显式校验明文或解密后的 Token，保留 SDK 对加密事件的签名验证。

## 演示素材如何生成

`pnpm demo` 调用主线 `ContractChatWorkflow`、真实存储、归档与任务协调器；飞书和 AI 使用内存替身。执行注册、首审、私信、去重、复审、任务历史、完成、恢复、附件、归档及记录清理，并对版本数、任务数、私信数和重复调用进行断言。

卡片输出保存到 `docs/demo/scenes.json`。`scripts/render-scenes.py` 用这些字段绘制飞书风格界面；任务与文件夹场景展示适配器记录的字段和评论摘录。图片保留“模拟飞书界面／虚构数据”标注，不代表在线执行证据。

重新生成图片需 Python、Pillow 和中文字体。Windows 默认读取微软雅黑；其他环境可设置 `SCENE_FONT` 为 Noto Sans CJK 等字体路径。

## 未纳入当前验收的项目

真实消息收发、线上文档授权、飞书任务与共享权限操作、模型结果质量及生产 HTTPS 部署，需在目标租户和服务商配置下单独验收。此前只做过飞书认证与目标群只读连通检查；它不代表完整业务已在线跑通。按用户要求停止后续真实 API 调用。

Docker 配置已提供，本机 Docker Engine 未运行，因此没有宣称镜像构建或容器部署已验证。GitHub CI 的状态以仓库 Actions 页面实际结果为准。

## 可选真实检查

仅在需要真实联调时使用；这些命令不在 CI 中执行。

```powershell
$env:LIVE_ENV_FILE="C:\path\to\your\.env"
pnpm verify:live
```

默认只测试飞书认证与配置目标群的只读访问，不发送消息、不修改任务或文档。设置 `LIVE_AI_SMOKE=1` 会向配置的模型发送虚构合同，调用一次财务审查并校验结构，可能产生服务商费用。脚本不输出凭证。

原有 `pnpm diagnose` 可进一步核对回调和权限；其中真实发消息、创建任务、创建文件夹与导入的开关应只在明确需要时开启。诊断输出可能含真实群元数据，不得提交公开仓库。
