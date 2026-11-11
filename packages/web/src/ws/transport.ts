// Lớp transport tối thiểu để BridgeClient không phụ thuộc WebSocket (sau này có thể thay bằng relay).

export interface TransportHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
}

export interface Transport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type TransportFactory = (url: string, handlers: TransportHandlers) => Transport;

/** Mã đóng chuẩn khi kết nối hỏng mà không có close frame. */
export const ABNORMAL_CLOSE = 1006;
export const NORMAL_CLOSE = 1000;

export const webSocketTransport: TransportFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data === "string") handlers.onMessage(e.data);
  };
  ws.onclose = (e: CloseEvent) => handlers.onClose(e.code, e.reason);
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
};
