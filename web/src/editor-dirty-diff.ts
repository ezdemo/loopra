import type * as Monaco from 'monaco-editor';
import type { DirtyDiffChange } from './dirty-diff';

/** Own every decoration, view zone and preview editor for one file revision. */
export function attachDirtyDiff(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, changes: DirtyDiffChange[]): Monaco.IDisposable {
  const model = editor.getModel();
  if (!model) return { dispose() {} };
  const range = (change: DirtyDiffChange) => new monaco.Range(change.startLine, 1, change.endLine, 1);
  const markers = editor.createDecorationsCollection(changes.map(change => ({
    range: range(change),
    options: {
      isWholeLine: change.type !== 'deleted',
      linesDecorationsClassName: `workspace-dirty-glyph workspace-dirty-${change.type}`,
      linesDecorationsTooltip: '点击查看 Git 更改',
      overviewRuler: { color: change.type === 'added' ? '#81b88b' : change.type === 'deleted' ? '#ca4b51' : '#66afe0', position: monaco.editor.OverviewRulerLane.Left },
    },
  })));
  const current = editor.createDecorationsCollection();
  let zone: string | null = null;
  let peekEditor: Monaco.editor.IStandaloneCodeEditor | null = null;
  let peekModel: Monaco.editor.ITextModel | null = null;
  let peekPanel: HTMLElement | null = null;
  let activeIndex = -1;
  let disposed = false;
  function layoutPeek() {
    // View zones span the scrollable code width, which can exceed the viewport.
    if (peekPanel) peekPanel.style.width = `${Math.max(0, Math.min(700, editor.getLayoutInfo().contentWidth - 12))}px`;
  }
  function close() {
    if (zone !== null) editor.changeViewZones(accessor => accessor.removeZone(zone!));
    zone = null;
    peekEditor?.dispose(); peekEditor = null;
    peekModel?.dispose(); peekModel = null;
    peekPanel = null;
    current.clear();
    activeIndex = -1;
  }
  function open(index: number) {
    close();
    activeIndex = (index + changes.length) % changes.length;
    const change = changes[activeIndex];
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const node = document.createElement('div');
    node.className = 'workspace-dirty-peek-zone';
    const panel = document.createElement('section');
    panel.className = 'workspace-dirty-peek';
    peekPanel = panel;
    layoutPeek();
    panel.setAttribute('aria-label', 'Git 行内变更预览');
    // Keep the outer editor from capturing the preview's toolbar and selection.
    panel.addEventListener('pointerdown', event => event.stopPropagation());
    panel.addEventListener('mousedown', event => event.stopPropagation());
    const header = document.createElement('div');
    header.className = 'workspace-dirty-peek-header';
    const title = document.createElement('span');
    title.textContent = `${change.type === 'added' ? '新增' : change.type === 'deleted' ? '删除' : '修改'} · ${activeIndex + 1} / ${changes.length}`;
    const actions = document.createElement('div');
    const button = (text: string, label: string, action: () => void) => {
      const element = document.createElement('button');
      element.type = 'button'; element.textContent = text; element.title = label;
      element.setAttribute('aria-label', label);
      element.addEventListener('click', event => { event.stopPropagation(); action(); });
      return element;
    };
    actions.append(
      button('↑', '上一个更改', () => open(activeIndex - 1)),
      button('↓', '下一个更改', () => open(activeIndex + 1)),
      button('×', '关闭变更预览', () => { close(); editor.focus(); }),
    );
    header.append(title, actions); panel.append(header); node.append(panel);
    const body = document.createElement('div');
    body.className = 'workspace-dirty-peek-body';
    panel.append(body);
    if (change.originalLines.length) {
      peekModel = monaco.editor.createModel(change.originalLines.join('\n'), model!.getLanguageId());
      peekEditor = monaco.editor.create(body, {
        model: peekModel, readOnly: true, domReadOnly: true, automaticLayout: true,
        ariaLabel: '修改前的代码',
        fontFamily: editor.getOption(monaco.editor.EditorOption.fontFamily),
        fontSize: editor.getOption(monaco.editor.EditorOption.fontSize), lineHeight,
        lineNumbers: line => String(change.originalStartLine + line - 1),
        minimap: { enabled: false }, scrollBeyondLastLine: false, contextmenu: false,
        overviewRulerLanes: 0, folding: false, lineDecorationsWidth: 0,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
      });
      peekEditor.createDecorationsCollection([{
        range: peekModel.getFullModelRange(), options: { isWholeLine: true, className: 'workspace-dirty-removed-line' },
      }]);
      peekEditor.onKeyDown(event => {
        if (event.keyCode !== monaco.KeyCode.Escape) return;
        event.preventDefault(); event.stopPropagation(); close(); editor.focus();
      });
    } else {
      body.classList.add('workspace-dirty-peek-empty');
      body.textContent = '此处为新增内容，提交版本中没有对应代码。';
    }
    const height = 34 + (Math.min(10, Math.max(1, change.originalLines.length)) * lineHeight) + 10;
    editor.changeViewZones(accessor => {
      zone = accessor.addZone({ afterLineNumber: change.afterLine, heightInPx: height, domNode: node, suppressMouseDown: true });
    });
    current.set([{
      range: range(change),
      options: {
        isWholeLine: true,
        className: change.type === 'deleted' ? undefined : 'workspace-dirty-current-line',
        linesDecorationsClassName: `workspace-dirty-glyph workspace-dirty-${change.type} workspace-dirty-active`,
      },
    }]);
    editor.revealLineInCenter(change.startLine);
    editor.focus();
  }
  const mouse = editor.onMouseDown(event => {
    if (!event.event.leftButton || event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
    const line = event.target.position?.lineNumber;
    if (!line) return;
    const index = changes.findIndex(change => line >= change.startLine && line <= change.endLine);
    if (index < 0) return;
    event.event.preventDefault();
    if (index === activeIndex) close(); else open(index);
  });
  const keys = editor.onKeyDown(event => {
    if (event.keyCode !== monaco.KeyCode.Escape || zone === null) return;
    event.preventDefault(); event.stopPropagation(); close();
  });
  const layout = editor.onDidLayoutChange(layoutPeek);
  return { dispose() {
    if (disposed) return;
    disposed = true;
    mouse.dispose(); keys.dispose(); layout.dispose(); close(); markers.clear();
  } };
}
