import type { AnyMessage } from "./jsonrpc.js";
import { isJsonRpcMessage } from "./jsonrpc.js";

export function serializeSseEvent(msg: AnyMessage): string {
  return `data: ${JSON.stringify(msg)}\n\n`;
}

export function serializeSseKeepAlive(): string {
  return ":\n\n";
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AnyMessage> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        buffer += decoder.decode();
        yield* parseBufferedEvents(buffer);
        return;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      const eventParts = buffer.split(/\r?\n\r?\n/);
      buffer = eventParts.pop() ?? "";

      for (const eventPart of eventParts) {
        const msg = parseSseEvent(eventPart);
        if (msg) {
          yield msg;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function* parseBufferedEvents(buffer: string): Iterable<AnyMessage> {
  if (!buffer.trim()) {
    return;
  }

  const eventParts = buffer.split(/\r?\n\r?\n/);

  for (const eventPart of eventParts) {
    const msg = parseSseEvent(eventPart);
    if (msg) {
      yield msg;
    }
  }
}

function parseSseEvent(eventPart: string): AnyMessage | undefined {
  const dataLines = eventPart
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      const value = line.slice("data:".length);
      return value.startsWith(" ") ? value.slice(1) : value;
    });

  if (dataLines.length === 0) {
    return undefined;
  }

  const data = dataLines.join("\n");
  if (!data.trim()) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(data);
    if (isJsonRpcMessage(parsed)) {
      return parsed;
    }

    console.warn("Skipping SSE payload that is not a JSON-RPC message");
    return undefined;
  } catch (error) {
    console.warn("Failed to parse SSE JSON payload:", error);
    return undefined;
  }
}
