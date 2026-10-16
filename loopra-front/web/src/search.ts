/** Use calendar dates for yesterday, including days with daylight-saving changes. */
export function sessionUpdatedLabel(mtime?: number, now = Date.now()): string {
  if (!mtime || !Number.isFinite(mtime)) return '';
  const date = new Date(mtime);
  const current = new Date(now);
  if (!Number.isFinite(date.getTime())) return '';
  const calendarDay = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((calendarDay(current) - calendarDay(date)) / 86400000);
  const minutes = Math.floor((now - mtime) / 60000);
  if (days === 0 && minutes >= 0) {
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    return `${Math.floor(minutes / 60)}小时前`;
  }
  if (days === 1) return '昨天';
  return date.toLocaleDateString('zh-CN', { ...(date.getFullYear() !== current.getFullYear() ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric' });
}
