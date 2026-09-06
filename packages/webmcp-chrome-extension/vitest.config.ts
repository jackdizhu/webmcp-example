import { defineConfig } from 'vitest/config';

// 单元测覆盖 core 与 main-extension/side-panel 下的纯逻辑（接线、agent 循环、LLM 客户端）。
// e2e 测试（e2e-extension/extension-runtime.e2e.test.ts）依赖已构建的扩展与真实 Chrome，
// 由 `pnpm --filter chrome-extension test:e2e` 通过 node 自带 test runner 单独执行，不纳入 vitest 默认范围。
export default defineConfig({
  test: {
    include: ['core/**/*.test.ts', 'main-extension/**/*.test.ts'],
    environment: 'jsdom',
  },
});
