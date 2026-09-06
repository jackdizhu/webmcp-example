// 可复用的查询结果表格渲染器（vanilla DOM）。
// 列定义 + 行数据渲染，并在末列标注数据获取时间（呼应设计文档第五节「数据新鲜度」）。
// DOM 层不写单测；结构化行数据由 query_table_data 工具直接返回给 AI。

import type { TableColumn, TableControllerLike } from './types';

export class TableController implements TableControllerLike {
  private readonly el: HTMLElement;

  constructor(container: HTMLElement) {
    this.el = container;
    this.renderEmpty();
  }

  renderEmpty(): void {
    this.el.innerHTML = '<p class="ff-table-empty">暂无数据，调用 query_table_data 查询订单。</p>';
  }

  render(columns: TableColumn[], rows: Array<Record<string, unknown>>, fetchedAt: number): void {
    if (rows.length === 0) {
      this.el.innerHTML = '<p class="ff-table-empty">查询结果为空。</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'ff-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c.label;
      htr.appendChild(th);
    }
    const thTime = document.createElement('th');
    thTime.textContent = '数据获取时间';
    htr.appendChild(thTime);
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const c of columns) {
        const td = document.createElement('td');
        td.textContent = row[c.key] == null ? '' : String(row[c.key]);
        tr.appendChild(td);
      }
      const tdTime = document.createElement('td');
      tdTime.textContent = new Date(fetchedAt).toLocaleTimeString();
      tr.appendChild(tdTime);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    this.el.innerHTML = '';
    this.el.appendChild(table);
  }
}
