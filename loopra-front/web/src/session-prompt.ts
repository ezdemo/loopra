// `/agent/prompt` returns { content, length }; tolerate a plain string too so a
// backend shape change cannot render an object into JSX and crash the page.
export function promptText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'content' in value) {
    const content = (value as { content?: unknown }).content;
    return typeof content === 'string' ? content : '';
  }
  return '';
}
