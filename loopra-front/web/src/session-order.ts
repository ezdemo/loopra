const DAY = 86_400_000;
const WEEKDAYS = '日一二三四五六';

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Sidebar timestamp, relative to the viewer's calendar day:
 * today → `14:32`, yesterday → `昨天`, two days ago → `前天`, up to three
 * days → `N天前`, within a week → `星期三`, older → `10/19` (with the year
 * when it is not the current one).
 */
export function sessionDate(mtime?: number, now = Date.now()) {
  if (!mtime) return '';
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(now);
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  // Calendar days, not 24-hour spans, so "yesterday" still means yesterday at 00:05.
  const days = Math.round((startOfDay(today) - startOfDay(date)) / DAY);
  if (days <= 0) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days <= 3) return `${days}天前`;
  if (days < 7) return `星期${WEEKDAYS[date.getDay()]}`;
  return date.getFullYear() === today.getFullYear()
    ? `${date.getMonth() + 1}/${date.getDate()}`
    : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}
