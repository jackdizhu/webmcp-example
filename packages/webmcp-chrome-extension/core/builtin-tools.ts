// 内置工具注册表：扩展自身提供的工具（区别于页面注册的 WebMCP 工具）。
// 双端共用一份定义（Q6 决策：方案 C 双端统一）：
// - 侧栏 agent / tools 调试：面板客户端经 attachBuiltinTools 合成清单并路由；
// - relay 端：tab-source-manager 包装 facade，listTools 合并内置描述、callTool
//   优先路由内置名 —— 外部 MCP 客户端同样可调用。
//
// **返回形态契约（重要）**：内置工具执行结果必须与页面工具一致 —— 即 MCP
// CallToolResult（`{ content: [...], isError }`）。页面侧由 WebMCP polyfill 把
// handler 返回值包装成 content 文本块；内置工具此前漏了这层包装，裸数组经
// relay-source-client 原样透传后被 relay 的 CallToolResultSchema 判为非法、
// 统一降级为 isError（现象：内置工具在 relay 端永远"失败"）。故 executeBuiltinTool
// 的返回值统一经 toBuiltinToolResult 包装（见 BuiltinToolResult）。
//
// 纯逻辑 + 依赖注入（无顶层 chrome 访问），单测经 context 注入桩。
//
// 两条产出路径的实现位置刻意不同（2026-09-12 调整）：
// - 结构大纲（outline）：**页面内**由活体 DOM 生成，只取 tag/id/class，不做标签过滤、
//   不做 sanitize —— 输出天然安全，且省掉 outerHTML 的大字符串跨上下文传输；
// - 正文纯文本（text）：扩展上下文用 sanitize-html 去标签后折叠空白（去标签须走
//   sanitize 而非正则，否则 script/style 的内容会被当成正文）。
// 故 sanitize-html 只剩 text 一处消费点；页面内采集函数必须自包含（executeScript
// 序列化执行，函数体不得引用模块级标识符）。
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

/**
 * 结果字段上限（双端一致）。
 * - outline：页面内生成时已按节点/深度上限收敛，此处仅作最终字符兜底；
 * - text：清洗压缩后的正文纯文本上限。
 */
export const DOC_OUTLINE_MAX_CHARS = 32_000;
export const DOC_TEXT_MAX_CHARS = 8_000;

/**
 * 大纲默认排除的非文本 / 低信息量子树标签（2026-09-12 决策）。
 *
 * 判据：内容以图形、二进制资源或代码为主 —— 对「页面结构与文本」没有信息量，
 * 却可能单标签就贡献成百上千个节点（典型：图标库 / 图表的 `<svg>`、内联
 * `<script>`/`<style>` 的代码文本）。
 * 需要时可经 `includeNonTextElements=true` 全量保留。
 *
 * 注：注入函数内保存同一清单的字面量副本（executeScript 序列化执行，不能引用本常量）。
 */
export const DOC_OUTLINE_NON_TEXT_TAGS = [
  // 图形
  'svg', 'canvas', 'math',
  // 媒体 / 外部嵌入
  'video', 'audio', 'picture', 'source', 'track', 'object', 'embed', 'iframe', 'frame',
  // 代码 / 模板（文本量大且非页面内容）
  'script', 'style', 'noscript', 'template',
] as const;

/**
 * 结构大纲的形态说明（供工具描述与文档引用，数值上限内联在注入函数内 —— 注入函数
 * 必须自包含，不能引用模块级标识符）。
 */
export const DOC_OUTLINE_FORMAT_HINT =
  '元素大纲：每行一个元素，格式「深度 选择器 文本」—— 深度为整数层级（根 html 为 0，子元素 +1），' +
  '选择器为 tag#id.class1.class2（无 id/class 时仅 tag），文本为该元素的直接文本节点' +
  '（折叠空白、单节点最多 80 字符、全页文本总量上限 8000 字符，耗尽后仅保留结构行并追加说明）；' +
  '**不输出缩进空格**（层级由深度数字表达，避免深层页面出现大段前导空白）；' +
  '默认排除非文本子树（svg/canvas/math、video/audio/iframe 等媒体嵌入、' +
  'script/style/noscript/template 代码模板），需要时可用 includeNonTextElements=true 保留；' +
  '仅保留结构与 id/class 及直接文本，天然不含脚本内容/事件属性等不安全内容';

export const BUILTIN_TOOLS: BuiltinToolDescriptor[] = [
  {
    name: GET_DOCUMENT_INFO_TOOL_NAME,
    description:
      '获取当前选中页签（默认为打开侧栏时的活动页签）的文档信息。' +
      '返回数组，每个选中页签一个元素，含 URL、标题、readyState、字符集、meta、' +
      '标题大纲、DOM/链接/图片等计数。' +
      `可选返回元素结构大纲（includeOutline，${DOC_OUTLINE_FORMAT_HINT}）与清洗压缩后的` +
      '正文纯文本（includeText）；两开关默认关闭，防止无效大文本污染上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        includeOutline: {
          type: 'boolean',
          description:
            `返回页面元素结构大纲（${DOC_OUTLINE_FORMAT_HINT}；截断上限 ${DOC_OUTLINE_MAX_CHARS} 字符），默认 false`,
        },
        includeText: {
          type: 'boolean',
          description: `返回清洗并压缩空白后的正文纯文本（截断上限 ${DOC_TEXT_MAX_CHARS} 字符），默认 false`,
        },
        includeNonTextElements: {
          type: 'boolean',
          description:
            '结构大纲是否保留非文本子树（svg/canvas/math、媒体与外部嵌入、script/style 等）；' +
            `默认 false = 排除 ${DOC_OUTLINE_NON_TEXT_TAGS.join('/')} 以节省空间，仅在明确需要图形或脚本节点时才开启`,
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

/** 页面内采集的原始文档信息（outline / rawHtml 均按需采集，仅供扩展上下文加工）。 */
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
  /** 元素结构大纲（includeOutline=true 时采集）。 */
  outline?: string;
  /** outerHTML 原文（仅 text 抽取需要，不在工具结果里出现）。 */
  rawHtml?: string;
}

/** 页面内采集开关（注入函数的入参，须 JSON 可序列化）。 */
export interface DocumentCollectOptions {
  /** 生成元素大纲（每行 `<深度> <选择器>`；根 html 深度 0）。 */
  outline: boolean;
  /** 采集 outerHTML 原文（扩展上下文据此抽取纯文本）。 */
  rawHtml: boolean;
  /** 大纲是否保留非文本子树（svg/script/media 等；默认 false = 排除）。 */
  includeNonTextElements: boolean;
}

/**
 * 页面内文档信息采集函数。约束：executeScript 把函数序列化后注入页面执行，
 * 函数体不得引用任何外部标识符（本函数内所有列表/上限均为字面量）。
 *
 * 元素大纲在页面内直接从活体 DOM 生成：**以 `html` 元素为根**，每个元素降级为
 * `深度 选择器 文本` 一行 —— 只取 tag/id/class 与**直接文本节点**，天然不含脚本内容
 * 与事件属性等不安全内容，无需 sanitize 清洗，也省掉 outerHTML 的大字符串跨上下文传输。
 *
 * 层级用**深度数字前缀**而非空格缩进（2026-09-12 实测优化）：缩进是「可推导信息」
 * 却按字面存储 —— 真实页面下前导空格曾占大纲 82.7% 字符，改用 1~2 字符的深度前缀后
 * 同样内容体积降至约 1/4（如 `11 li.nav-item` 取代 22 个空格 + 选择器）。
 *
 * 文本节点（2026-09-12 补齐）：此前遍历只用 `el.children`（Element-only），所有文本
 * 节点丢失 —— 页面语义大部分在文本里，仅有骨架的大纲信息密度不足。现对每个元素取
 * `childNodes` 中 `nodeType === 3` 的**直接**文本节点内联到行尾（不重复子元素文本，
 * 选择器不含空格故无歧义）；折叠空白、纯空白跳过、单节点截断、全页文本总预算兜底，
 * 预算耗尽后结构行继续完整输出，末尾追加一行说明（用户决策：预算耗尽要有感知）。
 *
 * 默认排除非文本子树（见 DOC_OUTLINE_NON_TEXT_TAGS，注入函数内为字面量副本）：
 * 排除为**静默**行为，不向大纲追加任何说明行（大纲只承载页面内容，元信息会污染
 * 内容）；仅节点上限与文本预算触发时保留说明行。
 */
export function collectDocumentInfoInPage(options: DocumentCollectOptions): RawDocumentInfo {
  // 大纲上限与排除清单（字面量：注入函数必须自包含）
  const MAX_NODES = 1200;
  const MAX_SELECTOR_CHARS = 120;
  const MAX_TEXT_PER_NODE = 80;
  const MAX_TEXT_TOTAL = 8000;
  const NON_TEXT_TAGS = [
    'svg', 'canvas', 'math',
    'video', 'audio', 'picture', 'source', 'track', 'object', 'embed', 'iframe', 'frame',
    'script', 'style', 'noscript', 'template',
  ];
  const keepNonText = options.includeNonTextElements === true;

  /** 生成元素大纲（每行 `<depth> <selector> [text]`；根 html 深度为 0）。 */
  const buildOutline = (): string => {
    const root = document.documentElement ?? document.body;
    if (!root) return '';
    const lines: string[] = [];
    let truncated = false;
    let textBudget = MAX_TEXT_TOTAL;
    let textExhausted = false;

    const selectorOf = (el: Element): string => {
      let selector = el.tagName.toLowerCase();
      const id = el.getAttribute('id');
      if (id) selector += `#${id}`;
      const className = el.getAttribute('class');
      if (className) {
        for (const name of className.split(/\s+/)) {
          if (name.length > 0) selector += `.${name}`;
        }
      }
      return selector.length > MAX_SELECTOR_CHARS
        ? `${selector.slice(0, MAX_SELECTOR_CHARS)}…`
        : selector;
    };

    /** 元素的直接文本（childNodes 中文本节点拼接；不含子元素文本，避免重复）。 */
    const directTextOf = (el: Element): string => {
      let raw = '';
      for (const node of el.childNodes) {
        if (node.nodeType === 3) raw += node.nodeValue ?? '';
      }
      return raw.replace(/\s+/g, ' ').trim();
    };

    const walk = (el: Element, depth: number): void => {
      if (lines.length >= MAX_NODES) {
        truncated = true;
        return;
      }
      const tag = el.tagName.toLowerCase();
      if (!keepNonText && NON_TEXT_TAGS.indexOf(tag) >= 0) return; // 静默排除整棵子树
      let line = `${String(depth)} ${selectorOf(el)}`;
      if (!textExhausted) {
        const text = directTextOf(el);
        if (text.length > 0) {
          const clipped = text.slice(0, Math.min(text.length, MAX_TEXT_PER_NODE, textBudget));
          line += ` ${clipped}${clipped.length < text.length ? '…' : ''}`;
          textBudget -= clipped.length;
          if (textBudget <= 0) textExhausted = true;
        }
      }
      lines.push(line);
      for (const child of Array.from(el.children)) walk(child, depth + 1);
    };

    walk(root, 0);
    if (truncated) {
      lines.push(`…(已达节点上限 ${String(MAX_NODES)} 行，其余未展开)`);
    }
    if (textExhausted) {
      lines.push(
        `…(文本预算已用尽（全页文本上限 ${String(MAX_TEXT_TOTAL)} 字符），后续元素文本未收录)`
      );
    }
    return lines.join('\n');
  };

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
  if (options.outline) info.outline = buildOutline();
  if (options.rawHtml) info.rawHtml = doc.documentElement.outerHTML;
  return info;
}

// ---- 文本抽取（扩展上下文执行；sanitize-html 无 DOM 依赖，可打进 IIFE）----
//
// 注意：结构大纲不在这里加工 —— 它在页面内直接由活体 DOM 生成（只取 tag/id/class，
// 天然安全且更省传输）。sanitize-html 仅用于把 outerHTML 原文降级为正文纯文本。

/** 超长值截断并标注省略长度。 */
export function truncateWithMarker(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…(+${value.length - maxChars})` : value;
}

/**
 * 纯文本抽取默认丢弃内容的标签（与大纲的非文本排除集同源；`sanitize-html` 的
 * `nonTextTags` 是**整表覆盖**语义，故必须原样带上它的默认项）。
 */
export const SANITIZE_NON_TEXT_TAGS = [
  // sanitize-html 默认项（覆盖时必须保留）
  'script', 'style', 'textarea', 'option', 'xmp',
  // 图形 / 媒体 / 外部嵌入 / 模板（与 DOC_OUTLINE_NON_TEXT_TAGS 对应）
  'svg', 'canvas', 'math', 'video', 'audio', 'picture', 'source', 'track',
  'object', 'embed', 'iframe', 'frame', 'noscript', 'template',
];

/** 纯文本抽取选项。 */
export interface DocumentTextOptions {
  /** 截断上限（默认 DOC_TEXT_MAX_CHARS）。 */
  maxChars?: number;
  /**
   * 是否保留非文本子树内文本（svg/canvas 图形、媒体、代码模板），默认 false。
   * 与大纲的 `includeNonTextElements` 同一语义，保证两路产出对同一开关行为一致。
   */
  includeNonTextElements?: boolean;
}

/**
 * 从 outerHTML 原文抽取正文纯文本：sanitize-html 去标签后折叠连续空白并按上限截断。
 * 走 sanitize 而非正则去标签，是为了同时按 nonTextTags 丢弃 script/style/option 等
 * 非正文内容（否则脚本代码、下拉项会混进正文）。
 */
export function sanitizeDocumentText(
  rawHtml: string,
  options: DocumentTextOptions = {}
): string {
  return truncateWithMarker(
    sanitizeHtml(rawHtml, {
      allowedTags: [],
      allowedAttributes: {},
      nonTextTags: options.includeNonTextElements === true ? [] : SANITIZE_NON_TEXT_TAGS,
    })
      .replace(/\s+/g, ' ')
      .trim(),
    options.maxChars ?? DOC_TEXT_MAX_CHARS
  );
}

// ---- 工具执行 ----

/** 工具结果中的单元素（基础元信息 + 按需 outline/text + 来源页签）。 */
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
  /** 元素结构大纲（includeOutline=true 时存在）。 */
  outline?: string;
  /** 正文纯文本（includeText=true 时存在）。 */
  text?: string;
  error?: string;
}

/** 内置工具执行上下文（依赖注入；默认实现走 chrome.scripting / SW selection）。 */
export interface BuiltinToolContext {
  /** 当前选中页签（Q4 决策：每个选中页签一个返回元素）。 */
  getSelectedTabIds(): number[] | Promise<number[]>;
  /** 单页签采集（默认 chrome.scripting.executeScript 注入；测试注入桩）。 */
  collectFromTab?(
    tabId: number,
    options: DocumentCollectOptions
  ): Promise<RawDocumentInfo | null>;
}

/**
 * 内置工具执行结果：MCP CallToolResult 形态（与页面工具结果同构）。
 *
 * 强约束返回形状的原因：relay 端 bridgeServer 用 `CallToolResultSchema` 校验浏览器
 * 侧回传结果，非法负载会被降级为 `isError: true`（错误文本 "Tool returned an invalid
 * result (expected {content: [...]})"）。内置工具若直接返回裸数组，就会命中该降级分支。
 */
export interface BuiltinToolResult {
  /** 文本内容块（当前内置工具统一以 JSON 文本承载数据）。 */
  content: Array<{ type: 'text'; text: string }>;
  /** 工具级错误标记；单页签失败以元素内 error 字段表达，不置位此标记。 */
  isError: boolean;
}

/** 把内置工具的业务数据包装为 MCP CallToolResult（内置工具返回值的唯一出口）。 */
export function toBuiltinToolResult(payload: unknown): BuiltinToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) ?? 'null' }],
    isError: false,
  };
}

/** 默认单页签采集：chrome.scripting.executeScript（ISOLATED world，DOM 共享）。 */
export async function defaultCollectFromTab(
  tabId: number,
  options: DocumentCollectOptions
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
    args: [options],
  });
  return results[0]?.result ?? null;
}

/**
 * 执行内置工具（未知工具名抛错，调用方应先用 isBuiltinTool 路由）。
 *
 * 返回 MCP CallToolResult（见 BuiltinToolResult）：content[0] 为 JSON 文本，负载是
 * 「每个选中页签一个元素」的数组；单页签失败不阻断其余页签（该元素带 error，
 * 整体仍为 isError: false）。
 */
export async function executeBuiltinTool(
  name: string,
  args: Record<string, unknown> | undefined,
  context: BuiltinToolContext
): Promise<BuiltinToolResult> {
  if (name !== GET_DOCUMENT_INFO_TOOL_NAME) {
    throw new Error(`未知内置工具：${name}`);
  }
  const includeOutline = args?.['includeOutline'] === true;
  const includeText = args?.['includeText'] === true;
  const includeNonTextElements = args?.['includeNonTextElements'] === true;
  const tabIds = await context.getSelectedTabIds();
  const collect = context.collectFromTab ?? defaultCollectFromTab;
  const entries: DocumentInfoEntry[] = [];
  for (const tabId of tabIds) {
    try {
      // outline 在页面内生成（无需 outerHTML）；rawHtml 仅为 text 抽取所需
      const raw = await collect(tabId, {
        outline: includeOutline,
        rawHtml: includeText,
        includeNonTextElements,
      });
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
      if (includeOutline && raw.outline !== undefined) {
        entry.outline = truncateWithMarker(raw.outline, DOC_OUTLINE_MAX_CHARS);
      }
      if (includeText && raw.rawHtml !== undefined) {
        entry.text = sanitizeDocumentText(raw.rawHtml, { includeNonTextElements });
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
  // 统一包装：两处路由点（tab-source-manager facade / 侧栏 attachBuiltinTools）
  // 原样透传即可满足 MCP CallToolResult 契约（详见 BuiltinToolResult 注释）
  return toBuiltinToolResult(entries);
}
