# 机器人迁移说明

此文件原先包含本机部署状态与真实用户标识，公开版本改为通用配置指引。请复制 `.env.example`，填写新应用的 App ID、App Secret、Verification Token 和可选 Encrypt Key；设置目标群、机器人显示名及职能负责人。

在新应用后台启用机器人、订阅 `im.message.receive_v1`、配置 `/feishu/events` HTTPS 回调，开通所需权限并发布。当前主线的详细步骤见根目录 `docs/SETUP.md`。不要复用他人的密钥或运行数据。
