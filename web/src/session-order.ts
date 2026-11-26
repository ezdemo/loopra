/** Put a just-created session ahead of the order the user last dragged. */
export function orderWithNewSessionFirst(names: readonly string[], name: string): string[] {
  return [name, ...names.filter(item => item !== name)];
}

const DAY = 86_400_000;
const WEEKDAYS = '日一二三四五六';

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Sidebar timestamp, relative to the viewer's calendar day:
 * today → `14:32`, yesterday → `昨天`, two days ago → `前天`, up to three
 * days → `N天前`, within a week → `星期三`, older → `10/19` (with the year
 * when it is not the current one).
 */
export function sessionDate(mtime?: number, now = Date.now(), translate?: (key: string, params?: Record<string, unknown>) => string, locale = 'zh-CN') {
  if (!mtime) return '';
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(now);
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  // Calendar days, not 24-hour spans, so "yesterday" still means yesterday at 00:05.
  const days = Math.round((startOfDay(today) - startOfDay(date)) / DAY);
  if (days <= 0) return locale === 'en' ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (days === 1) return translate ? translate('time.yesterday') : '昨天';
  if (days === 2) return translate ? translate('time.dayBeforeYesterday') : '前天';
  if (days <= 3) return translate ? translate('time.daysAgo', { count: days }) : `${days}天前`;
  if (days < 7) return locale === 'en' ? date.toLocaleDateString('en-US', { weekday: 'long' }) : `星期${WEEKDAYS[date.getDay()]}`;
  return date.getFullYear() === today.getFullYear()
    ? date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
    : date.toLocaleDateString(locale, { year: 'numeric', month: 'numeric', day: 'numeric' });
}
