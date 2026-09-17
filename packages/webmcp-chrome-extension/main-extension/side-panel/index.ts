// 侧边栏聊天框入口：挂载 Vue 应用（组件用 TSX 模板，构建期经 oxc 转译为
// vue/jsx-runtime 函数调用，运行时零 eval，见 issues/001）。
import { createApp } from 'vue';
import { App } from './App';

const mountPoint = document.querySelector('#app');
if (!mountPoint) {
  throw new Error('side-panel.html 中缺少 #app 挂载点');
}

createApp(App).mount(mountPoint);
