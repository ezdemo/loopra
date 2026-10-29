// Width rules for the right-hand workbench dock, mirroring the legacy
// RightPanel.vue drag behaviour (240px floor, 70% of the viewport cap).
export const DEFAULT_PANEL_WIDTH = 452;
export const WIDE_PANEL_WIDTH = 560;
export const MIN_PANEL_WIDTH = 240;
export const MAX_PANEL_WIDTH_RATIO = 0.7;

export function clampPanelWidth(width: number, viewport: number): number {
  const max = Math.max(Math.floor(viewport * MAX_PANEL_WIDTH_RATIO), MIN_PANEL_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_PANEL_WIDTH), max));
}

// Dragging the panel's left edge leftwards (negative delta) widens it.
export function resizePanelWidth(startWidth: number, pointerDeltaX: number, viewport: number): number {
  return clampPanelWidth(startWidth - pointerDeltaX, viewport);
}

// The left sidebar resizes by dragging its right edge: 180px floor, 480px cap,
// and never more than 45% of a narrow window.
export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;
export const MAX_SIDEBAR_WIDTH_RATIO = 0.45;

export function clampSidebarWidth(width: number, viewport: number): number {
  const max = Math.max(Math.min(MAX_SIDEBAR_WIDTH, Math.floor(viewport * MAX_SIDEBAR_WIDTH_RATIO)), MIN_SIDEBAR_WIDTH);
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), max));
}

// Dragging rightwards (positive delta) widens the sidebar.
export function resizeSidebarWidth(startWidth: number, pointerDeltaX: number, viewport: number): number {
  return clampSidebarWidth(startWidth + pointerDeltaX, viewport);
}
