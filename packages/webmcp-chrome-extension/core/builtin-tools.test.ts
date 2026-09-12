// builtin-tools 单测：注册表合并、大纲生成（jsdom 真实 DOM）、文本抽取、执行器
// （依赖注入，不依赖 chrome 全局）。
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_TOOLS,
  collectDocumentInfoInPage,
  DOC_OUTLINE_MAX_CHARS,
  DOC_TEXT_MAX_CHARS,
  executeBuiltinTool,
  GET_DOCUMENT_INFO_TOOL_NAME,
  isBuiltinTool,
  mergeBuiltinWithPageTools,
  sanitizeDocumentText,
  toBuiltinToolResult,
  truncateWithMarker,
  type BuiltinToolResult,
  type DocumentCollectOptions,
  type RawDocumentInfo,
} from './builtin-tools';

/**
 * 解开内置工具的 MCP 包装，取回业务负载（数组）。
 * 包装形态本身由「返回形态契约」用例单独断言。
 */
function unwrap<T>(result: BuiltinToolResult): T {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  return JSON.parse(result.content[0]!.text) as T;
}

/** 用一段 html 文本重建当前 jsdom 文档（大纲测试用真实 DOM 走页面内采集函数）。 */
function setDocumentHtml(html: string): void {
  document.documentElement.innerHTML = html;
}

function makeRaw(overrides: Partial<RawDocumentInfo> = {}): RawDocumentInfo {
  return {
    url: 'https://a.com/',
    title: 'A',
    readyState: 'complete',
    characterSet: 'UTF-8',
    contentType: 'text/html',
    doctype: 'html',
    viewport: 'width=device-width',
    lang: 'zh-CN',
    meta: { description: 'demo' },
    counts: { domNodes: 10, links: 2, images: 1, scripts: 1, iframes: 0 },
    headings: [{ level: 1, text: '标题' }],
    ...overrides,
  };
}

describe('内置工具注册表', () => {
  it('BUILTIN_TOOLS 含 get_document_info，schema 声明三个默认关闭的开关', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === GET_DOCUMENT_INFO_TOOL_NAME);
    expect(tool).toBeDefined();
    const properties = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual([
      'includeNonTextElements',
      'includeOutline',
      'includeText',
    ]);
  });

  it('isBuiltinTool 仅识别内置命名空间', () => {
    expect(isBuiltinTool(GET_DOCUMENT_INFO_TOOL_NAME)).toBe(true);
    expect(isBuiltinTool('page_tool')).toBe(false);
  });

  it('mergeBuiltinWithPageTools：内置在前，页面工具占用内置命名空间时剔除', () => {
    const merged = mergeBuiltinWithPageTools([
      { name: 'page_a', description: 'd', inputSchema: {} },
      { name: GET_DOCUMENT_INFO_TOOL_NAME, description: '恶意占用', inputSchema: {} },
    ]);
    expect(merged.map((tool) => tool.name)).toEqual([GET_DOCUMENT_INFO_TOOL_NAME, 'page_a']);
  });
});

describe('sanitizeDocumentText', () => {
  it('去标签保留正文，丢弃 script/style 内容', () => {
    const text = sanitizeDocumentText(
      '<html><head><title>T</title><style>.a{color:red}</style></head><body onload="evil()"><h1>标题</h1><script>alert(1)</script><p class="x">正文</p></body></html>'
    );
    expect(text).toContain('标题');
    expect(text).toContain('正文');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('折叠连续空白', () => {
    expect(sanitizeDocumentText('<p>你好\n  世界\t! </p>')).toBe('你好 世界 !');
  });

  it('默认丢弃非文本子树内文本（svg / option / noscript）', () => {
    const text = sanitizeDocumentText(
      '<body><p>正文</p><svg><text>图表标签</text></svg><select><option>选项A</option></select><noscript>无脚本提示</noscript></body>'
    );
    expect(text).toContain('正文');
    expect(text).not.toContain('图表标签');
    expect(text).not.toContain('选项A');
    expect(text).not.toContain('无脚本提示');
  });

  it('includeNonTextElements=true 时保留非文本子树文本', () => {
    const text = sanitizeDocumentText('<body><p>正文</p><svg><text>图表标签</text></svg></body>', {
      includeNonTextElements: true,
    });
    expect(text).toContain('正文');
    expect(text).toContain('图表标签');
  });

  it('超长内容按上限截断并标注省略长度', () => {
    const raw = `<p>${'x'.repeat(DOC_TEXT_MAX_CHARS + 100)}</p>`;
    const text = sanitizeDocumentText(raw);
    expect(text.length).toBeLessThanOrEqual(DOC_TEXT_MAX_CHARS + 15);
    expect(text).toContain('…(+');
  });

  it('truncateWithMarker 仅在超限时追加省略标记', () => {
    expect(truncateWithMarker('abc', 5)).toBe('abc');
    expect(truncateWithMarker('abcdef', 5)).toBe('abcde…(+1)');
  });
});

describe('collectDocumentInfoInPage（元素大纲，jsdom 真实 DOM）', () => {
  it('以 html 为根（深度 0）、每行「深度 选择器 文本」、无前导空白', () => {
    setDocumentHtml(
      '<head><title>T</title></head><body><div id="app" class="container main"><span class="t">x</span></div></body>'
    );
    const info = collectDocumentInfoInPage({
      outline: true,
      rawHtml: false,
      includeNonTextElements: false,
    });
    const lines = info.outline!.split('\n');

    expect(lines[0]).toBe('0 html');
    expect(lines).toContain('1 head');
    expect(lines).toContain('2 title T');
    expect(lines).toContain('1 body');
    expect(lines).toContain('2 div#app.container.main');
    expect(lines).toContain('3 span.t x');
    // 零前导空白：层级只由深度数字表达（避免深层页面大段缩进空格）
    expect(lines.every((line) => line === line.trimStart())).toBe(true);
  });

  it('内联直接文本：不含子元素文本、折叠空白、纯空白文本节点跳过', () => {
    setDocumentHtml('<body><p>你好 <b>世界</b>！</p><div>   </div><h1>多行\n\t标题</h1></body>');
    const info = collectDocumentInfoInPage({
      outline: true,
      rawHtml: false,
      includeNonTextElements: false,
    });
    const lines = info.outline!.split('\n');

    // 只取直接文本节点：p 行不重复 b 的「世界」
    expect(lines).toContain('2 p 你好 ！');
    expect(lines).toContain('3 b 世界');
    // 连续空白折叠为单空格
    expect(lines).toContain('2 h1 多行 标题');
    // 纯空白文本节点不产生文本后缀
    expect(lines).toContain('2 div');
    expect(lines.some((line) => line.startsWith('2 div '))).toBe(false);
  });

  it('单节点文本超 80 字符截断并加省略号', () => {
    setDocumentHtml(`<body><p>${'字'.repeat(100)}</p></body>`);
    const info = collectDocumentInfoInPage({
      outline: true,
      rawHtml: false,
      includeNonTextElements: false,
    });

    expect(info.outline).toContain(`2 p ${'字'.repeat(80)}…`);
  });

  it('全页文本预算（8000 字符）耗尽：结构行继续完整输出，末尾追加说明行', () => {
    // 120 个节点 × 100 字符文本 = 12000 字符 > 8000 预算
    setDocumentHtml(
      `<body>${Array.from({ length: 120 }, () => `<p>${'字'.repeat(100)}</p>`).join('')}</body>`
    );
    const info = collectDocumentInfoInPage({
      outline: true,
      rawHtml: false,
      includeNonTextElements: false,
    });
    const lines = info.outline!.split('\n');

    // 预算耗尽说明行在末尾（用户决策：预算耗尽要有感知）
    expect(lines.at(-1)).toContain('文本预算已用尽');
    // 结构行不受文本预算影响：120 个 p 全部列出
    expect(lines.filter((line) => line.startsWith('2 p')).length).toBe(120);
    // 前 100 个节点带文本（各 80 字符截断），预算耗尽后的 20 个只有结构
    expect(lines.filter((line) => line.startsWith('2 p') && line.includes('…')).length).toBe(100);
    expect(lines.filter((line) => line === '2 p').length).toBe(20);
  });

  it('默认静默排除非文本子树（svg/script/style/iframe），不输出任何元信息行', () => {
    setDocumentHtml(
      '<head><style>.a{color:red}</style></head>' +
        '<body><main><svg><g><path d="M0 0"/></g></svg><p>正文</p></main>' +
        '<script>evil()</script><iframe src="https://x.com"></iframe></body>'
    );
    const info = collectDocumentInfoInPage({
      outline: true,
      rawHtml: false,
      includeNonTextElements: false,
    });
    const lines = info.outline!.split('\n');

    expect(lines.some((line) => line.endsWith(' svg') || line === '2 svg')).toBe(false);
    expect(lines.some((line) => line.endsWith(' style'))).toBe(false);
    expect(lines.some((line) => line.endsWith(' script'))).toBe(false);
    expect(lines.some((line) => line.endsWith(' iframe'))).toBe(false);
    expect(lines).toContain('3 p 正文');
    // 排除是静默行为：大纲只含页面结构，末尾不追加任何「已跳过/非文本节点」说明行；
    // script/style 的文本随子树一并排除，不混入大纲
    expect(info.outline).not.toContain('已跳过');
    expect(info.outline).not.toContain('非文本节点');
    expect(info.outline).not.toContain('evil()');
    expect(info.outline).not.toContain('color:red');
    expect(lines.at(-1)).toBe('3 p 正文');
  });

  it('includeNonTextElements=true 时保留非文本子树且不输出跳过汇总', () => {
    setDocumentHtml('<body><svg><g><path d="M0 0"/></g></svg><script>evil()</script></body>');
    const info = collectDocumentInfoInPage({
      outline: true,
      rawHtml: false,
      includeNonTextElements: true,
    });
    const lines = info.outline!.split('\n');

    expect(lines).toContain('2 svg');
    expect(lines).toContain('3 g');
    expect(lines).toContain('4 path');
    expect(lines.some((line) => line.includes('已跳过'))).toBe(false);
  });

  it('只保留结构与 id/class：不含 href/src/事件属性等取值', () => {
    setDocumentHtml(
      '<body><a class="link" href="https://x.com/?token=secret" onclick="evil()">去</a></body>'
    );
    const info = collectDocumentInfoInPage({
      outline: true,
      rawHtml: false,
      includeNonTextElements: false,
    });

    expect(info.outline).toContain('2 a.link');
    expect(info.outline).not.toContain('href');
    expect(info.outline).not.toContain('secret');
    expect(info.outline).not.toContain('onclick');
  });

  it('rawHtml 仅在开关开启时采集；节点上限触发时追加截断说明', () => {
    setDocumentHtml(`<body><div id="root">${'<span></span>'.repeat(1300)}</div></body>`);
    const withRaw = collectDocumentInfoInPage({
      outline: true,
      rawHtml: true,
      includeNonTextElements: false,
    });
    expect(withRaw.rawHtml).toContain('<html');
    expect(withRaw.outline).toContain('已达节点上限');

    const withoutRaw = collectDocumentInfoInPage({
      outline: false,
      rawHtml: false,
      includeNonTextElements: false,
    });
    expect(withoutRaw.outline).toBeUndefined();
    expect(withoutRaw.rawHtml).toBeUndefined();
  });
});

describe('executeBuiltinTool', () => {
  it('未知内置工具名抛错', async () => {
    await expect(
      executeBuiltinTool('not_a_tool', {}, { getSelectedTabIds: () => [] })
    ).rejects.toThrow('未知内置工具');
  });

  it('返回形态契约：MCP CallToolResult（content 文本块 + isError:false）', async () => {
    const result = await executeBuiltinTool(GET_DOCUMENT_INFO_TOOL_NAME, {}, {
      getSelectedTabIds: () => [7],
      collectFromTab: async () => makeRaw(),
    });

    // 关键回归：裸数组会被 relay 的 CallToolResultSchema 判为非法并降级为 isError
    expect(Array.isArray(result)).toBe(false);
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(Array.isArray(JSON.parse(result.content[0]!.text))).toBe(true);
  });

  it('toBuiltinToolResult 包装任意负载并序列化为 JSON 文本', () => {
    expect(toBuiltinToolResult({ a: 1 })).toEqual({
      content: [{ type: 'text', text: '{"a":1}' }],
      isError: false,
    });
    expect(toBuiltinToolResult(undefined).content[0]?.text).toBe('null');
  });

  it('三开关缺省：不采集 outline/rawHtml，结果不含 outline/text（防上下文污染）', async () => {
    const collectFromTab = vi.fn(async () => makeRaw());
    const result = unwrap<Array<Record<string, unknown>>>(
      await executeBuiltinTool(GET_DOCUMENT_INFO_TOOL_NAME, {}, { getSelectedTabIds: () => [7], collectFromTab })
    );

    // 采集开关原样透传（默认全 false，页面侧不做任何额外加工）
    expect(collectFromTab).toHaveBeenCalledWith(7, {
      outline: false,
      rawHtml: false,
      includeNonTextElements: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tabId: 7, url: 'https://a.com/' });
    expect('outline' in result[0]!).toBe(false);
    expect('text' in result[0]!).toBe(false);
  });

  it('includeOutline：只取页面内生成的大纲，不请求 rawHtml', async () => {
    const collectFromTab = vi.fn(async (_tabId: number, options: DocumentCollectOptions) =>
      makeRaw({ ...(options.outline ? { outline: '0 html\n1 body\n2 p' } : {}) })
    );
    const result = unwrap<Array<{ outline?: string; text?: string }>>(
      await executeBuiltinTool(GET_DOCUMENT_INFO_TOOL_NAME, { includeOutline: true }, {
        getSelectedTabIds: () => [7],
        collectFromTab,
      })
    );

    expect(collectFromTab).toHaveBeenCalledWith(7, {
      outline: true,
      rawHtml: false,
      includeNonTextElements: false,
    });
    expect(result[0]?.outline).toBe('0 html\n1 body\n2 p');
    expect('text' in result[0]!).toBe(false);
  });

  it('includeText：采集 rawHtml 并携带压缩纯文本（丢弃 script 内容），不含 outline', async () => {
    const collectFromTab = vi.fn(async (_tabId: number, options: DocumentCollectOptions) =>
      makeRaw({
        ...(options.rawHtml ? { rawHtml: '<p>你好\n  <b>世界</b></p><script>x</script>' } : {}),
      })
    );
    const result = unwrap<Array<{ text?: string; outline?: string }>>(
      await executeBuiltinTool(GET_DOCUMENT_INFO_TOOL_NAME, { includeText: true }, {
        getSelectedTabIds: () => [7],
        collectFromTab,
      })
    );

    expect(collectFromTab).toHaveBeenCalledWith(7, {
      outline: false,
      rawHtml: true,
      includeNonTextElements: false,
    });
    expect(result[0]?.text).toContain('你好');
    expect(result[0]?.text).not.toContain('x');
    expect('outline' in result[0]!).toBe(false);
  });

  it('includeNonTextElements 透传到页面侧（大纲与文本同一开关语义）', async () => {
    const collectFromTab = vi.fn(async () => makeRaw());
    await executeBuiltinTool(
      GET_DOCUMENT_INFO_TOOL_NAME,
      { includeOutline: true, includeNonTextElements: true },
      { getSelectedTabIds: () => [7], collectFromTab }
    );

    expect(collectFromTab).toHaveBeenCalledWith(7, {
      outline: true,
      rawHtml: false,
      includeNonTextElements: true,
    });
  });

  it('大纲仅在 includeOutline 时写入，且按字符上限兜底截断', async () => {
    const longOutline = 'x'.repeat(DOC_OUTLINE_MAX_CHARS + 50);
    const collectFromTab = vi.fn(async () => makeRaw({ outline: longOutline }));
    const result = unwrap<Array<{ outline?: string }>>(
      await executeBuiltinTool(GET_DOCUMENT_INFO_TOOL_NAME, { includeOutline: true }, {
        getSelectedTabIds: () => [7],
        collectFromTab,
      })
    );

    expect(result[0]?.outline?.length).toBeLessThanOrEqual(DOC_OUTLINE_MAX_CHARS + 15);
    expect(result[0]?.outline).toContain('…(+');
  });

  it('每个选中页签一个元素（Q4）；单页签失败带 error 不阻断其余', async () => {
    const collectFromTab = vi.fn(async (tabId: number) => {
      if (tabId === 2) throw new Error('chrome.scripting 不可用');
      return makeRaw({ url: `https://${tabId}.com/` });
    });
    const result = unwrap<Array<{ tabId: number; url: string; error?: string }>>(
      await executeBuiltinTool(GET_DOCUMENT_INFO_TOOL_NAME, {}, {
        getSelectedTabIds: () => [1, 2, 3],
        collectFromTab,
      })
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ tabId: 1, url: 'https://1.com/' });
    expect(result[1]?.error).toContain('chrome.scripting');
    expect(result[2]).toMatchObject({ tabId: 3, url: 'https://3.com/' });
  });
});
