import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Node 端全局（构建脚本 .mjs 等使用）
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  globalThis: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'writable',
  require: 'writable',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  queueMicrotask: 'readonly',
};

// 浏览器端全局（content-script / html-app 等使用）
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  self: 'readonly',
  fetch: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  HTMLElement: 'readonly',
  HTMLDivElement: 'readonly',
  HTMLFormElement: 'readonly',
  Node: 'readonly',
  FormData: 'readonly',
  AbortController: 'readonly',
  Promise: 'readonly',
  addEventListener: 'readonly',
  removeEventListener: 'readonly',
};

// 扁平化 ESLint 配置，覆盖 packages/* 下全部 TypeScript 源码与 Node 脚本。
// 采用非类型感知的 recommended 规则集，避免依赖各包 tsconfig，保证 monorepo 一致可跑。
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/e2e/dist/**',
      '**/template/dist/**',
      'git-source/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...nodeGlobals,
        ...browserGlobals,
      },
    },
    rules: {
      // 移植代码与上游 SDK 类型较宽松，关闭显式 any 限制
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
