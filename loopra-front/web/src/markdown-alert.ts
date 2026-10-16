// Obsidian-style :::note / :::tip / :::important / :::warning / :::caution
// containers are rewritten to GitHub `> [!NOTE]` blockquotes, which the chat
// renderer turns into .markdown-alert cards (legacy markdown-it-container parity).

export const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
const OPEN = /^:::(note|tip|important|warning|caution)\s*$/i;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export function normalizeAlertMarkdown(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let alert: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (!alert) return;
    out.push(`> [!${alert.toUpperCase()}]`);
    for (const line of body) out.push(line.trim() ? `> ${line}` : '>');
    alert = null;
    body = [];
  };
  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) fence = fence ? null : fenceMatch[1];
    if (alert) {
      if (!fence && line.trim() === ':::') { flush(); continue; }
      body.push(line);
      continue;
    }
    const open = !fence ? OPEN.exec(line) : null;
    if (open) { alert = open[1].toLowerCase(); body = []; continue; }
    out.push(line);
  }
  // An unterminated container still renders, matching markdown-it's leniency.
  flush();
  return out.join('\n');
}
