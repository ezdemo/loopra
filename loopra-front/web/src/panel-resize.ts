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
