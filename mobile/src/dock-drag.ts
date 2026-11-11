export type DockPage = 'threads' | 'projects';

export function clampDockThumb(x: number, step: number): number {
  return Math.min(Math.max(0, x), Math.max(0, step));
}

export function dockPageAt(x: number, step: number): DockPage {
  return x >= step / 2 ? 'projects' : 'threads';
}
