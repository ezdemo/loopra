// Streaming reveal for agent replies.
//
// While a turn is still arriving the whole message is re-parsed on every delta,
// so a plain text node grows in jumps: each flush snaps another chunk of prose
// into place. Wrapping every visible character in its own `span.stream-char`
// lets CSS fade each character in as React mounts it — a character that appears
// once animates once, which reads as text flowing out instead of popping.
//
// It stays cheap because of three rules:
//
// 1. Only the *live* region is wrapped: the trailing block the newest characters
//    land in (the last list item, the last paragraph, the last table cell). Older
//    blocks are untouched, so the span count tracks one block, not the message.
// 2. `hast-util-to-jsx-runtime` keys children per tag name within their parent
//    (`span-0`, `span-1`, …). Characters are only ever appended at the end of a
//    block, so every span already on screen keeps its key: React reuses those
//    nodes and only the new tail mounts. Nothing re-animates, and dropping the
//    spans once the turn ends (`streaming` off) is one invisible re-render.
// 3. A block longer than REVEAL_LIMIT stops wrapping; the remainder renders as
//    plain text, so a runaway paragraph cannot leave thousands of spans behind.
type RevealNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: RevealNode[];
};

// Subtrees that must stay whole. Code keeps exact whitespace and is painted from
// a highlighted HTML string; KaTeX lays out its own spans; media and widgets hold
// no prose worth animating.
const OPAQUE_TAGS = new Set(['pre', 'code', 'kbd', 'samp', 'svg', 'math', 'img', 'input', 'textarea', 'video', 'audio', 'iframe']);
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);

// `> [!NOTE]` callouts are recognised from the first text child of a blockquote,
// so that marker has to survive as one piece — splitting it would read as a quote.
const ALERT_MARKER = /^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

// Combining marks, variation selectors, the ZWJ and skin-tone modifiers belong to
// the character before them; splitting them off would orphan a diacritic or an
// emoji modifier.
const CONTINUATION = /^[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20F0\uFE00-\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]$/u;

/** Characters wrapped per live region; beyond this the block renders as plain text. */
export const REVEAL_LIMIT = 2000;

function classNames(node: RevealNode): string[] {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value.split(/\s+/) : [];
}

function isOpaque(node: RevealNode): boolean {
  if (OPAQUE_TAGS.has(node.tagName || '')) return true;
  // rehype-katex emits `<span class="katex">` around its MathML and its visual
  // HTML; splitting either half breaks the formula's layout.
  return classNames(node).includes('katex');
}

function lastElement(node: RevealNode): RevealNode | undefined {
  const children = node.children || [];
  for (let index = children.length - 1; index >= 0; index--) if (children[index].type === 'element') return children[index];
  return undefined;
}

/**
 * The trailing block that new characters land in. Descending through block
 * children keeps the animated span count proportional to one paragraph or list
 * item. When the newest content sits inside something that renders as one unit
 * (a code fence, a formula, an image), there is nothing left to reveal and the
 * answer is `undefined`.
 */
export function liveRegion(root: RevealNode): RevealNode | undefined {
  let node: RevealNode = root;
  for (;;) {
    const last = lastElement(node);
    if (!last) return node;
    if (isOpaque(last)) return undefined;
    // Inline markup at the end (`**bold**`, `` `code` ``) still sits inside the
    // growing block, so the block itself is revealed around it.
    if (!BLOCK_TAGS.has(last.tagName || '')) return node;
    node = last;
  }
}

function character(value: string): RevealNode {
  return { type: 'element', tagName: 'span', properties: { className: ['stream-char'] }, children: [{ type: 'text', value }] };
}

function reveal(parent: RevealNode, budget: { left: number }) {
  const children = parent.children;
  if (!children) return;
  const next: RevealNode[] = [];
  let plain = '';
  const flushPlain = () => { if (plain) { next.push({ type: 'text', value: plain }); plain = ''; } };
  for (const child of children) {
    if (child.type !== 'text') {
      flushPlain();
      next.push(child);
      // Nested inlines (`strong`, `em`, `a`) are revealed too, so a bold word
      // flowing in does not sit still while the text around it animates.
      if (child.type === 'element' && !isOpaque(child)) reveal(child, budget);
      continue;
    }
    let value = child.value || '';
    const marker = ALERT_MARKER.exec(value);
    if (marker) { plain += marker[0]; value = value.slice(marker[0].length); }
    // Whitespace and combining marks are carried onto the next character; a mark
    // that follows a wrapped character joins that character's span instead.
    let carried = '';
    let previous: RevealNode | undefined;
    for (const char of value) {
      if (CONTINUATION.test(char)) {
        if (previous) (previous.children![0].value as string) += char;
        else carried += char;
        continue;
      }
      if (!char.trim()) { carried += char; previous = undefined; continue; }
      plain += carried;
      carried = '';
      if (budget.left <= 0) { plain += char; previous = undefined; continue; }
      budget.left -= 1;
      flushPlain();
      previous = character(char);
      next.push(previous);
    }
    plain += carried;
  }
  flushPlain();
  parent.children = next;
}

/** Runs last in the rehype chain, so it sees the final tree (after sanitize/KaTeX). */
export function rehypeStreamReveal() {
  return (tree: RevealNode) => {
    const region = liveRegion(tree);
    if (region) reveal(region, { left: REVEAL_LIMIT });
  };
}
