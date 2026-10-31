import { buildSnapshot, selection, policy, PIN_START, PIN_END } from "./snapshot.js";

export const meta = { displayName: "上下文透镜", description: "查看模型发送前的实际上下文，固定补充信息，折叠冗长工具结果" };
export function tools() { return []; }
let records = [], sequence = 0, size = 0;
const instance = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const MAX_RECORDS = 16, MAX_SIZE = 6 * 1024 * 1024;

export function llmRequest(input) {
  const rule = policy(input.config, input.app, input.sessionId);
  const out = {};
  if (typeof rule.note === "string" && rule.note.trim()) out.system = (input.system || "") + PIN_START + rule.note.trim().slice(0, 2000) + PIN_END;
  if (Array.isArray(rule.folded) && rule.folded.length) out.foldToolResults = rule.folded.filter(id => typeof id === "string").slice(0, 64);
  return out;
}
export function llmRequestSent(input) {
  const snapshot = buildSnapshot(input, instance + "-" + (++sequence));
  snapshot.size = JSON.stringify(snapshot).length * 2;
  if (snapshot.size > MAX_SIZE) {
    // Preserve the full composition and explicit truncation state within a
    // bounded in-memory budget, even for a very large conversation.
    snapshot.blocks.forEach(block => { if (block.text.length > 2000) { block.text = block.text.slice(0, 2000); block.truncated = true; } });
    snapshot.truncated = true;
    snapshot.size = JSON.stringify(snapshot).length * 2;
  }
  records.push(snapshot); size += snapshot.size;
  while (records.length > MAX_RECORDS || (size > MAX_SIZE && records.length > 1)) size -= records.shift().size;
}
export function onRequest({ action, value, context, config }) {
  const scope = selection(context);
  const matches = record => record.app === scope.app && (!scope.session || record.session === scope.session);
  if (action === "list") return { records: records.filter(matches).map(({ blocks, size, ...summary }) => summary).reverse(), policy: policy(config, scope.app, scope.session), scope };
  if (action === "detail") {
    const record = records.find(record => record.id === value.id && matches(record));
    if (!record) throw new Error("这份快照已过期或不属于当前会话，请刷新");
    return record;
  }
  if (action === "clear") {
    records = records.filter(record => !matches(record));
    size = records.reduce((sum, record) => sum + record.size, 0);
    return { ok: true };
  }
  throw new Error("不支持的透镜操作");
}
