export type RecordKind = 'input' | 'model' | 'tool' | 'context';
export type SessionRecord = {
  id: string; kind: RecordKind; label: string; name: string; text: string;
  reasoning: string; args?: unknown; result?: string; timestamp?: number;
  raw: unknown; resultRaw?: unknown;
};
type Raw = Record<string, unknown>;
const object = (value: unknown): Raw => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
export function recordText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(part => {
    const item = object(part);
    return item.type === 'image_url' || item.type === 'input_image' ? '[图片]' : typeof item.text === 'string' ? item.text : recordText(part);
  }).join('\n');
  return JSON.stringify(value, null, 2);
}
export function recordArguments(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return recordText(value);
}
export const recordPreview = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Pair tool outputs by call ID; keep the original messages available for inspection. */
export function sessionRecords(messages: unknown[]): SessionRecord[] {
  const results = new Map<string, { raw: unknown; index: number }>();
  for (const [index, raw] of messages.entries()) {
    const message = object(raw);
    const id = message.tool_call_id ?? message.toolCallId;
    if (message.role === 'tool' && typeof id === 'string' && !results.has(id)) results.set(id, { raw, index });
  }
  const paired = new Set<number>();
  const rows: SessionRecord[] = [];
  for (const [index, raw] of messages.entries()) {
    const message = object(raw);
    if (message.role === 'tool') continue;
    const role = String(message.role || 'context');
    const kind: RecordKind = role === 'assistant' ? 'model' : role === 'user' && !message.web_hidden && !message.webHidden ? 'input' : 'context';
    const text = recordText(message.content ?? message.contentParts);
    const reasoning = recordText(message.reasoning_content ?? message.reasoningContent);
    const calls = message.tool_calls ?? message.toolCalls;
    rows.push({ id: `message-${index}`, kind, label: { input: '输入', model: '助手', tool: '工具', context: '上下文' }[kind], name: '', text: text || (Array.isArray(calls) && calls.length ? '（仅工具调用）' : reasoning ? '（思考）' : '（空消息）'), reasoning, timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined, raw });
    if (!Array.isArray(calls)) continue;
    for (const [callIndex, rawCall] of calls.entries()) {
      const call = object(rawCall); const fn = object(call.function);
      const result = typeof call.id === 'string' ? results.get(call.id) : undefined;
      if (result) paired.add(result.index);
      rows.push({ id: `message-${index}-tool-${callIndex}`, kind: 'tool', label: '工具', name: String(fn.name ?? call.name ?? 'unknown'), args: fn.arguments ?? call.arguments, text: '', reasoning: '', result: result ? recordText(object(result.raw).content ?? object(result.raw).contentParts) : undefined, raw: rawCall, resultRaw: result?.raw });
    }
  }
  // An unmatched tool output must remain visible, including logs imported without their calls.
  for (const [index, raw] of messages.entries()) {
    const message = object(raw);
    if (message.role !== 'tool' || paired.has(index)) continue;
    const row: SessionRecord = { id: `message-${index}`, kind: 'tool', label: '工具', name: '工具结果', text: '', reasoning: '', result: recordText(message.content ?? message.contentParts), raw };
    const following = rows.findIndex(item => Number(item.id.split('-')[1]) > index);
    rows.splice(following < 0 ? rows.length : following, 0, row);
  }
  return rows;
}
export function filterSessionRecords(rows: SessionRecord[], kind: RecordKind | 'all', search: string) {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter(row => (kind === 'all' || row.kind === kind) && (!query || [row.name, row.text, row.reasoning, recordArguments(row.args), row.result || ''].join('\n').toLocaleLowerCase().includes(query)));
}
export function recordJson(row: SessionRecord) {
  return JSON.stringify(row.resultRaw === undefined ? row.raw : { call: row.raw, result: row.resultRaw }, null, 2);
}
