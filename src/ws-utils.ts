/** Minimal browser/Node-compatible WebSocket shape used by ACP transports. */
export interface WebSocketLike {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  on?(type: string, listener: (...args: unknown[]) => void): unknown;
  off?(type: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(
    type: string,
    listener: (...args: unknown[]) => void,
  ): unknown;
}

export function onWebSocket(
  socket: WebSocketLike,
  type: string,
  listener: (...args: unknown[]) => void,
): () => void {
  if (socket.on) {
    const eventListener = (...args: unknown[]): void => {
      listener(...normalizeEventEmitterMessageArgs(type, args));
    };
    socket.on(type, eventListener);

    return () => {
      if (socket.off) {
        socket.off(type, eventListener);
        return;
      }

      socket.removeListener?.(type, eventListener);
    };
  }

  if (socket.addEventListener) {
    const eventListener = (event: unknown): void => listener(event);
    socket.addEventListener(type, eventListener);

    return () => {
      socket.removeEventListener?.(type, eventListener);
    };
  }

  throw new Error("WebSocket object does not support event listeners");
}

export function webSocketMessageToString(args: unknown[]): string | undefined {
  const data = extractMessageData(args);

  if (typeof data === "string") {
    return data;
  }

  return undefined;
}

function normalizeEventEmitterMessageArgs(
  type: string,
  args: unknown[],
): unknown[] {
  if (type !== "message" || typeof args[1] !== "boolean") {
    return args;
  }

  if (args[1]) {
    return [undefined];
  }

  return [decodeWebSocketTextData(args[0])];
}

function decodeWebSocketTextData(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  if (isArrayBufferViewArray(data)) {
    return decodeArrayBufferViews(data);
  }

  return undefined;
}

function extractMessageData(args: unknown[]): unknown {
  const [first] = args;

  if (isMessageEventLike(first)) {
    return first.data;
  }

  return first;
}

function isMessageEventLike(value: unknown): value is { data: unknown } {
  return typeof value === "object" && value !== null && "data" in value;
}

function isArrayBufferViewArray(value: unknown): value is ArrayBufferView[] {
  return Array.isArray(value) && value.every(ArrayBuffer.isView);
}

function decodeArrayBufferViews(views: ArrayBufferView[]): string {
  const totalLength = views.reduce((sum, view) => sum + view.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;

  for (const view of views) {
    combined.set(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      offset,
    );
    offset += view.byteLength;
  }

  return new TextDecoder().decode(combined);
}
