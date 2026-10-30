const skip = new Set(["script", "style", "noscript", "iframe", "object", "embed"]);
const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export function htmlToMarkdown(raw) {
  return collapse(render(parseHTML(raw), false)).trim();
}

export function htmlToText(raw) {
  return textOf(parseHTML(raw)).replace(/\s+/g, " ").trim();
}

function parseHTML(html) {
  const root = { tag: "#document", children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let match;
  while ((match = re.exec(html))) {
    if (match[0].startsWith("<!--")) continue;
    if (match[1]) {
      const name = match[1].toLowerCase();
      while (stack.length > 1 && stack[stack.length - 1].tag !== name) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (match[2]) {
      const tag = match[2].toLowerCase();
      const node = { tag, attrs: match[3] || "", children: [] };
      stack[stack.length - 1].children.push(node);
      if (!match[4] && !voids.has(tag)) stack.push(node);
      continue;
    }
    if (match[5]) stack[stack.length - 1].children.push({ text: match[5] });
  }
  return root;
}

function render(node, inPre) {
  if (!node || skip.has(node.tag)) return "";
  if (node.text != null) return inPre ? node.text : node.text.replace(/\s+/g, " ");
  const inner = () => (node.children || []).map(child => render(child, inPre)).join("");
  switch (node.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "\n\n" + "#".repeat(Number(node.tag[1])) + " " + inner() + "\n\n";
    case "p":
    case "div":
    case "section":
    case "article":
      return "\n\n" + inner() + "\n\n";
    case "br":
      return "\n";
    case "li":
      return "\n- " + inner();
    case "pre":
      return "\n\n```\n" + (node.children || []).map(child => render(child, true)).join("") + "\n```\n\n";
    case "code":
      return inPre ? inner() : "`" + inner() + "`";
    case "a": {
      const label = inner().trim();
      const href = attr(node.attrs, "href");
      if (href && label) return "[" + label + "](" + href + ")";
      return label;
    }
    case "strong":
    case "b":
      return "**" + inner() + "**";
    case "em":
    case "i":
      return "*" + inner() + "*";
    default:
      return inner();
  }
}

function textOf(node) {
  if (!node || skip.has(node.tag)) return "";
  if (node.text != null) return node.text + " ";
  return (node.children || []).map(textOf).join("");
}

function attr(raw, key) {
  const match = new RegExp("(?:^|\\s)" + key + "\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", "i").exec(raw || "");
  if (!match) return "";
  return match[1].replace(/^["']|["']$/g, "");
}

function collapse(value) {
  const lines = value.split("\n");
  const out = [];
  let blank = false;
  for (const line of lines) {
    const trimmed = line.replace(/[ \t]+$/g, "");
    if (!trimmed.trim()) {
      if (blank) continue;
      blank = true;
      out.push("");
      continue;
    }
    blank = false;
    out.push(trimmed);
  }
  return out.join("\n");
}
