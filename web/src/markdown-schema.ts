import { defaultSchema } from 'rehype-sanitize';

// Mirrors the legacy `src/utils/sanitize.js` allowlist (DOMPurify config) so raw
// HTML inside agent replies keeps working: details/summary, inline icons, task
// checkboxes and the KaTeX wrappers are all preserved while scripts and event
// handlers are dropped.
type Schema = typeof defaultSchema;
type Attributes = NonNullable<Schema['attributes']>;
type PropertyDefinition = NonNullable<Attributes[string]>[number];

const SVG_TAGS = ['svg', 'g', 'path', 'polyline', 'circle', 'line', 'rect', 'polygon', 'animate', 'defs', 'use', 'text', 'tspan', 'marker', 'linearGradient', 'stop'];
const SVG_ATTRS = ['viewBox', 'd', 'points', 'fill', 'fillRule', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'cx', 'cy', 'r', 'x', 'y', 'rx', 'ry', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'opacity', 'transform', 'dur', 'begin', 'values', 'repeatCount'];
const MATH_ATTRS = ['mathVariant', 'ariaHidden'];
const LEGACY_TAGS = ['mark', 'sub', 'sup', 'u', 'kbd', 'button', 'input', 'details', 'summary', 'div', 'span', 'figure', 'figcaption'];

function strings(base: readonly string[] | null | undefined, extra: string[]): string[] {
  return [...new Set([...(base || []), ...extra])];
}

function properties(base: readonly PropertyDefinition[] | null | undefined, extra: string[]): PropertyDefinition[] {
  const merged: PropertyDefinition[] = [...(base || [])];
  for (const item of extra) if (!merged.includes(item)) merged.push(item);
  return merged;
}

export const markdownSchema: Schema = {
  ...defaultSchema,
  // Keep author-provided ids/anchors usable exactly like the legacy renderer.
  clobber: [],
  clobberPrefix: '',
  tagNames: strings(defaultSchema.tagNames, [...LEGACY_TAGS, ...SVG_TAGS, 'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'mspace', 'munderover', 'msupsub', 'mtable', 'mtr', 'mtd']),
  attributes: {
    ...defaultSchema.attributes,
    '*': properties(defaultSchema.attributes?.['*'], ['className', 'id', 'style', 'title', 'data*', ...SVG_ATTRS, ...MATH_ATTRS]),
    a: properties(defaultSchema.attributes?.a, ['href', 'target', 'rel', 'className', 'title']),
    img: properties(defaultSchema.attributes?.img, ['src', 'alt', 'title', 'width', 'height', 'className']),
    input: ['type', 'checked', 'disabled', 'className'],
    code: properties(defaultSchema.attributes?.code, ['className']),
    pre: properties(defaultSchema.attributes?.pre, ['className']),
    span: properties(defaultSchema.attributes?.span, ['className', 'style', 'ariaHidden']),
    div: properties(defaultSchema.attributes?.div, ['className', 'style']),
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ['http', 'https', 'data'],
    // Workspace file links are rewritten to `loopra-file:` by rehypeLocalFileLinks.
    href: [...(defaultSchema.protocols?.href || []), 'loopra-file'],
  },
} as Schema;
