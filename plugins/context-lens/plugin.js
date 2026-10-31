import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from "node:fs";
import { buildSnapshot, buildHistory, selection, policy, PIN_START, PIN_END } from "./snapshot.js";

export const meta = { displayName: "上下文透镜", description: "查看模型发送前的实际上下文，固定补充信息，折叠冗长工具结果" };
export function tools() { return []; }
let records = [], sequence = 0, size = 0;
let loaded = false, history = null, storageWarning = "";
const instance = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const MAX_RECORDS = 16, MAX_SIZE = 6 * 1024 * 1024;

function load() {
  if (loaded) return;
  loaded = true;
  if (!loopra.dataDir) return;
  const file = loopra.dataDir + "/requests.json";
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size > MAX_SIZE * 2) throw new Error("快照文件过大");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(saved)) throw new Error("快照文件格式无效");
    records = saved.filter(item => item && typeof item.id === "string" && Array.isArray(item.blocks)).slice(-MAX_RECORDS);
    for (const record of records) record.size = JSON.stringify(record).length * 2;
    size = records.reduce((sum, record) => sum + record.size, 0);
    trim();
  } catch (error) { storageWarning = "无法读取已保存快照：" + error.message; }
}
function trim() {
  while (records.length > MAX_RECORDS || (size > MAX_SIZE && records.length > 1)) size -= records.shift().size;
}
function save() {
  if (!loopra.dataDir) return;
  try {
    const file = loopra.dataDir + "/requests.json";
    writeFileSync(file + ".tmp", JSON.stringify(records));
    renameSync(file + ".tmp", file);
    storageWarning = "";
  } catch (error) { storageWarning = "快照暂未保存到磁盘：" + error.message; }
}
function savedHistory(scope) {
  if (!scope.app || !scope.session) return null;
  const cached = history?.app === scope.app && history?.session === scope.session ? history : null;
  const data = loopra.services.request("sessions", "history", { workspaceHash: scope.app, sessionName: scope.session, revision: cached?.revision });
  if (data.unchanged && cached) return cached;
  history = data.messages?.length ? buildHistory(data, scope) : null;
  return history;
}

export function llmRequest(input) {
  const rule = policy(input.config, input.app, input.sessionId);
  const out = {};
  if (typeof rule.note === "string" && rule.note.trim()) out.system = (input.system || "") + PIN_START + rule.note.trim().slice(0, 2000) + PIN_END;
  if (Array.isArray(rule.folded) && rule.folded.length) out.foldToolResults = rule.folded.filter(id => typeof id === "string").slice(0, 64);
  return out;
}
export function llmRequestSent(input) {
  load();
  const snapshot = buildSnapshot(input, instance + "-" + (++sequence));
  snapshot.origin = "request";
  snapshot.size = JSON.stringify(snapshot).length * 2;
  if (snapshot.size > MAX_SIZE) {
    // Preserve the full composition and explicit truncation state within a
    // bounded in-memory budget, even for a very large conversation.
    snapshot.blocks.forEach(block => { if (block.text.length > 2000) { block.text = block.text.slice(0, 2000); block.truncated = true; } });
    snapshot.truncated = true;
    snapshot.size = JSON.stringify(snapshot).length * 2;
  }
  records.push(snapshot); size += snapshot.size;
  trim(); save();
}
export function onRequest({ action, value, context, config }) {
  load();
  const scope = selection(context);
  const matches = record => record.app === scope.app && (!scope.session || record.session === scope.session);
  if (action === "list") {
    const selected = records.filter(matches);
    const fallback = selected.length ? null : savedHistory(scope);
    return { records: (fallback ? [fallback] : selected).map(({ blocks, size, ...summary }) => summary).reverse(), policy: policy(config, scope.app, scope.session), scope, warning: storageWarning };
  }
  if (action === "detail") {
    let record = records.find(record => record.id === value.id && matches(record));
    if (!record && value.id?.startsWith("history:")) {
      const candidate = savedHistory(scope);
      if (candidate?.id === value.id) record = candidate;
    }
    if (!record) throw new Error("这份快照已过期或不属于当前会话，请刷新");
    return record;
  }
  if (action === "clear") {
    records = records.filter(record => !matches(record));
    size = records.reduce((sum, record) => sum + record.size, 0);
    save();
    return { ok: true };
  }
  throw new Error("不支持的透镜操作");
}
