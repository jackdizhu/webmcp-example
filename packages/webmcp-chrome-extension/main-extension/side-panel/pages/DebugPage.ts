// 调试页（页面功能级）：不经过 LLM，直接通过 Port 桥接手动执行页面工具并查看结果。
// 纯逻辑（校验/格式化/历史/消息组装）全部在 debugger-core.ts，本组件仅做状态装配。
// 模板用 h() 渲染函数（MV3 扩展页 CSP 禁止 eval，运行时字符串编译会白屏，见 issues/001）。
import { defineComponent, h, ref, watch, type VNode } from 'vue';
import { serializeToolResult, type PageToolMeta } from '../../../core/page-tools-bridge';
import { logEvent } from '../logger';
import type { PageToolsClient } from '../panel-client';
import {
  appendRun,
  formatRawJson,
  validateArgsText,
  type ArgsValidation,
  type DebugRun,
} from '../debugger-core';

export const DebugPage = defineComponent({
  name: 'DebugPage',
  props: {
    pageTools: { type: Object as () => PageToolsClient, required: true },
    /** 调试 Tab 是否处于激活状态（激活时刷新工具清单；非激活时仅隐藏布局）。 */
    active: { type: Boolean, required: true },
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
        executionError.value = `工具清单获取失败：${error instanceof Error ? error.message : String(error)}`;
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

    const selectedTool = (): PageToolMeta | undefined =>
      tools.value.find((tool) => tool.name === selected.value);

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
      if (running.value || selected.value.length === 0) return;
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

    const renderForm = (): VNode => {
      const tool = selectedTool();
      return h('section', { class: 'debug-form' }, [
        h('label', [
          h('span', '工具'),
          h(
            'select',
            {
              value: selected.value,
              disabled: running.value || tools.value.length === 0,
              onChange: (event: Event) => {
                selected.value = (event.target as HTMLSelectElement).value;
              },
            },
            [
              tools.value.length === 0 ? h('option', { value: '' }, '（无可用工具）') : null,
              ...tools.value.map((item) =>
                h('option', { key: item.name, value: item.name }, item.name)
              ),
            ]
          ),
        ]),
        tool?.description ? h('p', { class: 'debug-desc' }, tool.description) : null,
        h('label', [
          h('span', '参数（JSON）'),
          h('textarea', {
            rows: 5,
            placeholder: '{"key": "value"}；留空视为 {}',
            spellcheck: false,
            value: argsText.value,
            onInput: (event: Event) => {
              argsText.value = (event.target as HTMLTextAreaElement).value;
            },
          }),
        ]),
        validationError.value ? h('p', { class: 'debug-error' }, validationError.value) : null,
        executionError.value && !lastRun.value
          ? h('p', { class: 'debug-error' }, executionError.value)
          : null,
        h('div', { class: 'debug-actions' }, [
          h(
            'button',
            {
              type: 'button',
              disabled: running.value || selected.value.length === 0,
              onClick: () => void execute(),
            },
            running.value ? '执行中…' : '执行'
          ),
          h('button', { class: 'ghost', type: 'button', disabled: running.value, onClick: formatArgs }, '格式化'),
          h('button', { class: 'ghost', type: 'button', disabled: refreshing.value, onClick: () => void refreshTools() }, '刷新工具'),
        ]),
      ]);
    };

    const renderResult = (): VNode | null => {
      const run = lastRun.value;
      if (!run) return null;
      return h('section', { class: ['debug-result', run.failed ? 'debug-result-failed' : ''] }, [
        h('header', [
          h('strong', run.name),
          h(
            'span',
            { class: run.failed ? 'badge-fail' : 'badge-ok' },
            `${run.failed ? '失败' : '成功'} · ${run.elapsedMs}ms`
          ),
        ]),
        h('pre', { class: 'debug-result-text' }, run.resultText),
        run.rawJson !== undefined
          ? h('details', [
              h('summary', '原始 JSON'),
              h('pre', { class: 'debug-result-json' }, run.rawJson),
            ])
          : null,
        run.failed
          ? null
          : h('button', { type: 'button', onClick: () => sendToChat(run) }, '发送到对话（agent 继续分析）'),
      ]);
    };

    const renderHistory = (): VNode | null => {
      if (history.value.length === 0) return null;
      return h('section', { class: 'debug-history' }, [
        h('h4', `最近执行（${history.value.length}）`),
        ...history.value.map((run, index) =>
          h('div', { class: 'debug-history-item', key: history.value.length - index }, [
            h('span', { class: ['debug-history-name', run.failed ? 'tool-failed' : ''] }, run.name),
            h('span', { class: 'debug-history-meta' }, `${run.elapsedMs}ms`),
            run.failed
              ? null
              : h('button', { class: 'ghost', type: 'button', onClick: () => sendToChat(run) }, '发送到对话'),
          ])
        ),
      ]);
    };

    return () =>
      h(
        'div',
        { class: 'debugger', style: { display: props.active ? '' : 'none' } },
        [renderForm(), renderResult(), renderHistory()]
      );
  },
});
