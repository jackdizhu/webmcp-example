// 侧栏全局 i18n（模块级响应式 store，P0）：
// - locale 为模块级 ref：组件在 h() 渲染函数内调用 t()（内部读取 locale.value），
//   切换语言时依赖被追踪、整树自动重渲染 —— 与 MV3 CSP 禁模板编译的 h() 架构天然契合。
// - 持久化：chrome.storage.local 键 sidePanelLocale；首次使用回退 navigator.language
//   （zh 开头 → zh-CN，否则 en-US）。
// - 环境护栏：chrome.storage / document 不存在（vitest 纯逻辑环境）时降级为内存态，
//   不抛错 —— t() 始终可用。
// - 文案键以 zh-CN.ts 为基准（MessageKey），en-US.ts 用 Record<MessageKey, string> 锁死一一对应。
import { ref } from 'vue';
import { zhCN, type MessageKey } from './zh-CN';
import { enUS } from './en-US';

/** 支持的语言。 */
export type Locale = 'zh-CN' | 'en-US';

/** chrome.storage.local 中的持久化键。 */
export const LOCALE_STORAGE_KEY = 'sidePanelLocale';

const DICTS: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/** 当前语言（模块级单例；渲染函数内读取即建立响应式依赖）。 */
export const locale = ref<Locale>('zh-CN');

/** chrome.storage.local 最小结构面（便于测试注入桩）。 */
interface LocaleStorageLike {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

/** 默认存储实现：chrome.storage.local；不可用（非扩展环境）返回 null。 */
function defaultStorage(): LocaleStorageLike | null {
  const storage = (globalThis as { chrome?: { storage?: { local?: LocaleStorageLike } } }).chrome?.storage?.local;
  return storage ?? null;
}

/** 把 <html lang> 同步为当前语言（扩展页环境守卫：无 document 时跳过）。 */
function syncDocumentLang(next: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

/**
 * 初始化语言：已保存值优先；否则按浏览器语言回退。
 * 在 App onMounted 最早期调用（先于任何可能入列的动态消息）。
 */
export async function initLocale(storage: LocaleStorageLike | null = defaultStorage()): Promise<void> {
  if (storage !== null) {
    try {
      const result = await storage.get([LOCALE_STORAGE_KEY]);
      const saved = result[LOCALE_STORAGE_KEY];
      if (saved === 'zh-CN' || saved === 'en-US') {
        locale.value = saved;
        syncDocumentLang(saved);
        return;
      }
    } catch {
      // 存储读取失败：按浏览器语言回退（下方统一处理）
    }
  }
  const navLang = typeof navigator !== 'undefined' ? navigator.language : 'zh-CN';
  locale.value = navLang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
  syncDocumentLang(locale.value);
}

/** 切换语言：内存态 + <html lang> + 持久化（持久化失败不阻塞 UI 切换）。 */
export function setLocale(next: Locale, storage: LocaleStorageLike | null = defaultStorage()): void {
  locale.value = next;
  syncDocumentLang(next);
  if (storage !== null) {
    void storage.set({ [LOCALE_STORAGE_KEY]: next }).catch(() => {
      // 持久化失败仅影响下次打开时的记忆，UI 已切换成功
    });
  }
}

/**
 * 取文案：当前语言字典 → zh-CN 兜底 → 键名兜底（缺键在 UI 上显形，便于发现漏翻）。
 * params 以 {name} 占位符替换（String 值直接拼接）。
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const dict = DICTS[locale.value];
  let text: string = dict[key] ?? DICTS['zh-CN'][key] ?? key;
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** 语言相关的列表连接符：中文顿号 / 英文逗号（A2A 同步失败名单等场景）。 */
export function joinList(items: string[]): string {
  return items.join(locale.value === 'en-US' ? ', ' : '、');
}
