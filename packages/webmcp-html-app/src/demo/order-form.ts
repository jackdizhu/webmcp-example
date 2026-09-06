// 销售订单表单 Demo：完整演示 docs/webmcp-form-fill.md 三条铁律。
//   - warehouse（弱时效 60s）：TTL 缓存命中
//   - staff（中时效 30s）：SWR 后台刷新
//   - available_stock（强时效 5s + freshRequired）：提交前 forceFresh 复核，模拟被抢占 → STOCK_CHANGED
// 内存 mock store，接真实 ERP 时替换 onSubmit 与 loader 即可。

import { registerDataSource, getGlobalResolver, FormController, TableController, createFormFillTools } from '../form-fill-lib';
import type { FormSchema, FormTool, SubmitOutcome, TableColumn } from '../form-fill-lib';

interface OrderRow {
  orderId: string;
  customer: string;
  product: string;
  quantity: number;
  warehouse: string;
  status: string;
}

// ---- 内存 mock 数据 ----
const orderStore: OrderRow[] = [
  { orderId: 'ORD-1001', customer: '甲客户', product: '机械键盘', quantity: 10, warehouse: 'WH-01', status: '已发货' },
  { orderId: 'ORD-1002', customer: '乙客户', product: '无线鼠标', quantity: 5, warehouse: 'WH-02', status: '处理中' },
];

const warehouses: Array<{ value: string; label: string }> = [
  { value: 'WH-01', label: '上海仓' },
  { value: 'WH-02', label: '北京仓' },
  { value: 'WH-03', label: '广州仓' },
];
const staff: Array<{ value: string; label: string }> = [
  { value: 'S-01', label: '张三' },
  { value: 'S-02', label: '李四' },
  { value: 'S-03', label: '王五' },
];

// 强时效：可用库存，会被并发抢占演示
let availableStock = 20;

function delay<T>(v: T, ms: number): Promise<T> {
  return new Promise((r) => setTimeout(() => r(v), ms));
}

// ---- 注册三级时效数据源 ----
registerDataSource({
  name: 'warehouse',
  ttlSec: 60,
  maxAgeSec: 300,
  loader: async () => {
    // 模拟数据偶发变化（新仓上线）
    const extra = Math.random() > 0.8 ? [{ value: 'WH-04', label: '深圳仓(新)' }] : [];
    return delay([...warehouses, ...extra], 50);
  },
});

registerDataSource({
  name: 'staff',
  ttlSec: 30,
  maxAgeSec: 120,
  loader: async () => delay(staff, 50),
});

registerDataSource({
  name: 'available_stock',
  ttlSec: 5,
  freshRequired: true,
  loader: async () => delay([{ value: String(availableStock), label: `可用库存 ${availableStock}` }], 50),
});

// ---- 表单 schema ----
const schema: FormSchema = {
  id: 'sales-order',
  title: '销售订单',
  fields: [
    { name: 'customer', label: '客户名称', type: 'text', required: true, placeholder: '例如：甲客户' },
    { name: 'product', label: '产品', type: 'text', required: true },
    { name: 'warehouse', label: '发货仓', type: 'select', required: true, dataSource: 'warehouse' },
    { name: 'salesperson', label: '销售员', type: 'select', required: true, dataSource: 'staff' },
    { name: 'quantity', label: '数量', type: 'number', required: true },
    { name: 'available_stock', label: '当前可用库存', type: 'select', required: false, dataSource: 'available_stock', freshRequired: true, readOnly: true },
    { name: 'urgent', label: '加急', type: 'checkbox', required: false },
    { name: 'remark', label: '备注', type: 'text', required: false, placeholder: '补充说明（可选）' },
  ],
};

// ---- 提交处理器：铁律 1/3 —— 写前 forceFresh 复核强时效库存 ----
async function onSubmit(values: Record<string, unknown>): Promise<SubmitOutcome> {
  const resolver = getGlobalResolver();
  const stockOpts = await resolver.resolveOptions('available_stock', {}, { forceFresh: true });
  const available = Number(stockOpts[0].value);
  const qty = Number(values.quantity);
  if (qty > available) {
    return {
      success: false,
      errorType: 'STOCK_CHANGED',
      reason: `当前可用库存 ${available}，不足 ${qty}`,
      latestData: stockOpts,
      llmHint: '基于 latestData 重新决策后重试',
    };
  }
  const orderId = 'ORD-' + Date.now().toString().slice(-6);
  orderStore.unshift({
    orderId,
    customer: String(values.customer),
    product: String(values.product),
    quantity: qty,
    warehouse: String(values.warehouse),
    status: values.urgent ? '加急' : '正常',
  });
  return { success: true, data: { orderId, ...values } };
}

async function queryData(): Promise<{ columns: TableColumn[]; rows: Array<Record<string, unknown>>; total: number }> {
  const columns: TableColumn[] = [
    { key: 'orderId', label: '订单号' },
    { key: 'customer', label: '客户' },
    { key: 'product', label: '产品' },
    { key: 'quantity', label: '数量' },
    { key: 'warehouse', label: '发货仓' },
    { key: 'status', label: '状态' },
  ];
  return { columns, rows: orderStore.map((o) => ({ ...o })), total: orderStore.length };
}

/**
 * 构建订单表单 Demo UI，返回待注册的 MCP 工具列表。
 * 由 main.ts 负责 registerTool。
 */
export function buildOrderFormDemo(root: HTMLElement): FormTool[] {
  const formRoot = document.createElement('div');
  formRoot.className = 'card';
  formRoot.id = 'order-form-card';

  const tableRoot = document.createElement('div');
  tableRoot.className = 'card';
  tableRoot.id = 'order-table-card';

  const simBtn = document.createElement('button');
  simBtn.type = 'button';
  simBtn.className = 'ff-sim';
  simBtn.textContent = '模拟库存被抢占（演示 STOCK_CHANGED）';
  simBtn.addEventListener('click', () => {
    availableStock = Math.max(0, availableStock - 12);
    getGlobalResolver().markStale('available_stock');
  });

  root.appendChild(formRoot);
  root.appendChild(simBtn);
  root.appendChild(tableRoot);

  const controller = new FormController({ schema, container: formRoot, resolver: getGlobalResolver(), onSubmit });
  const table = new TableController(tableRoot);

  return createFormFillTools({ controller, table, queryData });
}
