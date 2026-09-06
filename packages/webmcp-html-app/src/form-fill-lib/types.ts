// 表单填充与结果表格可复用库的类型定义。
// 约束：strict + erasableSyntaxOnly（禁用 enum/namespace）+ verbatimModuleSyntax（类型导入用 import type）。

export type FieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'textarea';

export interface DataSourceOption {
  value: string;
  label: string;
}

export interface FieldSchema {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** 静态选项（与 dataSource 二选一）。select/radio 使用。 */
  options?: DataSourceOption[];
  /** 动态选项数据源 key（注册在 DataSourceResolver）。 */
  dataSource?: string;
  /** 强时效字段：提交时执行时复核（铁律 1）。 */
  freshRequired?: boolean;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  /** 只读展示字段（如可用库存），AI 不应填充。 */
  readOnly?: boolean;
  /** 选项数据获取距今秒数（仅 get_schema 视图返回，运行时计算）。 */
  freshnessSec?: number;
  /** 栅格布局下的跨列数（默认 1）。form-renderer 以 4 列栅格渲染，宽字段可传 2/4。 */
  colSpan?: number;
}

export interface FormSchema {
  id: string;
  title: string;
  fields: FieldSchema[];
}

/** form_get_schema 工具返回的单字段视图（含当前选项与新鲜度）。 */
export interface SchemaViewField {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: DataSourceOption[];
  dataSource?: string;
  freshRequired?: boolean;
  readOnly?: boolean;
  freshnessSec: number | null;
}

export type FillIssueType =
  | 'UNKNOWN_FIELD'
  | 'INVALID_OPTION'
  | 'INVALID_VALUE'
  | 'INVALID_TYPE'
  | 'READONLY';

export interface FillIssue {
  field: string;
  errorType: FillIssueType;
  reason: string;
  llmHint?: string;
}

export interface FillOutcome {
  success: boolean;
  filled: string[];
  issues: FillIssue[];
}

export type SubmitErrorType = 'VALIDATION' | 'STOCK_CHANGED' | 'SUBMIT_FAILED';

export interface SubmitOutcome {
  success: boolean;
  data?: Record<string, unknown>;
  errorType?: SubmitErrorType;
  reason?: string;
  latestData?: unknown;
  llmHint?: string;
}

/** WebMCP 工具统一文本结果结构。 */
export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
}

/** 表格列定义。 */
export interface TableColumn {
  key: string;
  label: string;
}

/**
 * 表单控制器契约。form-tools 仅依赖此接口，便于单元测试用 stub 替换真实 DOM 控制器。
 */
export interface FormControllerLike {
  getSchema(): FormSchema;
  getSchemaView(): Promise<SchemaViewField[]>;
  getValues(): Record<string, unknown>;
  applyValues(values: Record<string, unknown>, highlight: string[]): Promise<void>;
  validateRequired(): string[];
  requestSubmit(): Promise<SubmitOutcome>;
}

/** 表格控制器契约。 */
export interface TableControllerLike {
  render(columns: TableColumn[], rows: Array<Record<string, unknown>>, fetchedAt: number): void;
}

/** 构造 MCP 工具所需的依赖。 */
export interface FormToolDeps {
  controller: FormControllerLike;
  table?: TableControllerLike;
  /** 查询结果数据提供者（demo 提供）。无 table 时该工具不可用。 */
  queryData?: () => Promise<{ columns: TableColumn[]; rows: Array<Record<string, unknown>>; total: number }>;
}
