// 内置工具注册表：扩展自身提供的工具（区别于页面注册的 WebMCP 工具）。
// 双端共用一份定义（Q6 决策：方案 C 双端统一）：
// - 侧栏 agent / tools 调试：App 把 BUILTIN_TOOLS 合并进工具清单，并在 executeTool
//   前拦截内置名（isBuiltinTool）；
// - relay 端：tab-source-manager 包装 facade，listTools 合并内置描述、callTool
//   优先路由内置名 —— 外部 MCP 客户端同样可调用。
//
// 纯逻辑 + 依赖注入（无顶层 chrome 访问），单测经 context 注入桩。
// 清洗依赖 sanitize-html（Node 生态库、无 DOM 依赖，vite 可打进浏览器 IIFE），
// 仅在扩展上下文使用；页面内采集函数必须自包含（executeScript 序列化执行）。
import sanitizeHtml from 'sanitize-html';

// ---- 工具名 ----

/** R5.1：获取文档信息工具（内置命名空间 chrome_extension_*，页面工具不得占用）。 */
export const GET_DOCUMENT_INFO_TOOL_NAME = 'chrome_extension_get_document_info';

/** 内置工具名判定（页面侧与内置重名时内置优先，见 mergeBuiltinWithPageTools）。 */
export function isBuiltinTool(name: string): boolean {
  return name === GET_DOCUMENT_INFO_TOOL_NAME;
}

// ---- 工具描述（AgentTool / RelayToolDescriptor 共用形态，schema 原样透传给 LLM）----

export interface BuiltinToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** html / text 字段截断上限（propose 定值，双端一致）。 */
export const DOC_HTML_MAX_CHARS = 32_000;
export const DOC_TEXT_MAX_CHARS = 8_000;

export const BUILTIN_TOOLS: BuiltinToolDescriptor[] = [
  {
    name: GET_DOCUMENT_INFO_TOOL_NAME,
    description:
      '获取当前选中页签（默认为打开侧栏时的活动页签）的文档信息。' +
      '返回数组，每个选中页签一个元素，含 URL、标题、readyState、字符集、meta、' +
      '标题大纲、DOM/链接/图片等计数。' +
      '可选返回经 sanitize-html 清洗后的 HTML（includeHtml）与清洗压缩后的正文纯文本' +
      '（includeText）；两开关默认关闭，防止无效大文本污染上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        includeHtml: {
          type: 'boolean',
          description: `返回经 sanitize-html 清洗后的 HTML（截断上限 ${DOC_HTML_MAX_CHARS} 字符），默认 false`,
        },
        includeText: {
          type: 'boolean',
          description: `返回清洗并压缩空白后的正文纯文本（截断上限 ${DOC_TEXT_MAX_CHARS} 字符），默认 false`,
        },
      },
      additionalProperties: false,
    },
  },
];

/**
 * 内置工具 + 页面工具清单合并：内置描述在前；
 * 页面工具占用内置命名空间（chrome_extension_*）时剔除（内置优先）。
 */
export function mergeBuiltinWithPageTools<T extends { name: string }>(
  pageTools: readonly T[]
): Array<BuiltinToolDescriptor | T> {
  return [...BUILTIN_TOOLS, ...pageTools.filter((tool) => !isBuiltinTool(tool.name))];
}

// ---- 页面内采集（自包含，经 chrome.scripting.executeScript 注入执行）----

/** 页面内采集的原始文档信息（rawHtml 仅供扩展上下文清洗，不出现在工具结果里）。 */
export interface RawDocumentInfo {
  url: string;
  title: string;
  readyState: string;
  characterSet: string;
  contentType: string;
  doctype: string;
  viewport: string;
  lang: string;
  meta: Record<string, string>;
  counts: { domNodes: number; links: number; images: number; scripts: number; iframes: number };
  headings: Array<{ level: number; text: string }>;
  rawHtml?: string;
}

/**
 * 页面内文档信息采集函数。约束：executeScript 把函数序列化后注入页面执行，
 * 函数体不得引用任何外部标识符；includeHtml=false 时不采集 outerHTML
 * （省一次大字符串跨上下文传输，双开关全关时的默认路径）。
 */
export function collectDocumentInfoInPage(includeHtml: boolean): RawDocumentInfo {
  const doc = document;
  const meta: Record<string, string> = {};
  for (const node of doc.querySelectorAll('meta[name], meta[property]')) {
    const key = node.getAttribute('name') ?? node.getAttribute('property');
    const content = node.getAttribute('content');
    if (key && content !== null && content.length > 0) meta[key] = content;
  }
  const headings: Array<{ level: number; text: string }> = [];
  for (const node of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0) continue;
    headings.push({ level: Number(node.tagName.charAt(1)), text: text.slice(0, 200) });
    if (headings.length >= 50) break;
  }
  const info: RawDocumentInfo = {
    url: doc.URL,
    title: doc.title,
    readyState: doc.readyState,
    characterSet: doc.characterSet,
    contentType: doc.contentType,
    doctype: doc.doctype ? doc.doctype.name.toLowerCase() : '',
    viewport: meta['viewport'] ?? '',
    lang: doc.documentElement?.lang ?? '',
    meta,
    counts: {
      domNodes: doc.getElementsByTagName('*').length,
      links: doc.querySelectorAll('a[href]').length,
      images: doc.querySelectorAll('img').length,
      scripts: doc.querySelectorAll('script').length,
      iframes: doc.querySelectorAll('iframe, frame').length,
    },
    headings,
  };
  if (includeHtml) info.rawHtml = doc.documentElement.outerHTML;
  return info;
}

// ---- 清洗压缩（扩展上下文执行；sanitize-html 无 DOM 依赖，可打进 IIFE）----

/** sanitize-html 清洗配置：保留文档结构与基础属性，剥离脚本/事件/危险嵌入。 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  // 默认白名单（标题/段落/表格/列表/img 等）+ 文档结构标签
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'html', 'head', 'body', 'title', 'meta', 'link',
    'header', 'footer', 'main', 'nav', 'section', 'article', 'aside',
    'figure', 'figcaption', 'form', 'input', 'button', 'select',
    'option', 'textarea', 'label', 'fieldset', 'legend', 'datalist',
    'video', 'audio', 'source', 'track', 'picture',
  ],
  allowedAttributes: {
    '*': ['class', 'id'],
    meta: ['name', 'content', 'charset', 'property', 'http-equiv'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    input: ['type', 'name', 'value', 'placeholder', 'checked', 'disabled'],
    select: ['name'],
    option: ['value', 'selected'],
    textarea: ['name', 'placeholder', 'rows', 'cols'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    ol: ['start', 'type', 'reversed'],
    font: ['color', 'face', 'size'],
  },
  // 协议白名单沿用默认（http/https/ftp/mailto），禁协议相对 URL（//host）
  allowedSchemes: sanitizeHtml.defaults.allowedSchemes,
  allowProtocolRelative: false,
};

/** 清洗 + 按需压缩：html 保留结构（截断），text 去标签折叠空白（截断）。 */
export function sanitizeDocumentContent(
  rawHtml: string,
  limits: { htmlMaxChars: number; textMaxChars: number } = {
    htmlMaxChars: DOC_HTML_MAX_CHARS,
    textMaxChars: DOC_TEXT_MAX_CHARS,
  }
): { html: string; text: string } {
  const truncate = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max)}…(+${value.length - max})` : value;
  const html = truncate(sanitizeHtml(rawHtml, SANITIZE_OPTIONS), limits.htmlMaxChars);
  const text = truncate(
    sanitizeHtml(rawHtml, { allowedTags: [], allowedAttributes: {} })
      .replace(/\s+/g, ' ')
      .trim(),
    limits.textMaxChars
  );
  return { html, text };
}

// ---- 工具执行 ----

/** 工具结果中的单元素（基础元信息 + 按需 html/text + 来源页签）。 */
export interface DocumentInfoEntry {
  tabId: number;
  url: string;
  title: string;
  readyState: string;
  characterSet: string;
  contentType: string;
  doctype: string;
  viewport: string;
  lang: string;
  meta: Record<string, string>;
  counts: { domNodes: number; links: number; images: number; scripts: number; iframes: number };
  headings: Array<{ level: number; text: string }>;
  html?: string;
  text?: string;
  error?: string;
}

/** 内置工具执行上下文（依赖注入；默认实现走 chrome.scripting / SW selection）。 */
export interface BuiltinToolContext {
  /** 当前选中页签（Q4 决策：每个选中页签一个返回元素）。 */
  getSelectedTabIds(): number[] | Promise<number[]>;
  /** 单页签采集（默认 chrome.scripting.executeScript 注入；测试注入桩）。 */
  collectFromTab?(tabId: number, includeRawHtml: boolean): Promise<RawDocumentInfo | null>;
}

/** 默认单页签采集：chrome.scripting.executeScript（ISOLATED world，DOM 共享）。 */
export async function defaultCollectFromTab(
  tabId: number,
  includeRawHtml: boolean
): Promise<RawDocumentInfo | null> {
  type ScriptingLike = {
    executeScript<T = unknown>(details: {
      target: { tabId: number };
      func?: (...args: never[]) => T;
      args?: unknown[];
    }): Promise<Array<{ result?: T }>>;
  };
  const scripting = (globalThis as { chrome?: { scripting?: ScriptingLike } }).chrome?.scripting;
  if (!scripting) {
    throw new Error('chrome.scripting 不可用（缺少 scripting 权限或非扩展上下文）');
  }
  const results = await scripting.executeScript({
    target: { tabId },
    func: collectDocumentInfoInPage,
    args: [includeRawHtml],
  });
  return results[0]?.result ?? null;
}

/**
 * 执行内置工具（未知工具名抛错，调用方应先用 isBuiltinTool 路由）。
 * 返回数组：每个选中页签一个元素；单页签失败不阻断其余页签（该元素带 error）。
 */
export async function executeBuiltinTool(
  name: string,
  args: Record<string, unknown> | undefined,
  context: BuiltinToolContext
): Promise<unknown> {
  if (name !== GET_DOCUMENT_INFO_TOOL_NAME) {
    throw new Error(`未知内置工具：${name}`);
  }
  const includeHtml = args?.['includeHtml'] === true;
  const includeText = args?.['includeText'] === true;
  const tabIds = await context.getSelectedTabIds();
  const collect = context.collectFromTab ?? defaultCollectFromTab;
  const entries: DocumentInfoEntry[] = [];
  for (const tabId of tabIds) {
    try {
      // html / text 均需页面侧先取 rawHtml（双开关全关时不采集）
      const raw = await collect(tabId, includeHtml || includeText);
      if (!raw) {
        entries.push({ tabId, url: '', title: '', readyState: '', characterSet: '', contentType: '', doctype: '', viewport: '', lang: '', meta: {}, counts: { domNodes: 0, links: 0, images: 0, scripts: 0, iframes: 0 }, headings: [], error: '页面采集无返回' });
        continue;
      }
      // 显式构造而非展开：exactOptionalPropertyTypes 下避免可选字段弱化
      const entry: DocumentInfoEntry = {
        tabId,
        url: raw.url,
        title: raw.title,
        readyState: raw.readyState,
        characterSet: raw.characterSet,
        contentType: raw.contentType,
        doctype: raw.doctype,
        viewport: raw.viewport,
        lang: raw.lang,
        meta: raw.meta,
        counts: raw.counts,
        headings: raw.headings,
      };
      if ((includeHtml || includeText) && raw.rawHtml !== undefined) {
        const sanitized = sanitizeDocumentContent(raw.rawHtml);
        if (includeHtml) entry.html = sanitized.html;
        if (includeText) entry.text = sanitized.text;
      }
      entries.push(entry);
    } catch (error) {
      entries.push({
        tabId,
        url: '',
        title: '',
        readyState: '',
        characterSet: '',
        contentType: '',
        doctype: '',
        viewport: '',
        lang: '',
        meta: {},
        counts: { domNodes: 0, links: 0, images: 0, scripts: 0, iframes: 0 },
        headings: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return entries;
}
