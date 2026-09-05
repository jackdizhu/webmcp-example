# 问题反馈

问题反馈渠道：[Issue](https://github.com/<owner>/webmcp-example/issues)

## Issue 模板

模板统一存放于仓库根目录 `.github/ISSUE_TEMPLATE/`（GitHub 新建 Issue 时自动应用），本目录不再保存模板副本：

| 文件 | 用途 |
|---|---|
| `bug_report.md` | 缺陷报告（标签：bug） |
| `feature_request.md` | 功能建议（标签：enhancement） |
| `question.md` | 问题咨询（标签：question） |
| `config.yml` | 模板选择器配置（禁止空白 Issue） |

> 维护提示：模板修改请直接编辑 `.github/ISSUE_TEMPLATE/` 下对应文件。

## 本目录说明

本目录用于沉淀已记录/已解决的问题（含根因分析与方案），编号格式：`NNN-简短描述.md`。待处理问题请走 GitHub Issue。

## 已记录的问题

| 文件 | 问题描述 | 状态 |
|---|---|---|
| `001-vue-runtime-template-csp-eval.md` | 侧边栏白屏：Vue 运行时模板编译触发 MV3 CSP EvalError | ✅ 已解决 |