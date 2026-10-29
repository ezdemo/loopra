// Normalizes markdown math toward the legacy markdown-it-texmath `dollars`
// behavior before react-markdown parses it:
// - `$$...$$` on a text line is promoted to its own block so rehype-katex can
//   render it as display math (AI replies often write "答案 $$...$$" inline).
// - A `$` that cannot open a valid inline formula (empty, newline, or touching
//   whitespace) is escaped, so prices like "$5 和 $6" stay literal text.
// Fenced code blocks and inline code spans are left untouched.

function fenceAt(text: string, index: number) {
  if (index > 0 && text[index - 1] !== '\n') return null;
  const match = /^(`{3,}|~{3,})/.exec(text.slice(index));
  return match ? match[1] : null;
}

function endOfFence(text: string, from: number, marker: string) {
  const pattern = new RegExp(`(^|\\n)${marker[0]}{${marker.length},}[^\n]*`, 'g');
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? match.index + match[0].length : text.length;
}

function endOfInlineCode(text: string, from: number) {
  const run = /^`+/.exec(text.slice(from))![0];
  const close = text.indexOf(run, from + run.length);
  return close === -1 ? text.length : close + run.length;
}

export function normalizeMathMarkdown(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const fence = fenceAt(text, index);
    if (fence) { const end = endOfFence(text, index, fence); out += text.slice(index, end); index = end; continue; }
    if (text[index] === '`') { const end = endOfInlineCode(text, index); out += text.slice(index, end); index = end; continue; }
    if (text.startsWith('$$', index)) {
      const close = text.indexOf('$$', index + 2);
      const value = close === -1 ? '' : text.slice(index + 2, close);
      if (close === -1 || !value.trim()) { out += '$$'; index += 2; continue; }
      const after = text.slice(close + 2);
      const blockStart = out.length === 0 || /\n\n$/.test(out);
      const blockEnd = after === '' || after.startsWith('\n');
      // Block math needs its delimiters on their own lines; a one-line `$$x$$`
      // parses as inline math otherwise.
      const body = value.includes('\n') ? `$$${value}$$` : `$$\n${value}\n$$`;
      out += `${blockStart ? '' : '\n\n'}${body}${blockEnd ? '' : '\n\n'}`;
      index = close + 2;
      continue;
    }
    if (text[index] === '$') {
      const close = text.indexOf('$', index + 1);
      const value = close === -1 ? '' : text.slice(index + 1, close);
      if (close === -1 || !value || value.includes('\n') || /^\s/.test(value) || /\s$/.test(value)) { out += '\\$'; index += 1; continue; }
      out += `$${value}$`;
      index = close + 1;
      continue;
    }
    out += text[index];
    index += 1;
  }
  return out;
}
