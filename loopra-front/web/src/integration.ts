/**
 * Request payload builders for the MCP / OpenAPI integration endpoints.
 *
 * These are kept out of the React components so protocol tests can assert the
 * exact bodies sent to the backend. The shapes mirror the Java DTOs:
 * `McpExportConfig`, `CloudflareTunnelConfig` and `OpenApiController.OpenApiAddRequest`.
 */

export type McpExportToolInfo = { name: string; description?: string; enabled: boolean };
export type McpExportConfigDTO = {
  enabled: boolean; name: string; version: string; channel: string; endpoint: string;
  /** `null` publishes every enabled tool; an array is an explicit whitelist. */
  allowedTools: string[] | null; tools?: McpExportToolInfo[]; endpointUrl?: string;
};

export type TunnelStatus = {
  state?: string; running?: boolean; installed?: boolean; quickTunnel?: boolean; mcpReady?: boolean;
  platform?: string; configuredExecutablePath?: string; executablePath?: string;
  localUrl?: string; publicUrl?: string; mcpEndpoint?: string; error?: string; pid?: number;
};

export type OpenApiSourceDraft = {
  name?: string; docUrl?: string; enabled?: boolean; headers?: Record<string, string>;
  authType?: string; authConfig?: Record<string, string>;
};

/** The backend binds only these six fields; never forward the read-only DTO fields. */
export function mcpExportPayload(config: McpExportConfigDTO, mode: 'all' | 'selected', selected: string[]) {
  return {
    enabled: config.enabled,
    name: config.name,
    version: config.version,
    channel: config.channel,
    endpoint: config.endpoint,
    allowedTools: mode === 'all' ? null : [...new Set(selected)],
  };
}

/**
 * `CloudflareTunnelConfig` only has `executablePath`. The tunnel status DTO
 * exposes `configuredExecutablePath` (saved value) and `executablePath`
 * (resolved binary), so posting the whole DTO would silently save the wrong
 * field.
 */
export function tunnelConfigPayload(executablePath: string) {
  return { executablePath: executablePath.trim() };
}

export function headerLines(headers?: Record<string, string>) {
  return Object.entries(headers || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function parseHeaderLines(text: string) {
  return Object.fromEntries(text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const index = line.indexOf(':');
    return index < 0 ? [line, ''] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
}

export function openApiSourcePayload(draft: OpenApiSourceDraft, headersText: string) {
  const authType = draft.authType || 'none';
  const config = draft.authConfig || {};
  return {
    docUrl: (draft.docUrl || '').trim(),
    headers: parseHeaderLines(headersText),
    authType,
    authConfig: authType === 'none' ? {} : config,
  };
}
