import { Buffer } from "node:buffer";
import { htmlToMarkdown, htmlToText } from "./html.js";
import { callExa } from "./mcp.js";

const description = `联网检索与读取。用 action 选择行为：
- search：实时网页搜索。填写 query，numResults 默认 8。
- code：检索库、SDK 和 API 的代码与文档。填写 query，numResults 为 1-20，默认 8。
- fetch：读取 url 指向的页面。format 为 markdown、text 或 html，默认 markdown；timeoutMs 最大 120000。`;

const searchEndpoint = "https://mcp.exa.ai/mcp";
const codeEndpoint = "https://mcp.exa.ai/mcp?tools=get_code_context_exa";
const maxBody = 5 * 1024 * 1024;
const browserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export const meta = { displayName: "联网", description: "搜索网页、检索代码文档、读取页面" };

export function tools() {
  return [{
    name: "web",
    expose: "web",
    description,
    readOnly: true,
    chat: true,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "search 网页搜索，code 代码与文档检索，fetch 读取页面" },
        query: { type: "string", description: "search 和 code 的查询词" },
        url: { type: "string", description: "fetch 的完整 URL，必须以 http:// 或 https:// 开头" },
        numResults: { type: "integer", description: "search 和 code 的结果数量，默认 8，code 最大 20" },
        format: { type: "string", description: "fetch 的返回格式：markdown、text 或 html，默认 markdown" },
        timeoutMs: { type: "integer", description: "fetch 的超时毫秒数，最大 120000" }
      },
      required: ["action"]
    }
  }];
}

export async function call(input) {
  const args = input.args || {};
  const text = await run(args);
  return { result: text };
}

async function run(args) {
  const action = String(args.action || "").trim().toLowerCase();
  if (action === "search" || action === "websearch") return search(args.query, args.numResults);
  if (action === "code" || action === "codesearch") return code(args.query, args.numResults);
  if (action === "fetch" || action === "webfetch") {
    return retry(3, () => fetchPage(args.url, args.format, Number(args.timeoutMs) || 0));
  }
  throw new Error("action 必须是 search、code 或 fetch");
}

async function search(query, count) {
  query = String(query || "").trim();
  if (!query) throw new Error("query 不能为空");
  count = Number(count) > 0 ? Number(count) : 8;
  const result = await retryExa(() => callExa(searchEndpoint, "web_search_exa", { query, numResults: count }));
  if (result.isError) throw new Error(result.text.trim() || "Search service error");
  if (!result.text.trim()) return "No search results found. Please try a different query.";
  return result.text;
}

async function code(query, count) {
  query = String(query || "").trim();
  if (!query) throw new Error("query 不能为空");
  count = Number(count) > 0 ? Number(count) : 8;
  if (count > 20) count = 20;
  const result = await retryExa(() => callExa(codeEndpoint, "get_code_context_exa", { query, numResults: count }));
  if (result.isError) throw new Error("代码搜索出错: " + (result.text.trim() || "Unknown error"));
  if (!result.text.trim()) return "未找到相关的代码片段或文档。请尝试更换查询词，明确具体的库或编程概念，并检查框架名称拼写是否正确。";
  return result.text;
}

async function retryExa(fn) {
  try {
    return await retry(3, fn);
  } catch (err) {
    if (isTimeout(err)) throw new Error("Search request timed out");
    throw err;
  }
}

async function fetchPage(url, format, timeoutMs) {
  if (!String(url || "").startsWith("http://") && !String(url || "").startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }
  let timeout = timeoutMs;
  if (!(timeout > 0) || timeout > 120000) timeout = 30000;
  format = String(format || "").trim().toLowerCase() || "markdown";
  let got = await request(url, format, browserAgent, timeout);
  if (got.status === 403 && /challenge/i.test(got.header("cf-mitigated"))) {
    got = await request(url, format, "opencode", timeout);
  }
  if (got.status >= 400) throw new Error("Request failed with status code: " + got.status);
  const mime = got.header("content-type").split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/") && !mime.includes("svg") && !mime.includes("vnd.fastbidsheet")) {
    return "data:" + mime + ";base64," + Buffer.from(got.body).toString("base64");
  }
  const raw = decodeText(got.body, got.header("content-type"));
  if (mime === "text/html" && format === "markdown") return htmlToMarkdown(raw);
  if (mime === "text/html" && format === "text") return htmlToText(raw);
  return raw;
}

async function request(url, format, userAgent, timeout) {
  const res = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: acceptHeader(format),
      "accept-language": "en-US,en;q=0.9"
    },
    signal: AbortSignal.timeout(timeout)
  });
  const length = Number(res.headers.get("content-length") || 0);
  if (length > maxBody) throw new Error("Response too large (exceeds 5MB limit)");
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > maxBody) throw new Error("Response too large (exceeds 5MB limit)");
  return {
    status: res.status,
    body,
    header(name) { return res.headers.get(name) || ""; }
  };
}

function acceptHeader(format) {
  if (format === "markdown") return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
  if (format === "text") return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  if (format === "html") return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
}

function decodeText(body, contentType) {
  let charset = "utf-8";
  const match = /charset=([^;]+)/i.exec(contentType || "");
  if (match) charset = match[1].trim().replace(/^["']|["']$/g, "") || charset;
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return Buffer.from(body).toString("utf8");
  }
}

async function retry(times, fn) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function isTimeout(err) {
  const text = String(err && (err.message || err) || "").toLowerCase();
  return err && (err.name === "TimeoutError" || err.name === "AbortError" || text.includes("timeout"));
}
