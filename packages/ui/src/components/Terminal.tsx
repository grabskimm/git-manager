import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getToken } from "../api";
import { useApp } from "../state";
import "@xterm/xterm/css/xterm.css";

interface Props {
  repoId: string;
}

export function Terminal({ repoId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useApp();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const dark = theme === "dark";
    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: dark
        ? { background: "#0d1117", foreground: "#c9d1d9", cursor: "#58a6ff", selectionBackground: "#1f6feb55" }
        : { background: "#f6f8fa", foreground: "#1f2328", cursor: "#0969da", selectionBackground: "#0969da33" },
      allowProposedApi: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    fitAddon.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/terminal?token=${encodeURIComponent(getToken())}&repoId=${encodeURIComponent(repoId)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      term.focus();
    };

    ws.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        term.write(new Uint8Array(data));
      } else {
        try {
          const msg = JSON.parse(data as string) as { type: string; code?: number; message?: string };
          if (msg.type === "exit") {
            term.write(`\r\n\x1b[2m[process exited with code ${msg.code ?? 0}]\x1b[0m\r\n`);
          } else if (msg.type === "error") {
            // Normalize newlines to CRLF so multi-line guidance renders right.
            const text = String(msg.message ?? "").replace(/\r?\n/g, "\r\n");
            term.write(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
          }
        } catch {
          term.write(data as string);
        }
      }
    };

    ws.onerror = () => term.write("\r\n\x1b[31m[websocket error — is the engine running?]\x1b[0m\r\n");
    ws.onclose = () => term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");

    // Keyboard input → PTY (binary frames for clean binary passthrough)
    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    // Resize: watch container, fit + notify PTY
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      ws.close();
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, theme]);

  return <div ref={containerRef} className="terminal-pane" />;
}
