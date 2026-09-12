// schema 驱动的可复用表单渲染器（vanilla DOM，零框架依赖）。
// 渲染逻辑不写单测（vitest 为 node 环境、无 DOM）；校验/归一化已抽至 validation.ts 纯函数层覆盖。
// 约束：erasableSyntaxOnly —— 不使用参数属性（constructor(private x)），改为显式字段声明。

import type {
  DataSourceOption,
  FieldSchema,
  FormSchema,
  SchemaViewField,
  SubmitOutcome,
} from './types';
import { findMissingRequired } from './validation';
import type { DataSourceResolver } from './data-source-resolver';

export type FormSubmitHandler = (values: Record<string, unknown>) => Promise<SubmitOutcome>;

export interface FormControllerDeps {
  schema: FormSchema;
  container: HTMLElement;
  resolver: DataSourceResolver;
  onSubmit?: FormSubmitHandler;
}

type InputEl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export class FormController {
  private readonly deps: FormControllerDeps;
  private readonly fields = new Map<string, FieldSchema>();
  private readonly inputs = new Map<string, InputEl>();

  constructor(deps: FormControllerDeps) {
    this.deps = deps;
    for (const f of deps.schema.fields) this.fields.set(f.name, f);
    this.build();
  }

  getSchema(): FormSchema {
    return this.deps.schema;
  }

  /** 解析当前选项与新鲜度，供 form_get_schema 工具返回。 */
  async getSchemaView(): Promise<SchemaViewField[]> {
    const resolver = this.deps.resolver;
    const views: SchemaViewField[] = [];
    for (const f of this.deps.schema.fields) {
      let options: DataSourceOption[] = f.options ?? [];
      let freshnessSec: number | null = null;
      if (f.dataSource) {
        options = await resolver.resolveOptions(f.dataSource, {});
        freshnessSec = resolver.peekFreshnessSec(f.dataSource, {});
      }
      views.push({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        options,
        dataSource: f.dataSource,
        freshRequired: f.freshRequired,
        readOnly: f.readOnly,
        freshnessSec,
      });
    }
    return views;
  }

  getValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, el] of this.inputs) {
      out[name] = this.readInput(el, this.fields.get(name)!);
    }
    return out;
  }

  /** 应用已校验归一化的值到 DOM，并对指定字段加 .ff-agent-filled 高亮（用户交互后移除）。 */
  async applyValues(values: Record<string, unknown>, highlight: string[]): Promise<void> {
    for (const [name, raw] of Object.entries(values)) {
      const el = this.inputs.get(name);
      const f = this.fields.get(name);
      if (!el || !f) continue;
      this.writeInput(el, f, raw);
      if (highlight.includes(name)) el.classList.add('ff-agent-filled');
    }
  }

  validateRequired(): string[] {
    return findMissingRequired(this.deps.schema.fields, this.getValues());
  }

  async requestSubmit(): Promise<SubmitOutcome> {
    const missing = this.validateRequired();
    if (missing.length > 0) {
      return {
        success: false,
        errorType: 'VALIDATION',
        reason: `缺少必填字段: ${missing.join(', ')}`,
        llmHint: '可调用 form_fill_fields 填充后重试',
      };
    }
    const handler = this.deps.onSubmit;
    if (!handler) return { success: true, data: this.getValues() };
    return handler(this.getValues());
  }

  // ---- DOM ----

  private build(): void {
    const root = this.deps.container;
    root.innerHTML = '';
    const form = document.createElement('form');
    form.className = 'ff-form';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.requestSubmit();
    });

    for (const f of this.deps.schema.fields) {
      const wrap = document.createElement('div');
      // checkbox 在 4 列栅格中 label 与输入框同行，保证行高对齐
      wrap.className = f.type === 'checkbox' ? 'ff-field ff-field-inline' : 'ff-field';
      // 栅格跨列扩展点（默认 1 列；仅 colSpan > 1 时写内联样式，避免覆盖响应式降列规则）
      const span = f.colSpan ?? 1;
      if (span > 1) wrap.style.gridColumn = `span ${span}`;
      const label = document.createElement('label');
      label.className = 'ff-label';
      // 必填星号独立 span，便于 CSS 单独红色展示
      label.textContent = f.label;
      if (f.required) {
        const star = document.createElement('span');
        star.className = 'ff-required';
        star.textContent = ' *';
        label.appendChild(star);
      }
      wrap.appendChild(label);

      const input = this.createInput(f);
      this.inputs.set(f.name, input);
      wrap.appendChild(input);

      // 用户一旦交互即视为人工填写，移除 AI 高亮
      input.addEventListener('input', () => input.classList.remove('ff-agent-filled'));
      input.addEventListener('focus', () => input.classList.remove('ff-agent-filled'));
      if (f.readOnly) {
        input.setAttribute('readonly', '');
        (input as HTMLInputElement).disabled = true;
      }
      if (f.placeholder) input.setAttribute('placeholder', f.placeholder);
      if (f.defaultValue !== undefined) input.value = String(f.defaultValue);

      form.appendChild(wrap);
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    // .ff-submit 样式中 grid-column: 1 / -1，独占栅格一整行
    submit.className = 'ff-submit';
    submit.textContent = '查询订单';
    form.appendChild(submit);

    root.appendChild(form);
  }

  private createInput(f: FieldSchema): InputEl {
    if (f.type === 'select' || f.type === 'radio') {
      const sel = document.createElement('select');
      sel.className = 'ff-input';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— 请选择 —';
      sel.appendChild(blank);
      for (const o of f.options ?? []) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      if (f.dataSource) void this.populateDynamicOptions(sel, f);
      return sel;
    }
    if (f.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.className = 'ff-input';
      return ta;
    }
    if (f.type === 'checkbox') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ff-checkbox';
      return cb;
    }
    const inp = document.createElement('input');
    inp.type = f.type === 'number' ? 'number' : 'text';
    inp.className = 'ff-input';
    return inp;
  }

  private async populateDynamicOptions(sel: HTMLSelectElement, f: FieldSchema): Promise<void> {
    try {
      const opts = await this.deps.resolver.resolveOptions(f.dataSource!, {});
      sel.innerHTML = '';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '— 请选择 —';
      sel.appendChild(blank);
      for (const o of opts) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
    } catch {
      // 加载失败保留空占位，不影响表单其余功能
    }
  }

  private readInput(el: InputEl, f: FieldSchema): unknown {
    if (f.type === 'checkbox') return (el as HTMLInputElement).checked;
    if (f.type === 'number') {
      const v = (el as HTMLInputElement).value;
      return v === '' ? '' : Number(v);
    }
    return (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  private writeInput(el: InputEl, f: FieldSchema, raw: unknown): void {
    if (f.type === 'checkbox') {
      (el as HTMLInputElement).checked =
        raw === true || raw === 'true' || raw === 1 || raw === '1';
      return;
    }
    (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value =
      raw == null ? '' : String(raw);
  }
}
