# 参与开发

使用 Node.js 22/24 和仓库指定版本的 pnpm。运行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test` 和 `pnpm demo`。

修改工作流时，为真实行为变化增加回归用例。测试与演示使用虚构数据，不能依赖个人 `.env` 或真实飞书服务。`archive/` 保留历史实现，常规开发只修改根目录的 `src/`。

更新卡片格式后运行 `pnpm demo` 生成卡片数据，再使用 `python scripts/render-scenes.py` 重新生成文档图片（需要 Pillow 与中文字体）。图片必须保留模拟标注，不得作为真实联调证据。
