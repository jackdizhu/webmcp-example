// TSX 试点组件（自 SFC 试点迁移，2026-09-17）：验证 TSX（oxc 构建期转译为
// vue/jsx-runtime 函数调用）在 MV3 CSP 下渲染与响应式完整。
// 红线不变：运行时字符串模板/eval 禁止；样式归 style/ 目录（组件文件零 <style>）。
import { defineComponent, ref } from 'vue';

export const PilotHello = defineComponent({
  name: 'PilotHello',
  setup() {
    const count = ref(0);
    return () => (
      <section class="sfc-pilot">
        <span class="sfc-pilot-label">TSX 试点</span>
        <button type="button" class="ghost" onClick={() => count.value++}>
          点击 {count.value}
        </button>
      </section>
    );
  },
});
