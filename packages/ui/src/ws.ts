import { getToken } from "./api";

export interface WsEvent {
  type: string;
  payload: unknown;
}

/**
 * Connect to the engine's WebSocket. The token rides as the WebSocket
 * subprotocol (browsers cannot set Authorization on a WS handshake, and the
 * subprotocol keeps it out of URLs/logs). Auto-reconnects.
 */
export function connectWs(onEvent: (e: WsEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    ws = new WebSocket(url, [getToken()]);
    ws.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data) as WsEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      retry = setTimeout(open, 1500);
    };
    ws.onerror = () => ws?.close();
  };

  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
