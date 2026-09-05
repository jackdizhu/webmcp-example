---
name: 缺陷报告
about: 创建缺陷报告帮助我们改进
title: '[缺陷] '
labels: ['bug']
assignees: ''
---
## 描述缺陷
清晰、简洁地描述这个缺陷是什么。

## 复现步骤
1. 启动 `html-app`，执行 `pnpm --filter html-app dev`（或加载生产构建）
2. 触发某个 WebMCP 工具（如 `registerTool` 注册的「xx」）
3. 打开 `chrome-extension`，执行「发现 → 校验 → 执行」
4. 观察到如下问题：……

## 预期行为
清晰、简洁地描述你期望发生什么（工具返回结构 / 插件 UI / 校验结果）。

## 实际行为
实际发生了什么？必要时附上截图。

## 涉及模块
- [ ] packages/html-app（工具暴露 / `registerTool` / `inputSchema` / `execute`）
- [ ] packages/chrome-extension（发现 / 校验 / 执行 / 验证链路）
- [ ] 其他：____

## 环境信息
- Node.js 版本：`node -v`
- pnpm 版本：`pnpm -v`
- 浏览器：Chrome / Edge / 其他（是否开启 Experimental Web Platform features）
- 是否引入 `@mcp-b/*` polyfill：是 / 否

## 日志 / 报错
粘贴相关终端日志或报错信息（注意脱敏，勿泄露隐私与实际路径）。

## 其他补充
其他任何你认为有助于定位问题的信息。