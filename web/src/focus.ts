/** Track navigation input so pointer-triggered focus restores never leave a ring. */
export function installFocusAppearance(root = document.documentElement) {
  const events = new AbortController();
  root.dataset.focusModality = 'pointer';
  root.ownerDocument.addEventListener('pointerdown', () => {
    root.dataset.focusModality = 'pointer';
  }, { capture: true, signal: events.signal });
  root.ownerDocument.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    root.dataset.focusModality = 'keyboard';
  }, { capture: true, signal: events.signal });
  return () => events.abort();
}
