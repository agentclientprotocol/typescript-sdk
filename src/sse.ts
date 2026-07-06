import type { AnyMessage } from "./jsonrpc.js";
import { isRecord } from "./jsonrpc.js";
import { LineBuffer } from "./line-buffer.js";

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
  const lines = new LineBuffer();
  let eventLines: string[] = [];

  const decodeLine = (lineBytes: Uint8Array): string => {
    const line = decoder.decode(lineBytes);
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };

  // A blank line ends the current event.
  const takeEvent = (): AnyMessage | undefined => {
    if (eventLines.length === 0) {
      return undefined;
    }
    const event = eventLines;
    eventLines = [];
    return parseSseEvent(event);
  };

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      for (const lineBytes of lines.push(chunk.value)) {
        const line = decodeLine(lineBytes);
        if (line === "") {
          const msg = takeEvent();
          if (msg) {
            yield msg;
          }
        } else {
          eventLines.push(line);
        }
      }
    }

    const lastLine = lines.flush();
    if (lastLine) {
      const line = decodeLine(lastLine);
      if (line !== "") {
        eventLines.push(line);
      }
    }
    const msg = takeEvent();
    if (msg) {
      yield msg;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(eventLines: string[]): AnyMessage | undefined {
  const dataLines = eventLines
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
    // Skip non-object payloads with a useful warning; anything object-shaped
    // is left for the connection layer to validate.
    if (isRecord(parsed)) {
      return parsed as AnyMessage;
    }

    console.warn("Skipping SSE payload that is not an object");
    return undefined;
  } catch (error) {
    console.warn("Failed to parse SSE JSON payload:", error);
    return undefined;
  }
}
