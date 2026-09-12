// builtin-tools 单测：注册表合并、清洗压缩管线、执行器（依赖注入，不依赖 chrome 全局）。
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_TOOLS,
  DOC_HTML_MAX_CHARS,
  DOC_TEXT_MAX_CHARS,
  executeBuiltinTool,
  GET_DOCUMENT_INFO_TOOL_NAME,
  isBuiltinTool,
  mergeBuiltinWithPageTools,
  sanitizeDocumentContent,
  type RawDocumentInfo,
} from './builtin-tools';

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
  it('BUILTIN_TOOLS 含 get_document_info，schema 声明两个默认关闭的开关', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === GET_DOCUMENT_INFO_TOOL_NAME);
    expect(tool).toBeDefined();
    const properties = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(['includeHtml', 'includeText']);
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

describe('sanitizeDocumentContent', () => {
  it('剥离 script 与事件属性，保留结构标签与文本', () => {
    const { html, text } = sanitizeDocumentContent(
      '<html><head><title>T</title></head><body onload="evil()"><h1>标题</h1><script>alert(1)</script><p class="x">正文</p></body></html>'
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onload');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('正文');
    expect(text).toContain('标题');
    expect(text).toContain('正文');
    expect(text).not.toContain('alert');
  });

  it('text 折叠连续空白', () => {
    const { text } = sanitizeDocumentContent('<p>你好\n  世界\t! </p>');
    expect(text).toBe('你好 世界 !');
  });

  it('超长内容按上限截断并标注省略长度', () => {
    const raw = `<p>${'x'.repeat(DOC_HTML_MAX_CHARS + 100)}</p>`;
    const { html, text } = sanitizeDocumentContent(raw);
    expect(html.length).toBeLessThanOrEqual(DOC_HTML_MAX_CHARS + 15);
    expect(html).toContain('…(+');
    expect(text.length).toBeLessThanOrEqual(DOC_TEXT_MAX_CHARS + 15);
  });
});

describe('executeBuiltinTool', () => {
  it('未知内置工具名抛错', async () => {
    await expect(
      executeBuiltinTool('not_a_tool', {}, { getSelectedTabIds: () => [] })
    ).rejects.toThrow('未知内置工具');
  });

  it('双开关缺省：不采集 rawHtml，结果不含 html/text（防上下文污染）', async () => {
    const collectFromTab = vi.fn(async () => makeRaw());
    const result = (await executeBuiltinTool(
      GET_DOCUMENT_INFO_TOOL_NAME,
      {},
      { getSelectedTabIds: () => [7], collectFromTab }
    )) as Array<Record<string, unknown>>;

    expect(collectFromTab).toHaveBeenCalledWith(7, false);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tabId: 7, url: 'https://a.com/' });
    expect('html' in result[0]!).toBe(false);
    expect('text' in result[0]!).toBe(false);
  });

  it('includeText：采集 rawHtml 并携带压缩纯文本，不含 html', async () => {
    const collectFromTab = vi.fn(async (_tabId: number, includeRawHtml: boolean) =>
      makeRaw({ ...(includeRawHtml ? { rawHtml: '<p>你好\n  <b>世界</b></p><script>x</script>' } : {}) })
    );
    const result = (await executeBuiltinTool(
      GET_DOCUMENT_INFO_TOOL_NAME,
      { includeText: true },
      { getSelectedTabIds: () => [7], collectFromTab }
    )) as Array<{ text?: string; html?: string }>;

    expect(collectFromTab).toHaveBeenCalledWith(7, true);
    expect(result[0]?.text).toContain('你好');
    expect(result[0]?.text).not.toContain('x');
    expect('html' in result[0]!).toBe(false);
  });

  it('includeHtml：清洗后的 HTML 剥离 script', async () => {
    const collectFromTab = vi.fn(async () =>
      makeRaw({ rawHtml: '<body><p>正文</p><script>evil()</script></body>' })
    );
    const result = (await executeBuiltinTool(
      GET_DOCUMENT_INFO_TOOL_NAME,
      { includeHtml: true },
      { getSelectedTabIds: () => [7], collectFromTab }
    )) as Array<{ html?: string }>;

    expect(result[0]?.html).toContain('正文');
    expect(result[0]?.html).not.toContain('evil');
  });

  it('每个选中页签一个元素（Q4）；单页签失败带 error 不阻断其余', async () => {
    const collectFromTab = vi.fn(async (tabId: number) => {
      if (tabId === 2) throw new Error('chrome.scripting 不可用');
      return makeRaw({ url: `https://${tabId}.com/` });
    });
    const result = (await executeBuiltinTool(
      GET_DOCUMENT_INFO_TOOL_NAME,
      {},
      { getSelectedTabIds: () => [1, 2, 3], collectFromTab }
    )) as Array<{ tabId: number; url: string; error?: string }>;

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ tabId: 1, url: 'https://1.com/' });
    expect(result[1]?.error).toContain('chrome.scripting');
    expect(result[2]).toMatchObject({ tabId: 3, url: 'https://3.com/' });
  });
});
