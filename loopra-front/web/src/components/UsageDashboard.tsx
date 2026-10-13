import { useState } from 'react';
import { Button } from '@nextui-org/react';
import type { LoopraClient } from '../backend';
import { RemoteState, useRemote } from './RemoteControls';
import { PageHeader } from './SettingControls';

export type UsageDaily = { date: string; totalTokens: number; cost: number; requests: number; promptTokens?: number; completionTokens?: number; cacheHit?: number; cacheMiss?: number };
export type UsageModel = { model: string; totalTokens: number; cost: number; requests: number; promptTokens?: number; completionTokens?: number; cacheHit?: number };
export type UsageStats = {
  totalRequests: number; totalPromptTokens: number; totalCompletionTokens: number;
  totalCacheHit: number; totalCacheMiss?: number; totalCost: number; activeDays: number;
  dailyStats: UsageDaily[]; modelStats: UsageModel[];
};

// Compact 千/万/亿 numbers, matching the legacy Dashboard.vue formatCompact.
export function compactTokens(value: number) {
  const n = Number(value || 0);
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}千`;
  return Math.round(n).toLocaleString('zh-CN');
}

// Currency formatting matching the legacy Dashboard.vue formatCost (four decimals for tiny amounts).
export function formatCost(value: number) {
  const n = Number(value || 0);
  return n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2);
}

// Model usage pagination: 4 rows per page, mirroring the legacy modelsPage controls.
export function usageModelPage(models: UsageModel[], page: number, perPage = 4) {
  const totalPages = Math.max(1, Math.ceil(models.length / perPage));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (current - 1) * perPage;
  return { page: current, totalPages, items: models.slice(start, start + perPage) };
}

// Weekly token heatmap layout (Monday-first columns), mirroring legacy heatmapCells/Months.
export function usageHeatmap(daily: UsageDaily[]) {
  if (!daily.length) return { cols: 0, minWidth: '0px', months: [] as { key: string; label: string; col: number }[], cells: [] as { level: string; title: string }[] };
  const offset = (new Date(`${daily[0].date}T00:00:00`).getDay() + 6) % 7;
  const cols = Math.ceil((offset + daily.length) / 7);
  const max = Math.max(1, ...daily.map(day => day.totalTokens || 0));
  const cells: { level: string; title: string }[] = Array.from({ length: offset }, () => ({ level: 'empty', title: '' }));
  for (const day of daily) {
    const ratio = (day.totalTokens || 0) / max;
    const level = day.totalTokens <= 0 ? 'level-0' : ratio < .2 ? 'level-1' : ratio < .45 ? 'level-2' : ratio < .7 ? 'level-3' : 'level-4';
    cells.push({ level, title: `${day.date} · ${compactTokens(day.totalTokens || 0)} tokens` });
  }
  const months: { key: string; label: string; col: number }[] = [];
  daily.forEach((day, index) => {
    const date = new Date(`${day.date}T00:00:00`);
    if (date.getDate() > 7 && index !== 0) return;
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    if (!months.some(month => month.key === key)) months.push({ key, label: `${date.getMonth() + 1}月`, col: Math.floor((offset + index) / 7) });
  });
  // Drop an opening month whose neighbour sits fewer than two columns away.
  const filtered = months.filter((month, index) => !months[index + 1] || months[index + 1].col - month.col >= 2);
  return { cols, minWidth: `${Math.max(0, cols * 20 - 4)}px`, months: filtered, cells };
}

export function UsageDashboard({ api }: { api: LoopraClient }) {
  const [days, setDays] = useState(30);
  const [revision, setRevision] = useState(0);
  const [modelPage, setModelPage] = useState(1);
  const state = useRemote<UsageStats>(api, `/usage/dashboard?days=${days}`, revision);
  const data = state.data;
  const totalTokens = (data?.totalPromptTokens || 0) + (data?.totalCompletionTokens || 0);
  const daily = data?.dailyStats || [];
  const peak = Math.max(0, ...daily.map(day => day.totalTokens || 0));
  const maxDailyCost = Math.max(0, ...daily.map(day => day.cost || 0));
  const cacheTotal = (data?.totalCacheHit || 0) + (data?.totalCacheMiss || 0);
  const cacheRate = cacheTotal ? ((data!.totalCacheHit || 0) / cacheTotal * 100).toFixed(0) : '0';
  const heatmap = usageHeatmap(daily);
  const page = usageModelPage(data?.modelStats || [], modelPage);
  return <>
    <PageHeader title="用量统计" description="服务端记录的实际请求、Token 和费用。"><select aria-label="统计天数" value={days} onChange={event => setDays(Number(event.target.value))}>{[7, 30, 90, 365].map(value => <option key={value} value={value}>近 {value} 天</option>)}</select><Button size="sm" variant="light" onPress={() => setRevision(value => value + 1)}>刷新</Button></PageHeader>
    <RemoteState {...state} />
    {data && <>
      <div className="settings-metrics">{(['累计 tokens', '单日峰值 tokens', '活跃天数', '缓存命中率', '总请求次数'] as const).map((label, index) => <div className="settings-metric" key={label}><span>{label}</span><strong>{[compactTokens(totalTokens), compactTokens(peak), `${data.activeDays} 天`, `${cacheRate}%`, compactTokens(data.totalRequests)][index]}</strong></div>)}</div>
      <h3>Token 活跃度</h3>
      <div className="usage-heatmap-wrap">
        <div className="usage-heatmap-scroll">
          <div className="usage-heatmap-months" style={{ gridTemplateColumns: `repeat(${heatmap.cols}, minmax(1rem, 1.375rem))`, minWidth: heatmap.minWidth }}>{heatmap.months.map(month => <span key={month.key} style={{ gridColumnStart: month.col + 1 }}>{month.label}</span>)}</div>
          <div className="usage-heatmap-grid" style={{ gridTemplateColumns: `repeat(${heatmap.cols}, minmax(1rem, 1.375rem))`, minWidth: heatmap.minWidth }}>{heatmap.cells.map((cell, index) => <span key={index} className={`usage-cell ${cell.level}`} title={cell.title} />)}</div>
        </div>
        <div className="usage-heatmap-legend"><span>少</span>{['level-0', 'level-1', 'level-2', 'level-3', 'level-4'].map(level => <i key={level} className={`usage-cell ${level}`} />)}<span>多</span></div>
      </div>
      <div className="settings-metric-panels">
        <section className="settings-metric-panel"><h4>活跃度指标</h4><dl><div><dt>总请求次数</dt><dd>{data.totalRequests}</dd></div><div><dt>平均 tokens / 请求</dt><dd>{compactTokens(data.totalRequests ? totalTokens / data.totalRequests : 0)}</dd></div><div><dt>最长活跃天数</dt><dd>{data.activeDays} 天</dd></div></dl></section>
        <section className="settings-metric-panel"><h4>Token 指标</h4><dl><div><dt>输入 tokens</dt><dd>{compactTokens(data.totalPromptTokens)}</dd></div><div><dt>输出 tokens</dt><dd>{compactTokens(data.totalCompletionTokens)}</dd></div><div><dt>缓存读取 tokens</dt><dd>{compactTokens(data.totalCacheHit)}</dd></div><div><dt>缓存写入 tokens</dt><dd>0</dd></div></dl></section>
        <section className="settings-metric-panel"><h4>Cache 指标</h4><dl><div><dt>缓存 tokens</dt><dd>{compactTokens(data.totalCacheHit)}</dd></div><div><dt>Cache 命中率</dt><dd>{cacheRate}%</dd></div></dl></section>
      </div>
      <h3>费用预估</h3>
      <div className="settings-metric-panels usage-cost-cards">
        <section className="settings-metric-panel"><h4>根据当前模型价格估算</h4><dl><div><dt>预估总费用</dt><dd>¥{formatCost(data.totalCost)}</dd></div></dl></section>
        <section className="settings-metric-panel"><h4>单日费用峰值</h4><dl><div><dt>最高单日</dt><dd>¥{formatCost(maxDailyCost)}</dd></div></dl></section>
      </div>
      <h3>每日明细</h3>
      <details className="workbench-card"><summary>每日明细</summary><table className="resource-table"><thead><tr><th>日期</th><th>请求</th><th>Token</th><th>费用</th></tr></thead><tbody>{daily.map(day => <tr key={day.date}><td>{day.date}</td><td>{day.requests}</td><td>{day.totalTokens.toLocaleString()}</td><td>¥{day.cost.toFixed(4)}</td></tr>)}</tbody></table></details>
      <div className="usage-models-heading"><h3>模型用量</h3>{data.modelStats.length > 0 && <div className="usage-model-pagination" role="group" aria-label="模型用量分页"><span>{page.page} / {page.totalPages}</span><button type="button" aria-label="上一页" disabled={page.page <= 1} onClick={() => setModelPage(page.page - 1)}>‹</button><button type="button" aria-label="下一页" disabled={page.page >= page.totalPages} onClick={() => setModelPage(page.page + 1)}>›</button></div>}</div>
      {page.items.map(model => <div className="workbench-card usage-model" key={model.model}><div className="usage-model-main"><strong>{model.model}</strong><small>{model.model === 'unknown' ? '默认渠道' : 'model provider'} · {model.requests} 次 · {model.totalTokens.toLocaleString()} Token · ¥{formatCost(model.cost)}</small></div><div className="usage-model-breakdown"><span>输入 <b>{compactTokens(model.promptTokens || 0)}</b></span><span>输出 <b>{compactTokens(model.completionTokens || 0)}</b></span><span>缓存读取 <b>{compactTokens(model.cacheHit || 0)}</b></span><span>缓存写入 <b>0</b></span></div></div>)}
      {!data.modelStats.length && <p className="composer-empty">该时间范围内暂无模型用量记录。</p>}
    </>}
  </>;
}
