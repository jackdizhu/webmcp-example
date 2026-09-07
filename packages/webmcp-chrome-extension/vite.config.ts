import { cpSync } from 'node:fs';
import { defineConfig } from 'vite-plus';
import type { PackUserConfig } from 'vite-plus/pack';

// 扩展外壳：主扩展与 e2e 扩展共用同一份 manifest 与 MAIN world 入口。
const manifestFile = 'shell/manifest.json';

const mainOutDir = 'dist';
const e2eOutDir = 'e2e-extension/dist';

// 两组独立扩展构建的公共配置。
//
// 关键点一：content script 是 classic script，运行时无法解析裸导入，
//   因此必须打成 IIFE 并把依赖全部内联（deps.alwaysBundle）。
// 关键点二：rolldown 的 IIFE 输出不支持多 entry（codeSplitting 开或关都会报错），
//   所以每个 entry 单独占一个 pack 组，由脚本一次 filter 多个组一起构建。
// 关键点三：同批构建的多个组并行执行，若有组开启 clean 会误删兄弟产物，
//   因此统一关闭 clean，改由脚本在构建前清理输出目录。
const extensionBase: PackUserConfig = {
  format: ['iife'],
  dts: false,
  sourcemap: false,
  treeshake: true,
  minify: false,
  target: 'chrome114',
  platform: 'browser',
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  clean: false,
};

// Vue 侧边栏组专用配置：组件模板全部用 h() 渲染函数（构建期生成，无 eval）。
// 禁止改回运行时字符串编译（vue.esm-bundler 的 new Function）——MV3 扩展页 CSP
// 为 script-src 'self'，eval 类调用会直接 EvalError 导致侧栏白屏。
// 旗标保留：缺失会在产物里残留未定义的全局标识符，IIFE 下直接 ReferenceError。
const sidePanelBase: PackUserConfig = {
  ...extensionBase,
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
};

function copyManifest(outDir: string): void {
  cpSync(manifestFile, `${outDir}/manifest.json`);
}

// 侧边栏页面是静态 HTML（样式内联其中），构建时随 manifest 一起拷入输出目录。
function copySidePanelHtml(outDir: string): void {
  cpSync('main-extension/side-panel/side-panel.html', `${outDir}/side-panel.html`);
}

export default defineConfig({
  pack: [
    // 主扩展（main-extension）：手动加载调试用，含侧边栏聊天框
    {
      ...extensionBase,
      name: 'main-extension-main-world',
      entry: { 'main-world': 'shell/main-world.ts' },
      globalName: 'WebMCPExtensionMainWorld',
      outDir: mainOutDir,
      tsconfig: './tsconfig.json',
      onSuccess: () => copyManifest(mainOutDir),
    },
    {
      ...extensionBase,
      name: 'main-extension-content-script',
      entry: { 'content-script': 'main-extension/content-script.ts' },
      globalName: 'WebMCPExtensionContentScript',
      outDir: mainOutDir,
      tsconfig: './tsconfig.json',
      onSuccess: () => copyManifest(mainOutDir),
    },
    {
      ...sidePanelBase,
      name: 'main-extension-side-panel',
      entry: { 'side-panel': 'main-extension/side-panel/index.ts' },
      globalName: 'WebMCPExtensionSidePanel',
      outDir: mainOutDir,
      tsconfig: './tsconfig.json',
      onSuccess: () => {
        copyManifest(mainOutDir);
        copySidePanelHtml(mainOutDir);
      },
    },
    {
      ...extensionBase,
      name: 'main-extension-service-worker',
      entry: { 'service-worker': 'shell/service-worker.ts' },
      globalName: 'WebMCPExtensionServiceWorker',
      outDir: mainOutDir,
      tsconfig: './tsconfig.json',
      onSuccess: () => copyManifest(mainOutDir),
    },

    // e2e 扩展（e2e-extension）：外壳与主扩展一致，content script 换成测试驱动版供 Playwright 断言。
    // manifest 为共享外壳（含 side_panel/background 引用），因此 e2e 侧也需产出
    // 侧边栏与 service worker 产物，否则 Chrome 会因 manifest 引用缺失文件而拒绝加载扩展。
    {
      ...extensionBase,
      name: 'e2e-extension-main-world',
      entry: { 'main-world': 'shell/main-world.ts' },
      globalName: 'WebMCPExtensionMainWorld',
      outDir: e2eOutDir,
      tsconfig: './tsconfig.check.json',
      onSuccess: () => copyManifest(e2eOutDir),
    },
    {
      ...extensionBase,
      name: 'e2e-extension-content-script',
      entry: { 'content-script': 'e2e-extension/content-script.ts' },
      globalName: 'WebMCPExtensionContentScript',
      outDir: e2eOutDir,
      tsconfig: './tsconfig.check.json',
      onSuccess: () => copyManifest(e2eOutDir),
    },
    {
      ...sidePanelBase,
      name: 'e2e-extension-side-panel',
      entry: { 'side-panel': 'main-extension/side-panel/index.ts' },
      globalName: 'WebMCPExtensionSidePanel',
      outDir: e2eOutDir,
      tsconfig: './tsconfig.check.json',
      onSuccess: () => {
        copyManifest(e2eOutDir);
        copySidePanelHtml(e2eOutDir);
      },
    },
    {
      ...extensionBase,
      name: 'e2e-extension-service-worker',
      entry: { 'service-worker': 'shell/service-worker.ts' },
      globalName: 'WebMCPExtensionServiceWorker',
      outDir: e2eOutDir,
      tsconfig: './tsconfig.check.json',
      onSuccess: () => copyManifest(e2eOutDir),
    },
  ],
});
