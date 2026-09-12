// order-form demo 单测：按销售员隔离的 mock 订单与 queryData 过滤逻辑。
// order-form.ts 顶层仅注册内存数据源（无 DOM 操作），可在 node 环境直接导入。
import { describe, it, expect } from 'vitest';
import { queryData } from './order-form';

describe('order-form demo queryData（按销售员的 mock 数据）', () => {
  it('不传 filter 返回全部订单（含销售员列）', async () => {
    const res = await queryData();
    expect(res.total).toBe(6);
    expect(res.columns.some((c) => c.key === 'salesperson')).toBe(true);
    expect(res.hint).toBeUndefined();
  });

  it('filter.salesperson 传工号 → 只返回该销售员的订单', async () => {
    const res = await queryData({ salesperson: 'S-01' });
    expect(res.total).toBe(2);
    expect(res.rows.every((r) => r['salesperson'] === '张三')).toBe(true);
    expect(res.rows.map((r) => r['orderId'])).toEqual(['ORD-1001', 'ORD-1003']);
  });

  it('filter.salesperson 传姓名 → 归一化为工号后过滤', async () => {
    const res = await queryData({ salesperson: '李四' });
    expect(res.total).toBe(2);
    expect(res.rows.every((r) => r['salesperson'] === '李四')).toBe(true);
    const wang = await queryData({ salesperson: ' 王五 ' });
    expect(wang.total).toBe(2);
    expect(wang.rows.every((r) => r['salesperson'] === '王五')).toBe(true);
  });

  it('未知销售员 → 空结果 + hint 列出可用销售员', async () => {
    const res = await queryData({ salesperson: '赵六' });
    expect(res.total).toBe(0);
    expect(res.rows).toEqual([]);
    expect(res.hint).toContain('赵六');
    expect(res.hint).toContain('张三/李四/王五');
  });

  it('每个销售员的 mock 数据客户/产品互不重叠', async () => {
    const customers = await Promise.all(
      ['S-01', 'S-02', 'S-03'].map((sp) => queryData({ salesperson: sp }).then((r) => r.rows.map((x) => x['customer']))),
    );
    const all = customers.flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
