## 变更说明
简述本次 PR 解决的问题或新增的功能。

## 变更内容
列出关键改动点（按模块）：
- `packages/html-app`：…
- `packages/chrome-extension`：…
- `docs/` / `rules/`：…

## 变更分级
对照 `rules/design_rules.md` 附录 B：
- [ ] L1 轻微调整（CSS / 文案 / 补丁版本）
- [ ] L2 一般变更（新增工具、调整逻辑、依赖、配置默认值）
- [ ] L3 重大变更（跨层契约 / 工具 schema / 插件注入与执行链路）→ 需在描述中说明方案与评估

## 测试
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] 单元测试通过
- [ ] html-app ↔ chrome-extension 联调验证

## 检查项
- [ ] 变更文件路径与 diff 均已说明
- [ ] 未含敏感信息（密钥 / Token / 真实路径）
- [ ] 遵循单文件 ≤ 800 行、中文注释规范

## 关联 Issue
关联的 Issue 编号（如有）：#__