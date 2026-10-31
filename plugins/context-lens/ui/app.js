(() => {
  const $ = id => document.getElementById(id);
  const tones = { system: "#6377d5", tools: "#9a73bc", user: "#409d91", assistant: "#8c929c", result: "#c18a48", media: "#a2a2a2", pin: "#5d8fca" };
  const labels = { system: "系统与项目规则", tools: "工具定义", user: "用户消息", assistant: "助手消息", result: "工具结果", media: "媒体", pin: "固定上下文" };
  let records = [], snapshot = null, selectedBlock = null, filter = "", following = true, generation = 0, pending = 0, picking = 0, scope = "", dirty = false, saving = false, rule = { note: "", folded: [] };
  const number = value => value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 1 : 2).replace(/\.?0+$/, "") + "k" : String(value);
  const time = value => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
  const keyOf = record => JSON.stringify([record.app || "", record.session || ""]);
  function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = String(text); if (className) el.className = className; return el; }
  function status(text = "", error = false) { $("status").hidden = !text; $("status").textContent = text; $("status").className = error ? "error" : ""; }
  function action(task) { return async () => { try { await task(); } catch (error) { status(error.message || String(error), true); } }; }
  function showEmpty() {
    snapshot = null; selectedBlock = null;
    $("empty").hidden = false; $("overview").hidden = true; $("inspector").hidden = true;
    $("empty-text").textContent = "使用 Loopra Native 发起一次对话，模型发送前的上下文会出现在这里。快照从启用插件后开始记录。";
  }
  function back() { selectedBlock = null; $("inspector").hidden = true; $("overview").hidden = false; }
  function syncRule(next) {
    rule = { note: typeof next?.note === "string" ? next.note : "", folded: Array.isArray(next?.folded) ? next.folded : [] };
    if (!dirty) $("pin-note").value = rule.note;
    $("pin-indicator").textContent = rule.note ? "已固定" : "";
    $("pin-count").textContent = $("pin-note").value.length + " / 2000";
    if (selectedBlock) renderFold();
  }
  function split(items, x, y, width, height, output = []) {
    if (!items.length) return output;
    if (items.length === 1) { output.push({ item: items[0], x, y, width, height }); return output; }
    const total = items.reduce((sum, item) => sum + item.tokens, 0);
    let sum = 0, at = 1, best = Infinity;
    for (let i = 1; i < items.length; i++) { sum += items[i - 1].tokens; const distance = Math.abs(total / 2 - sum); if (distance < best) { best = distance; at = i; } }
    const ratio = items.slice(0, at).reduce((sum, item) => sum + item.tokens, 0) / total;
    if (width >= height) { split(items.slice(0, at), x, y, width * ratio, height, output); split(items.slice(at), x + width * ratio, y, width * (1 - ratio), height, output); }
    else { split(items.slice(0, at), x, y, width, height * ratio, output); split(items.slice(at), x, y + height * ratio, width, height * (1 - ratio), output); }
    return output;
  }
  function setFilter(kind) { filter = filter === kind ? "" : kind; renderMap(); renderBlocks(); }
  function renderMap() {
    const map = $("map"), legend = $("legend"); map.replaceChildren(); legend.replaceChildren();
    const groups = snapshot.groups.filter(group => group.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    split(groups, 0, 0, 100, 52).forEach(({ item, x, y, width, height }) => {
      const pct = snapshot.tokens ? item.tokens / snapshot.tokens * 100 : 0;
      const cell = node("button", undefined, `map-cell${width < 25 || height < 15 ? " small" : ""}${width < 12 || height < 8 ? " tiny" : ""}${filter === item.kind ? " active" : ""}`);
      cell.type = "button"; cell.style.cssText = `left:${x}%;top:${y / 52 * 100}%;width:${width}%;height:${height / 52 * 100}%;--tone:${tones[item.kind]}`;
      cell.setAttribute("aria-label", `${item.label}，约 ${number(item.tokens)} tokens，${pct.toFixed(1)}%`);
      cell.setAttribute("aria-pressed", String(filter === item.kind)); cell.title = cell.getAttribute("aria-label");
      cell.append(node("strong", item.label), node("span", pct < 1 ? "<1%" : Math.round(pct) + "%"));
      cell.onclick = () => setFilter(item.kind); map.append(cell);
    });
    snapshot.groups.forEach(group => {
      const button = node("button"); button.type = "button"; button.style.setProperty("--tone", tones[group.kind]);
      button.append(node("i"), node("span", group.label)); button.onclick = () => setFilter(group.kind); legend.append(button);
    });
  }
  function renderBlocks() {
    const query = $("search").value.toLocaleLowerCase().trim();
    const blocks = snapshot.blocks.filter(block => (!filter || block.kind === filter) && (!query || `${block.title} ${block.source} ${block.text}`.toLocaleLowerCase().includes(query)));
    $("blocks").replaceChildren();
    $("filter-reset").textContent = filter ? labels[filter] + " ×" : "全部内容";
    $("block-count").textContent = blocks.length + " 段";
    $("no-results").hidden = !!blocks.length;
    blocks.forEach(block => {
      const button = node("button", undefined, "block"); button.type = "button"; button.style.setProperty("--tone", tones[block.kind]);
      const head = node("span", undefined, "block-head"); head.append(node("i", undefined, "kind-mark"), node("strong", block.title), node("em", block.kind === "media" ? "未计入" : "~" + number(block.tokens)));
      button.append(head, node("span", block.text.replace(/\s+/g, " ").slice(0, 120), "block-preview"), node("span", block.source + (block.folded ? " · 已折叠" : ""), "block-source"));
      button.onclick = () => inspect(block); $("blocks").append(button);
    });
  }
  function renderFold() {
    const folded = rule.folded.includes(selectedBlock.callId);
    $("fold-block").hidden = !selectedBlock.foldable;
    $("fold-block").textContent = folded ? "恢复下次发送原文" : "下次折叠此结果";
    $("fold-block").disabled = saving;
  }
  function inspect(block) {
    following = false; selectedBlock = block;
    $("overview").hidden = true; $("inspector").hidden = false;
    $("inspect-title").textContent = block.title; $("inspect-kind").style.setProperty("--tone", tones[block.kind]);
    $("inspect-tokens").textContent = block.kind === "media" ? "媒体不计入估算" : "~" + number(block.tokens) + " tokens";
    $("inspect-source").textContent = block.source + " · " + time(snapshot.at);
    $("inspect-text").textContent = block.text;
    $("inspect-note").hidden = !block.truncated && !block.folded;
    $("inspect-note").textContent = block.truncated ? "此段过长，展示保留的开头部分；用量按截断前文本估算。" : "这份请求中的结果已经折叠。恢复发送原文将在下一次请求生效。";
    renderFold();
  }
  async function pick(id) {
    const version = generation, request = ++picking;
    const next = await loopra.request("detail", { id });
    if (version !== generation || request !== picking) return;
    const changed = snapshot?.id !== next.id;
    snapshot = next;
    if (changed) { dirty = false; filter = ""; $("search").value = ""; back(); }
    $("empty").hidden = true;
    if (!selectedBlock) $("overview").hidden = false;
    $("requests").value = next.id;
    $("total").textContent = "~" + number(next.tokens); $("time").textContent = time(next.at);
    $("model").textContent = next.model + " · " + ({ chat_completions: "Chat Completions", responses: "Responses", anthropic: "Anthropic" }[next.protocol] || next.protocol);
    $("capture-note").textContent = "发送前快照 · 未计媒体与协议开销" + (next.truncated ? " · 部分内容已截断" : "");
    const config = await loopra.config.get();
    if (version !== generation || snapshot?.id !== next.id) return;
    syncRule((Array.isArray(config.rules) ? config.rules : []).find(rule => rule.key === keyOf(next)));
    renderMap(); renderBlocks();
  }
  async function refresh(force = false) {
    if (pending && !force) return;
    const version = generation, request = ++pending;
    try {
      const data = await loopra.request("list");
      if (version !== generation) return;
      records = data.records;
      if (!records.length) { showEmpty(); return; }
      const selected = following || !records.some(record => record.id === snapshot?.id) ? records[0].id : snapshot.id;
      $("requests").replaceChildren(...records.map((record, index) => {
        const option = node("option", `${time(record.at)}${index === 0 ? " · 最新请求" : ""} · ~${number(record.tokens)}`); option.value = record.id; return option;
      }));
      $("requests").value = selected;
      document.querySelector(".live-dot").classList.toggle("paused", !following);
      if (selected !== snapshot?.id) await pick(selected);
    } catch (error) { if (version === generation) status(error.message || String(error), true); }
    finally { if (version === generation && pending === request) pending = 0; }
  }
  async function saveRule(change) {
    if (!snapshot || saving) return;
    const target = snapshot, version = generation;
    saving = true; $("pin-save").disabled = true; if (selectedBlock) renderFold();
    try {
      const config = await loopra.config.get();
      if (version !== generation) return;
      const rules = Array.isArray(config.rules) ? config.rules : [];
      const old = rules.find(item => item.key === keyOf(target)) || { note: "", folded: [] };
      const next = { ...old, ...change, key: keyOf(target) };
      if (next.note.length > 2000 || next.folded.length > 64) throw new Error("每段会话最多固定 2000 字符、折叠 64 条结果");
      await loopra.config.set({ ...config, rules: [...rules.filter(item => item.key !== next.key).slice(-11), next] });
      if (version !== generation) return;
      dirty = false; syncRule(next); status("已保存，将在这段会话的下一次模型请求生效。");
    } finally { saving = false; $("pin-save").disabled = false; if (selectedBlock) renderFold(); }
  }
  $("requests").onchange = action(async () => { following = false; await pick($("requests").value); });
  $("latest").onclick = action(async () => { following = true; back(); await refresh(true); });
  $("filter-reset").onclick = () => { filter = ""; renderMap(); renderBlocks(); };
  $("search").oninput = renderBlocks;
  $("back").onclick = back;
  $("pin-note").oninput = () => { dirty = true; following = false; $("pin-count").textContent = $("pin-note").value.length + " / 2000"; };
  $("pin-save").onclick = action(() => saveRule({ note: $("pin-note").value.trim() }));
  $("fold-block").onclick = action(() => saveRule({ folded: rule.folded.includes(selectedBlock.callId) ? rule.folded.filter(id => id !== selectedBlock.callId) : [...rule.folded, selectedBlock.callId] }));
  $("pin-block").onclick = () => {
    const text = selectedBlock.text; back(); $("pin-editor").open = true; $("pin-note").value = text.slice(0, 2000); dirty = true;
    $("pin-note").oninput(); $("pin-note").focus();
    if (text.length > 2000) status("已截取前 2000 字符，可编辑后保存。");
  };
  $("empty-refresh").onclick = () => refresh(true);
  $("clear").onclick = action(async () => { await loopra.request("clear"); await refresh(true); });
  loopra.ready.then(async () => {
    const update = context => {
      const next = JSON.stringify([context.workspaceHash || "", context.sessionId || ""]);
      if (next === scope) return;
      scope = next; generation++; pending = 0; dirty = false; following = true; status(); showEmpty();
      void refresh(true);
    };
    loopra.onContext(update); update(loopra.context);
    setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 2000);
  }).catch(error => status(error.message, true));
})();
