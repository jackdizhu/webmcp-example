// TSX children 类型补丁（2026-09-17 TSX 改造配套）：
// Vue 3.5 的 JSX 属性类型（ReservedProps）未声明 children —— tsconfig jsx: react-jsx
// 模式下 TS 会把 JSX 子节点并入属性对象做类型检查，导致所有带子节点的元素报 TS2322
// 「Property 'children' does not exist」。ReservedProps 同时被原生元素（NativeElements）
// 与组件属性（IntrinsicAttributes）交叉引用，在此补齐 children 即全局生效。
// 类型放宽为 unknown：VNode / 数组 / 字符串 / slots 对象 / 条件渲染的 null 均放行，
// 子节点合法性由 vue/jsx-runtime 的 jsx()（内部即 h()）在运行时保证。

// 文件必须是模块（否则 declare module 会被解析为环境模块声明，覆盖 vue 原有类型）
export {};

declare module 'vue' {
  interface ReservedProps {
    children?: unknown;
  }
}
