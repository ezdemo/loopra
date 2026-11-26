/** Use calendar dates for yesterday, including days with daylight-saving changes. */
export function sessionUpdatedLabel(mtime?: number, now = Date.now(), translate?: (key: string, params?: Record<string, unknown>) => string, locale = 'zh-CN'): string {
  if (!mtime || !Number.isFinite(mtime)) return '';
  const date = new Date(mtime);
  const current = new Date(now);
  if (!Number.isFinite(date.getTime())) return '';
  const calendarDay = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((calendarDay(current) - calendarDay(date)) / 86400000);
  const minutes = Math.floor((now - mtime) / 60000);
  if (days === 0 && minutes >= 0) {
    if (minutes < 1) return translate ? translate('time.justNow') : '刚刚';
    if (minutes < 60) return translate ? translate('time.minutesAgo', { count: minutes }) : `${minutes}分钟前`;
    return translate ? translate('time.hoursAgo', { count: Math.floor(minutes / 60) }) : `${Math.floor(minutes / 60)}小时前`;
  }
  if (days === 1) return translate ? translate('time.yesterday') : '昨天';
  return date.toLocaleDateString(locale, { ...(date.getFullYear() !== current.getFullYear() ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric' });
}
