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
  sourcemap: true,
  treeshake: true,
  minify: false,
  target: 'chrome111',
  platform: 'browser',
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  clean: false,
};

function copyManifest(outDir: string): void {
  cpSync(manifestFile, `${outDir}/manifest.json`);
}

export default defineConfig({
  pack: [
    // 主扩展（main-extension）：手动加载调试用，控制台打印页面暴露的工具
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

    // e2e 扩展（e2e-extension）：外壳与主扩展一致，content script 换成测试驱动版供 Playwright 断言
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
  ],
});
