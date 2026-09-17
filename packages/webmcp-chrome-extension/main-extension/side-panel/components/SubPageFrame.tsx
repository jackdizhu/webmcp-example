// 子页面框架（components/，2026-09-13 页面拆分改造）：编辑/新增等操作页的统一外壳。
// 结构 = 返回 icon（SVG 左箭头）+ 标题栏 + 内容区；点击返回回抛 back 事件，
// 由宿主页面切回只读列表态（返回即离开，草稿语义由各子页面内容自行决定）。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
// 文案经全局 i18n store（t() 直读 locale ref）。
import { defineComponent } from 'vue';
import { t } from '../i18n';

export const SubPageFrame = defineComponent({
  name: 'SubPageFrame',
  props: {
    /** 子页面标题栏文案（如「新增绑定」「编辑配置」）。 */
    title: { type: String, required: true },
  },
  emits: {
    /** 点击返回 icon：宿主切回只读列表页。 */
    back: null,
  },
  setup(props, { emit, slots }) {
    return () => (
      <div class="subpage">
        <div class="subpage-header">
          <button
            class="subpage-back"
            type="button"
            title={t('common.back')}
            aria-label={t('common.back')}
            onClick={() => emit('back')}
          >
            {/* 返回箭头 icon（stroke=currentColor 跟随主题色） */}
            <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true">
              <path
                d="M10.5 3 5.5 8l5 5"
                fill="none"
                stroke="currentColor"
                stroke-width={1.8}
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <span class="subpage-title">{props.title}</span>
        </div>
        <div class="subpage-body">{slots.default?.()}</div>
      </div>
    );
  },
});
