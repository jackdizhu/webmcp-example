import { defineConfig } from 'vitest/config';

// 纯逻辑单测（协议校验 / Dify 客户端 / loop 循环 / worker 处理器 / 主线程客户端），
// node 环境即可（Response/fetch/AbortController 为 Node 22 内建；worker 作用域经依赖注入）。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
