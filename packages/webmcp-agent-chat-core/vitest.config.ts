import { defineConfig } from 'vitest/config';

// 纯逻辑单测（agent 循环 / LLM 协议适配 / 编排控制器），node 环境即可（Response/fetch 为 Node 22 内建）。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
