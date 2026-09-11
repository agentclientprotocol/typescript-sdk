import type { AnyMessage } from "./jsonrpc.js";
import { isRecord, isJsonRpcMessage } from "./jsonrpc.js";
import { LineBuffer } from "./line-buffer.js";

export function serializeSseEvent(
  msg: AnyMessage | undefined,
  id?: string,
): string {
  if (msg === undefined && id === undefined) {
    throw new TypeError("SSE checkpoint requires an event ID");
  }
  if (id !== undefined && /[\r\n\0]/.test(id)) {
    throw new TypeError("SSE event ID must not contain CR, LF, or NUL");
  }
  const prefix = id === undefined ? "" : `id: ${id}\n`;
  return msg === undefined
    ? `${prefix}\n`
    : `${prefix}data: ${JSON.stringify(msg)}\n\n`;
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
    // Skip primitive payloads with a useful warning; individual objects and
    // batch arrays are left for the connection layer to validate.
    if (isRecord(parsed) || Array.isArray(parsed)) {
      return parsed as AnyMessage;
    }

    console.warn("Skipping SSE payload that is not an object or array");
    return undefined;
  } catch (error) {
    console.warn("Failed to parse SSE JSON payload:", error);
    return undefined;
  }
}

/** @internal */
export class SseProtocolError extends Error {}

// Limits are in decoded UTF-16 code units, allowing large image/tool payloads
// while bounding retained lines and unfinished events in the replay parser.
const MAX_SSE_LINE_LENGTH = 16 * 1024 * 1024;
const MAX_SSE_EVENT_LENGTH = 16 * 1024 * 1024;

/** @internal */
export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<{ message: AnyMessage | undefined; id: string | undefined }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let afterCr = false;
  let data: string[] = [];
  let eventLength = 0;
  let id: string | undefined;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done || signal.aborted) return;
      for (const char of decoder.decode(chunk.value, { stream: true })) {
        if (afterCr && char === "\n") {
          afterCr = false;
          continue;
        }
        afterCr = char === "\r";
        if (char !== "\r" && char !== "\n") {
          if (line.length + char.length > MAX_SSE_LINE_LENGTH)
            throw new SseProtocolError("SSE line exceeds size limit");
          eventLength += char.length;
          if (eventLength > MAX_SSE_EVENT_LENGTH)
            throw new SseProtocolError("SSE event exceeds size limit");
          line += char;
          continue;
        }
        const completedLine = line;
        line = "";
        if (completedLine === "") {
          let message: AnyMessage | undefined;
          if (data.length > 0) {
            let value: unknown;
            try {
              value = JSON.parse(data.join("\n"));
            } catch (cause) {
              throw new SseProtocolError("Invalid SSE JSON payload", { cause });
            }
            if (!isJsonRpcMessage(value))
              throw new SseProtocolError("Invalid SSE JSON-RPC message");
            message = value;
          }
          if (message !== undefined || id !== undefined) yield { message, id };
          data = [];
          id = undefined;
          eventLength = 0;
          continue;
        }
        // Include separators so arbitrarily many empty data fields are bounded.
        if (++eventLength > MAX_SSE_EVENT_LENGTH)
          throw new SseProtocolError("SSE event exceeds size limit");
        const colon = completedLine.indexOf(":");
        const field = colon < 0 ? completedLine : completedLine.slice(0, colon);
        const raw = colon < 0 ? "" : completedLine.slice(colon + 1);
        const value = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "data") data.push(value);
        if (field === "id" && !value.includes("\0")) id = value;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
