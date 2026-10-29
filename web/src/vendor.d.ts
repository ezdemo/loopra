// mammoth ships browser-only typings under a subpath that has no bundled types.
declare module 'mammoth/mammoth.browser' {
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value?: string; messages?: unknown[] }>;
}
