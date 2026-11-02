import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { getAccessHeaders } from './access-key.js';
import { themeSurface } from './document-theme';

export type ShellSession = {
  id: string; title: string; shell: string; cwd: string; cols: number; rows: number; exited: boolean; exitCode: number;
};

export function shellTerminalTheme(dark: boolean): ITheme {
  return dark ? {
    background: themeSurface.dark, foreground: '#ececea', cursor: '#ececea', cursorAccent: themeSurface.dark,
    selectionBackground: '#264f78', selectionInactiveBackground: '#343f4b',
    black: '#1e1e1e', red: '#f06a62', green: '#3ec27a', yellow: '#e0b860',
    blue: '#6c8cff', magenta: '#c586c0', cyan: '#4db8c6', white: '#d4d4d4',
    brightBlack: '#888888', brightRed: '#ff8a80', brightGreen: '#73d99a', brightYellow: '#f2d088',
    brightBlue: '#9bb0ff', brightMagenta: '#dfade0', brightCyan: '#85dce6', brightWhite: '#ffffff',
  } : {
    background: themeSurface.light, foreground: '#1c1c1a', cursor: '#1c1c1a', cursorAccent: themeSurface.light,
    selectionBackground: '#cce0ff', selectionInactiveBackground: '#e5eaf2',
    black: '#24292f', red: '#b42318', green: '#18733a', yellow: '#795e26',
    blue: '#2457c5', magenta: '#8250a4', cyan: '#116b7a', white: '#57606a',
    brightBlack: '#6e7781', brightRed: '#c52f24', brightGreen: '#1a7f37', brightYellow: '#8a6400',
    brightBlue: '#0969da', brightMagenta: '#953ea0', brightCyan: '#087b8c', brightWhite: '#1c1c1a',
  };
}

const cellSize = (term: Terminal) => {
  const size = term.options.fontSize || 13;
  const ratio = window.devicePixelRatio || 1;
  return { cellW: Math.max(4, Math.round(size * 0.6 * ratio)), cellH: Math.max(8, Math.round(size * 1.15 * ratio)) };
};

export function useShellTerminal(server: string, workspaceHash: string, sessionId: string, active: boolean) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node || !sessionId || !active) return;
    let disposed = false;
    let resizeTimer = 0;
    const pending: string[] = [];
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, "Sarasa Mono SC", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      theme: shellTerminalTheme(document.documentElement.classList.contains('dark')),
      minimumContrastRatio: 4.5,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(node);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = shellTerminalTheme(document.documentElement.classList.contains('dark'));
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const socket = { current: undefined as WebSocket | undefined };
    const sendInput = (data: string) => {
      const ws = socket.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) { pending.push(data); return; }
      ws.send(new TextEncoder().encode(data));
    };
    const sendSize = () => {
      const ws = socket.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !node.clientWidth || !node.clientHeight) return;
      fit.fit();
      const { cellW, cellH } = cellSize(terminal);
      ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows, cellW, cellH }));
    };
    const input = terminal.onData(sendInput);
    const connect = async () => {
      const headers = await getAccessHeaders(server);
      if (disposed) return;
      const url = new URL(`${server.replace(/^http/, 'ws')}/api/shell-terminal/sessions/${encodeURIComponent(sessionId)}/stream`);
      url.searchParams.set('workspaceHash', workspaceHash);
      const key = headers['X-Loopra-Key'];
      if (key) url.searchParams.set('rk', key);
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      socket.current = ws;
      ws.onopen = () => {
        sendSize();
        while (pending.length && ws.readyState === WebSocket.OPEN) sendInput(pending.shift() || '');
      };
      ws.onmessage = event => {
        if (typeof event.data === 'string') return;
        terminal.write(new Uint8Array(event.data as ArrayBuffer));
      };
    };
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(sendSize, 40);
    });
    observer.observe(node);
    void connect();
    return () => {
      disposed = true;
      input.dispose();
      observer.disconnect();
      themeObserver.disconnect();
      window.clearTimeout(resizeTimer);
      socket.current?.close();
      terminal.dispose();
    };
  }, [server, workspaceHash, sessionId, active]);
  return host;
}
