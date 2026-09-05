// 侧边栏聊天框入口：挂载 Vue 应用（vue 走默认 runtime 构建，组件用 h() 渲染函数，见 issues/001）。
import { createApp } from 'vue';
import { App } from './App';

const mountPoint = document.querySelector('#app');
if (!mountPoint) {
  throw new Error('side-panel.html 中缺少 #app 挂载点');
}

createApp(App).mount(mountPoint);
