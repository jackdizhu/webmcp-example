// 调试页（页面功能级）：不经过 LLM，直接通过 Port 桥接手动执行页面工具并查看结果。
// 纯逻辑（校验/格式化/历史/消息组装）全部在 debugger-core.ts，本组件仅做状态装配。
// 模板用 TSX：构建期经 oxc 转译为 vue/jsx-runtime 函数调用，运行时零 eval，
// 与 MV3 扩展页 CSP 兼容（见 issues/001）。
import { computed, defineComponent, onUnmounted, ref, watch, type VNode } from 'vue';
import { serializeToolResult, type PageToolMeta } from '../../../core/page-tools-bridge';
import { t } from '../i18n';
import { logEvent } from '../logger/logger';
import type { PageToolsClient } from '../runtime/panel-client';
import {
  appendRun,
  buildArgsTemplate,
  describeInputSchema,
  formatRawJson,
  validateArgsText,
  type ArgsValidation,
  type DebugRun,
} from '../runtime/debugger-core';

export const DebugPage = defineComponent({
  name: 'DebugPage',
  props: {
    pageTools: { type: Object as () => PageToolsClient, required: true },
    /** 调试页是否处于激活状态（激活时刷新工具清单；非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
    /**
     * 执行锁（agent 对话或 relay 调用进行中）：本页全部操作禁用，
     * 避免与其他执行流并发造成页面工具调用状态错乱。
     */
    locked: { type: Boolean, default: false },
  },
  emits: {
    /** 用户点击「发送到对话」，把一次执行记录交给 agent 继续分析。 */
    handoff: (run: DebugRun) => typeof run.name === 'string',
  },
  setup(props, { emit }) {
    const tools = ref<PageToolMeta[]>([]);
    const selected = ref('');
    const argsText = ref('');
    const validationError = ref('');
    const running = ref(false);
    const refreshing = ref(false);
    const lastRun = ref<DebugRun | null>(null);
    const history = ref<DebugRun[]>([]);
    const executionError = ref('');

    const refreshTools = async (): Promise<void> => {
      refreshing.value = true;
      try {
        tools.value = await props.pageTools.listTools();
        // 当前选中项若已不存在则清空
        if (!tools.value.some((tool) => tool.name === selected.value)) {
          selected.value = tools.value[0]?.name ?? '';
        }
      } catch (error) {
        tools.value = [];
        selected.value = '';
        executionError.value = t('debug.listFetchFailed', {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        refreshing.value = false;
      }
    };

    // 每次切到调试 Tab 都刷新工具清单，感知页面工具变化
    watch(
      () => props.active,
      (isActive) => {
        if (isActive) void refreshTools();
      },
      { immediate: true }
    );

    // 工具清单自动同步（切页签刷新之上的实时通道）：
    // - 页面侧注册/注销工具 → 桥接 toolsChanged 推送 → 自动刷新，无需手动点「刷新工具清单」；
    // - 桥接恢复在线（断线重连成功）→ 页面工具清单可能已变化 → 自动刷新。
    // 仅激活本页时刷新：非激活时布局隐藏，切回时上方 watch(active) 兜底刷新。
    const offToolsChange = props.pageTools.onToolsChange(() => {
      if (props.active) void refreshTools();
    });
    const offStatusChange = props.pageTools.onStatusChange((connected) => {
      if (connected && props.active) void refreshTools();
    });
    onUnmounted(() => {
      offToolsChange();
      offStatusChange();
    });

    const selectedTool = (): PageToolMeta | undefined =>
      tools.value.find((tool) => tool.name === selected.value);

    /**
     * 当前工具的入参说明（解析 inputSchema.properties，按声明顺序）。
     * 含内置工具（chrome_extension_*）—— 清单已由 attachBuiltinTools 合成。
     */
    const parameters = computed(() => describeInputSchema(selectedTool()?.inputSchema));

    /** 「填入参数模板」：按 schema 生成参数骨架写入编辑器（覆盖当前文本）。 */
    const fillArgsTemplate = (): void => {
      const tool = selectedTool();
      if (!tool) return;
      argsText.value = JSON.stringify(buildArgsTemplate(tool.inputSchema), null, 2);
      validationError.value = '';
    };

    const formatArgs = (): void => {
      const check: ArgsValidation = validateArgsText(argsText.value);
      if (!check.ok) {
        validationError.value = check.error;
        return;
      }
      argsText.value = JSON.stringify(check.value, null, 2);
      validationError.value = '';
    };

    const execute = async (): Promise<void> => {
      if (running.value || props.locked || selected.value.length === 0) return;
      const check = validateArgsText(argsText.value);
      if (!check.ok) {
        validationError.value = check.error;
        return;
      }
      validationError.value = '';
      executionError.value = '';
      running.value = true;

      const startedAt = Date.now();
      try {
        const result = await props.pageTools.callTool(selected.value, check.value);
        const run: DebugRun = {
          name: selected.value,
          args: check.value,
          argsText: argsText.value.trim(),
          failed: false,
          resultText: serializeToolResult(result),
          // exactOptionalPropertyTypes：仅在需要时携带 rawJson
          ...(result !== undefined ? { rawJson: formatRawJson(result) } : {}),
          elapsedMs: Date.now() - startedAt,
        };
        lastRun.value = run;
        history.value = appendRun(history.value, run);
        logEvent('info', 'debugger', 'debug_execute', {
          name: run.name,
          args: run.args,
          elapsedMs: run.elapsedMs,
          result: run.resultText,
        });
      } catch (error) {
        const run: DebugRun = {
          name: selected.value,
          args: check.value,
          argsText: argsText.value.trim(),
          failed: true,
          resultText: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - startedAt,
        };
        lastRun.value = run;
        history.value = appendRun(history.value, run);
        logEvent('error', 'debugger', 'debug_execute_error', {
          name: run.name,
          args: run.args,
          error: run.resultText,
        });
      } finally {
        running.value = false;
      }
    };

    const sendToChat = (run: DebugRun): void => {
      emit('handoff', run);
    };

    // ---- 渲染函数 ----

    /** 参数说明面板：列出每个入参的类型 / 必填 / 默认值 / 说明，便于构造合法参数。 */
    const renderParameters = (): VNode | null => {
      if (!selectedTool()) return null;
      const list = parameters.value;
      return (
        <section class="debug-params">
          <h4>{t('debug.parameters')}</h4>
          {list.length === 0 ? (
            <p class="debug-params-empty">{t('debug.noParams')}</p>
          ) : (
            <ul class="debug-params-list">
              {list.map((param) => (
                <li key={param.name} class="debug-param">
                  <div class="debug-param-head">
                    <code class="debug-param-name">{param.name}</code>
                    <span class="debug-param-type">{param.type}</span>
                    <span class={param.required ? 'badge-required' : 'badge-optional'}>
                      {param.required ? t('debug.required') : t('debug.optional')}
                    </span>
                    {param.hasDefault ? (
                      <span class="debug-param-default">
                        {t('debug.defaultValue', { value: JSON.stringify(param.defaultValue) ?? 'undefined' })}
                      </span>
                    ) : null}
                  </div>
                  {param.description ? <p class="debug-param-desc">{param.description}</p> : null}
                  {param.enumValues.length > 0 ? (
                    <p class="debug-param-enum">{t('debug.enumValues', { values: param.enumValues.join(' / ') })}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    };

    const renderForm = (): VNode => {
      const tool = selectedTool();
      return (
        <section class="debug-form">
          <label>
            <span>{t('debug.tool')}</span>
            <select
              value={selected.value}
              disabled={running.value || props.locked || tools.value.length === 0}
              onChange={(event: Event) => {
                selected.value = (event.target as HTMLSelectElement).value;
              }}
            >
              {tools.value.length === 0 ? <option value="">{t('debug.noTools')}</option> : null}
              {tools.value.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {tool?.description ? <p class="debug-desc">{tool.description}</p> : null}
          {renderParameters()}
          <label>
            <span>{t('debug.args')}</span>
            <textarea
              rows={5}
              placeholder={t('debug.argsPlaceholder')}
              spellcheck={false}
              disabled={running.value || props.locked}
              value={argsText.value}
              onInput={(event: Event) => {
                argsText.value = (event.target as HTMLTextAreaElement).value;
              }}
            />
          </label>
          {validationError.value ? <p class="debug-error">{validationError.value}</p> : null}
          {executionError.value && !lastRun.value ? <p class="debug-error">{executionError.value}</p> : null}
          <div class="debug-actions">
            <button
              type="button"
              disabled={running.value || props.locked || selected.value.length === 0}
              onClick={() => void execute()}
            >
              {running.value ? t('debug.running') : t('debug.execute')}
            </button>
            <button class="ghost" type="button" disabled={running.value || props.locked} onClick={formatArgs}>
              {t('debug.format')}
            </button>
            <button
              class="ghost"
              type="button"
              disabled={running.value || props.locked || selected.value.length === 0}
              onClick={fillArgsTemplate}
            >
              {t('debug.fillTemplate')}
            </button>
            <button
              class="ghost"
              type="button"
              disabled={running.value || props.locked}
              onClick={() => void refreshTools()}
            >
              {t('debug.refreshTools')}
            </button>
          </div>
          {/* 连接刷新按钮（webmcp/relay）已迁至「数据源设置」页（2026-09-12 页面结构调整） */}
        </section>
      );
    };

    const renderResult = (): VNode | null => {
      const run = lastRun.value;
      if (!run) return null;
      return (
        <section class={['debug-result', run.failed ? 'debug-result-failed' : '']}>
          <header>
            <strong>{run.name}</strong>
            <span class={run.failed ? 'badge-fail' : 'badge-ok'}>
              {t('debug.resultBadge', {
                state: run.failed ? t('common.state.fail') : t('common.state.ok'),
                elapsed: run.elapsedMs,
              })}
            </span>
          </header>
          <pre class="debug-result-text">{run.resultText}</pre>
          {run.rawJson !== undefined ? (
            <details>
              <summary>{t('debug.rawJson')}</summary>
              <pre class="debug-result-json">{run.rawJson}</pre>
            </details>
          ) : null}
          {run.failed
            ? null
            : (
                <button type="button" onClick={() => sendToChat(run)}>
                  {t('debug.sendToChat')}
                </button>
              )}
        </section>
      );
    };

    const renderHistory = (): VNode | null => {
      if (history.value.length === 0) return null;
      return (
        <section class="debug-history">
          <h4>{t('debug.recentRuns', { count: history.value.length })}</h4>
          {history.value.map((run, index) => (
            <div class="debug-history-item" key={history.value.length - index}>
              <span class={['debug-history-name', run.failed ? 'tool-failed' : '']}>{run.name}</span>
              <span class="debug-history-meta">{`${run.elapsedMs}ms`}</span>
              {run.failed
                ? null
                : (
                    <button class="ghost" type="button" onClick={() => sendToChat(run)}>
                      {t('debug.sendToChatShort')}
                    </button>
                  )}
            </div>
          ))}
        </section>
      );
    };

    return () => (
      <div class="debugger" style={{ display: props.active ? '' : 'none' }}>
        {renderForm()}
        {renderResult()}
        {renderHistory()}
      </div>
    );
  },
});
