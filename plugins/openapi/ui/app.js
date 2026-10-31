const $ = id => document.getElementById(id);
let sources = [], editing = null, busy = false;
const ask = (action, value = {}) => loopra.request(action, value);
function status(message = "", error = false) { $("status").textContent = message; $("status").className = error ? "error" : ""; }
async function run(task) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach(el => { el.disabled = true; });
  status();
  try { await task(); }
  catch (error) { status(error.message, true); }
  finally { busy = false; document.querySelectorAll("button").forEach(el => { el.disabled = false; }); }
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text || "";
  if (className) el.className = className;
  return el;
}
function button(text, action, className) {
  const el = node("button", text, className);
  el.type = "button";
  el.onclick = () => run(action);
  return el;
}
function home() { $("home").hidden = false; $("editor").hidden = true; $("detail").hidden = true; $("toolbar").hidden = false; $("title").textContent = "OpenAPI"; }
function renderDetail(detail) {
  const container = $("detail-overview");
  container.replaceChildren();
  container.append(node("code", detail.endpoint));
  if (detail.baseUrl) container.append(node("p", detail.baseUrl, "url"));
  if (detail.description || detail.summary) container.append(node("p", detail.description || detail.summary, "description"));
  const parameters = detail.parameters || [];
  if (parameters.length) {
    const table = node("table"), head = node("tr");
    for (const text of ["参数", "位置", "类型", "必填", "说明"]) head.append(node("th", text));
    const thead = node("thead"), tbody = node("tbody");
    thead.append(head);
    for (const parameter of parameters) {
      const row = node("tr");
      for (const text of [parameter.name, parameter.in, parameter.schema?.type || parameter.type || "—", parameter.required ? "是" : "否", parameter.description || "—"]) row.append(node("td", text));
      tbody.append(row);
    }
    table.append(thead, tbody);
    container.append(table);
  }
  if (detail.requestBody) {
    container.append(node("h3", "请求体"), node("pre", JSON.stringify(detail.requestBody, null, 2)));
  }
  if (detail.responses && Object.keys(detail.responses).length) {
    container.append(node("h3", "响应"));
    for (const [code, response] of Object.entries(detail.responses)) container.append(node("p", `${code}  ${response.description || ""}`));
  }
  $("detail-content").textContent = JSON.stringify(detail, null, 2);
}
async function load() { sources = await ask("sources"); renderSources(); }
function renderSources() {
  const container = $("sources");
  container.replaceChildren();
  if (!sources.length) { container.append(node("p", "尚未添加接口源", "empty")); return; }
  for (const source of sources) {
    const row = node("article", "", "source"), info = node("div", "", "source-info");
    const heading = node("div");
    heading.append(node("strong", source.name || "OpenAPI 文档"), node("span", ({ loaded: "已加载", error: "加载失败", disabled: "已停用" })[source.status] || source.status, "state"));
    info.append(heading, node("div", source.docUrl, "url"));
    if (source.errorMessage) info.append(node("p", source.errorMessage, "error"));
    const actions = node("div", "", "actions");
    actions.append(button("编辑", () => edit(source)), button("重新加载", async () => { try { await ask("refresh", source); status("已重新加载"); } finally { await load(); } }));
    const remove = button("删除", async () => { remove.textContent = "确认删除"; remove.onclick = () => run(async () => { await ask("remove", { docUrl: source.docUrl }); await load(); }); }, "danger");
    actions.append(remove);
    row.append(info, actions);
    container.append(row);
  }
}
function authFields() {
  document.querySelectorAll("[data-auth]").forEach(el => {
    el.hidden = el.dataset.auth !== $("auth-type").value;
    for (const input of el.querySelectorAll("input,select")) input.disabled = el.hidden;
  });
}
function edit(source) {
  editing = source || null;
  status();
  $("home").hidden = true;
  $("detail").hidden = true;
  $("toolbar").hidden = true;
  $("editor").hidden = false;
  $("title").textContent = source ? "编辑接口源" : "新增接口源";
  $("editor").reset();
  $("name").value = source?.name || "";
  $("doc-url").value = source?.docUrl || "";
  $("doc-url").readOnly = !!source;
  $("base-url").value = source?.baseUrl || "";
  $("auth-type").value = (source?.authType || "none").toLowerCase();
  const auth = source?.authConfig || {};
  for (const id of ["token", "username", "password"]) $(id).value = auth[id] || "";
  $("key-name").value = auth.name || "";
  $("key-value").value = auth.value || "";
  $("key-in").value = auth.in || "header";
  $("headers").value = Object.entries(source?.headers || {}).map(([key, value]) => key + ": " + value).join("\n");
  authFields();
  $("name").focus();
}
function payload() {
  const headers = {};
  for (const line of $("headers").value.split("\n")) {
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    if (at < 1) throw new Error("请求头格式应为 Key: Value");
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const type = $("auth-type").value;
  let authConfig = {};
  if (type === "bearer") authConfig = { token: $("token").value };
  if (type === "basic") authConfig = { username: $("username").value, password: $("password").value };
  if (type === "apikey") authConfig = { name: $("key-name").value, value: $("key-value").value, in: $("key-in").value };
  return { name: $("name").value.trim(), docUrl: $("doc-url").value.trim(), baseUrl: $("base-url").value.trim(), authType: type, authConfig, headers };
}
$("editor").onsubmit = event => {
  event.preventDefault();
  run(async () => {
    try { await ask(editing ? "refresh" : "save", payload()); home(); await load(); status("已保存"); }
    catch (error) { await load(); throw error; }
  });
};
$("search-form").onsubmit = event => {
  event.preventDefault();
  run(async () => {
    const results = await ask("search", { keyword: $("keyword").value.trim() }), container = $("results");
    container.hidden = false;
    container.replaceChildren(node("h2", "搜索结果"));
    if (!results.length) { container.append(node("p", "没有匹配的接口", "empty")); return; }
    for (const item of results) {
      const article = node("article", "", "result"), heading = node("div", "", "result-heading");
      heading.append(node("strong", item.api_name), button("查看详情", async () => {
        const detail = await ask("detail", { docUrl: item.docUrl, method: item.method, path: item.path });
        $("home").hidden = true;
        $("toolbar").hidden = true;
        $("detail").hidden = false;
        $("detail-title").textContent = item.api_name;
        renderDetail(detail);
      }));
      article.append(heading, node("code", item.endpoint));
      if (item.description || item.summary) article.append(node("p", item.description || item.summary, "description"));
      container.append(article);
    }
  });
};
$("add").onclick = () => edit();
$("reload").onclick = () => run(load);
$("cancel").onclick = () => { home(); status(); };
$("back").onclick = home;
$("auth-type").onchange = authFields;
loopra.ready.then(() => run(load));
for (const [formId, buttonId] of [["editor", "save"], ["search-form", "search"]]) {
  const form = $(formId), submit = () => { if (form.reportValidity()) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); };
  $(buttonId).onclick = submit;
  form.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target.tagName !== "TEXTAREA" && event.target.tagName !== "BUTTON") { event.preventDefault(); submit(); }
  });
}
authFields();
