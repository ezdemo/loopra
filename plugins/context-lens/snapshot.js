import { Buffer } from "node:buffer";

export const PIN_START = "\n\n<loopra_context_pin>\n";
export const PIN_END = "\n</loopra_context_pin>";
export const FOLDED = "此工具结果已由用户在上下文透镜中折叠";
const MAX_TEXT = 96000;
const labels = { system: "系统与项目规则", tools: "工具定义", user: "用户消息", assistant: "助手消息", result: "工具结果", media: "媒体", pin: "固定上下文" };
export const scopeKey = (app, session) => JSON.stringify([app || "", session || ""]);
export function selection(context = {}) {
  const app = context.workspaceHash || "";
  const id = context.sessionId || "";
  return { app, session: id.startsWith(app + "/") ? id.slice(app.length + 1) : id };
}
export function policy(config, app, session) {
  return (Array.isArray(config?.rules) ? config.rules : []).find(rule => rule?.key === scopeKey(app, session)) || { note: "", folded: [] };
}

export function buildHistory(data, scope) {
  const record = buildSnapshot({ app: scope.app, sessionId: scope.session, protocol: "history", body: { messages: data.messages } }, "history:" + scopeKey(scope.app, scope.session) + ":" + data.revision, data.at || 0);
  record.origin = "history";
  record.revision = data.revision;
  record.model = data.model || "";
  record.agent = data.agentId || "";
  record.native = data.native !== false;
  record.truncated ||= !!data.truncated;
  return record;
}
function printable(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null, function(key, item) {
    if (typeof item === "string" && (item.startsWith("data:") || (key === "data" && this.type === "base64"))) return "[媒体原始数据省略]";
    return item;
  }, 2);
}

// Only protocol content present in the serialized request is projected here.
// A skills directory remains a directory, not a claim that a skill was read.
export function buildSnapshot(input, id, now = Date.now()) {
  const body = input.body || {}, blocks = [];
  let omitted = 0, blockSequence = 0;
  function add(kind, text, source, title, callId = "", name = "") {
    if (text === undefined || text === null || text === "") return;
    if (blocks.length >= 800) {
      omitted++;
      if (input.protocol === "history") blocks.shift();
      else return;
    }
    const full = printable(text), bytes = Buffer.byteLength(full, "utf8");
    blocks.push({ id: "block-" + blockSequence++, kind, title: title || labels[kind], source, name, callId,
      foldable: kind === "result" && !!callId && (input.foldableCalls || []).includes(callId),
      folded: kind === "result" && full.includes(FOLDED), text: full.slice(0, MAX_TEXT), truncated: full.length > MAX_TEXT,
      bytes, tokens: kind === "media" ? 0 : Math.ceil(bytes / 4) });
  }
  function system(value, source) {
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.map(item => item.text || "").join("\n") : printable(value);
    if (!text) return;
    const at = text.indexOf(PIN_START);
    const rest = at < 0 ? text : text.slice(0, at);
    const skills = rest.indexOf("可用技能（先使用 skillread 读取完整规约）：");
    if (skills >= 0) {
      add("system", rest.slice(0, skills), source, "系统与项目规则");
      add("system", rest.slice(skills), source, "技能目录");
    } else add("system", rest, source);
    if (at >= 0) add("pin", text.slice(at + PIN_START.length).replace(PIN_END, ""), source);
  }
  function content(value, role, source) {
    const kind = role === "assistant" ? "assistant" : role === "tool" ? "result" : "user";
    if (!Array.isArray(value)) { add(kind, value, source); return; }
    value.forEach((part, index) => {
      const path = `${source}[${index}]`;
      if (typeof part === "string") { add(kind, part, path); return; }
      if (!part) return;
      if (part.type === "tool_result") {
        add("result", part.content, path, part.tool_use_id || "工具结果", part.tool_use_id);
      } else if (part.type === "tool_use") {
        add("assistant", { name: part.name, arguments: part.input }, path, "调用 " + part.name);
      } else if (part.text !== undefined) {
        add(kind, part.text, path);
      } else if (part.type === "thinking" && part.thinking) {
        add("assistant", part.thinking, path, "请求携带的推理记录");
      } else {
        const type = part.type || "media";
        add("media", type.includes("image") || type === "image" ? "图片内容（未保存媒体原始数据）" : type.includes("audio") ? "音频内容（未保存媒体原始数据）" : type + "（未保存媒体原始数据）", path);
      }
    });
  }
  if (body.system) system(body.system, "system");
  if (body.instructions) system(body.instructions, "instructions");
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const calls = new Map();
  function remember(id, name, args) {
    if (!id) return;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
    const path = args?.path || args?.file_path;
    calls.set(id, { name, title: name + (typeof path === "string" ? " · " + path : "") });
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    for (const call of message.tool_calls || []) remember(call.id, call.function?.name || "工具", call.function?.arguments);
    if (message.type === "function_call") remember(message.call_id, message.name || "工具", message.arguments);
    if (Array.isArray(message.content)) for (const part of message.content) { if (part?.type === "tool_use") remember(part.id, part.name || "工具", part.input); }
  }
  if (typeof body.input === "string") add("user", body.input, "input");
  messages.forEach((message, index) => {
    const path = `${input.protocol === "history" ? "history" : Array.isArray(body.messages) ? "messages" : "input"}[${index}]`;
    if (typeof message === "string") { add("user", message, path); return; }
    if (message.role === "system" || message.role === "developer") system(message.content, path + ".content");
    else if (message.role === "tool") add("result", message.content, path + ".content", calls.get(message.tool_call_id)?.title || message.tool_name || message.name || "工具结果", message.tool_call_id, calls.get(message.tool_call_id)?.name || message.tool_name || message.name);
    else if (message.type === "function_call_output") add("result", message.output, path + ".output", calls.get(message.call_id)?.title || "工具结果", message.call_id, calls.get(message.call_id)?.name);
    else if (message.type === "function_call") add("assistant", { name: message.name, arguments: message.arguments }, path, "调用 " + message.name);
    else if (message.type === "reasoning") {
      const summary = Array.isArray(message.summary) ? message.summary.map(part => part.text || "").filter(Boolean).join("\n") : "";
      if (summary) add("assistant", summary, path + ".summary", "请求携带的推理摘要");
      if (message.encrypted_content) add("media", "不透明推理载荷（无法估算 token，未保存载荷原文）", path + ".encrypted_content", "推理载荷");
    }
    else content(message.content, message.role, path + ".content");
    if (input.protocol === "history" && message.reasoning_content) add("assistant", message.reasoning_content, path + ".reasoning_content", "已保存的思考记录");
    (message.tool_calls || []).forEach((call, n) => add("assistant", call.function, `${path}.tool_calls[${n}]`, "调用 " + (call.function?.name || "工具")));
  });
  (body.tools || []).forEach((tool, index) => add("tools", tool, `tools[${index}]`, tool.function?.name || tool.name || tool.type || "工具定义"));
  const groups = Object.entries(labels).map(([kind, label]) => ({ kind, label, count: blocks.filter(b => b.kind === kind).length, tokens: blocks.filter(b => b.kind === kind).reduce((sum, b) => sum + b.tokens, 0) })).filter(group => group.count);
  return { id, at: now, app: input.app || "", session: input.sessionId || "", parent: input.parentSessionId || "", model: body.model || input.model || "", protocol: input.protocol || "", invocation: input.invocationId || "", requestBytes: input.requestBytes || 0,
    tokens: groups.reduce((sum, group) => sum + group.tokens, 0), groups, blocks, omitted, media: blocks.some(block => block.kind === "media"), truncated: omitted > 0 || blocks.some(block => block.truncated) };
}
