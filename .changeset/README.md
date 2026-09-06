# Changesets

本目录由 `@changesets/cli` 管理，用于记录待发布的变更。

- 创建变更记录：`pnpm changeset`
- 应用版本变更（生成 CHANGELOG）：`pnpm version`
- 发布：`pnpm release`

## 变更记录格式

- 文件：本目录下的 Markdown 文件（`pnpm changeset` 随机命名，无需手动修改）
- Frontmatter：声明目标包与升级级别（`major` / `minor` / `patch`）
- 正文：用中文概述本次变更内容，`pnpm version` 时写入对应包的 CHANGELOG

## 约定

- 基线分支：`dev-base`（见 [config.json](config.json)）
- 提交规范：`<type>(<scope>): <subject>`，详见 [AGENT.md](../AGENT.md) 与 [rules/project-rules.md](../rules/project-rules.md) 的提交规范
