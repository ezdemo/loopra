let nextID = 0;

export async function callExa(endpoint, name, args) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  const opened = await post(endpoint, headers, {
    jsonrpc: "2.0",
    id: ++nextID,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "loopra", version: "1" }
    }
  });
  const session = opened.headers.get("mcp-session-id");
  await readMessage(opened);
  const callHeaders = { ...headers };
  if (session) callHeaders["mcp-session-id"] = session;
  await post(endpoint, callHeaders, { jsonrpc: "2.0", method: "notifications/initialized" });
  const called = await post(endpoint, callHeaders, {
    jsonrpc: "2.0",
    id: ++nextID,
    method: "tools/call",
    params: { name, arguments: args }
  });
  const message = await readMessage(called);
  if (message.error) throw new Error(message.error.message || "Search service error");
  const result = message.result || {};
  const text = (result.content || []).filter(part => part && part.type === "text").map(part => part.text || "").join("\n");
  return { text, isError: !!result.isError };
}

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  return res;
}

async function readMessage(res) {
  const text = await res.text();
  if (!text.trim()) return {};
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type.includes("text/event-stream") || text.includes("data:")) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { last = JSON.parse(data); } catch { /* 忽略注释行 */ }
    }
    if (!last) throw new Error(text.trim() || "Search service error");
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.trim() || "Search service error");
  }
}
