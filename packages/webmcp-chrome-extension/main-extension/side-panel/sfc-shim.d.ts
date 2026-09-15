// SFC 试点（实验 docs/sfc-plugin-experiment-plan.md）：
// 让 TS 识别 .vue 单文件组件导入。.vue 由 @vitejs/plugin-vue 在构建期编译为渲染函数，
// 本声明仅服务类型检查，无运行时产物；解锁 SFC 后由 vue-tsc 或更精确的声明替代。
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
