<!-- SFC 试点组件（实验 docs/sfc-plugin-experiment-plan.md，2026-09-16 构建期验证通过）：
     块顺序固定为 template → script（见 rules/coding-style.md §3）；
     红线：不含 <style> 块（样式归 style/ 目录，按页面/组件拆分）。 -->
<template>
  <section class="sfc-pilot">
    <span class="sfc-pilot-label">SFC 试点</span>
    <button type="button" class="ghost" @click="count++">点击 {{ count }}</button>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);
</script>
