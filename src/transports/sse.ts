import type { AnyMessage } from "../core/jsonrpc.js";
import { isRecord, isJsonRpcMessage } from "../core/jsonrpc.js";
import { LineBuffer } from "../core/line-buffer.js";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  MessageBuffer,
  MessageTooLargeError,
} from "../core/stream-limits.js";

const dataPrefix = new TextEncoder().encode("data:");
const dataSeparator = new Uint8Array([0x0a]);
const maxLineOverhead = 9; // UTF-8 BOM + "data: "; LineBuffer strips LF/CRLF.

export function serializeSseEvent(
  msg: AnyMessage | undefined,
  id?: string,
): string {
  return serializeSseJson(
    msg === undefined ? undefined : JSON.stringify(msg),
    id,
  );
}

/** Frames a message's JSON text, which has no line breaks, as an SSE event. */
export function serializeSseJson(
  json: string | undefined,
  id?: string,
): string {
  if (json === undefined && id === undefined) {
    throw new TypeError("SSE checkpoint requires an event ID");
  }
  if (id !== undefined && /[\r\n\0]/.test(id)) {
    throw new TypeError("SSE event ID must not contain CR, LF, or NUL");
  }
  const prefix = id === undefined ? "" : `id: ${id}\n`;
  return json === undefined ? `${prefix}\n` : `${prefix}data: ${json}\n\n`;
}

export function serializeSseKeepAlive(): string {
  return ":\n\n";
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): AsyncIterable<AnyMessage> {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const eventData = new MessageBuffer(maxMessageBytes);
  const lines = new LineBuffer(
    Math.min(Number.MAX_SAFE_INTEGER, maxMessageBytes + maxLineOverhead),
  );
  const reader = body.getReader();
  let hasData = false;
  let finished = false;
  let cancelReason: unknown;

  // A blank line ends the current event.
  const takeEvent = (): AnyMessage | undefined => {
    if (!hasData) {
      return undefined;
    }
    hasData = false;
    return parseSseEvent(decoder.decode(eventData.take()));
  };

  const consumeLine = (line: Uint8Array): AnyMessage | undefined => {
    // Preserve the previous decoder's per-line BOM handling.
    if (line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) {
      line = line.subarray(3);
    }
    if (line.byteLength === 0) {
      return takeEvent();
    }
    if (!dataPrefix.every((byte, index) => line[index] === byte)) {
      return undefined;
    }

    const value = line.subarray(
      dataPrefix.byteLength + (line[dataPrefix.byteLength] === 0x20 ? 1 : 0),
    );
    if (hasData) {
      eventData.append(dataSeparator);
    }
    eventData.append(value);
    hasData = true;
    return undefined;
  };

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        finished = true;
        break;
      }

      for (const lineBytes of lines.push(chunk.value)) {
        const msg = consumeLine(lineBytes);
        if (msg) {
          yield msg;
        }
      }
    }

    const lastLine = lines.flush();
    if (lastLine) {
      const msg = consumeLine(lastLine);
      if (msg) {
        yield msg;
      }
    }
    const msg = takeEvent();
    if (msg) {
      yield msg;
    }
  } catch (error) {
    cancelReason =
      error instanceof MessageTooLargeError &&
      error.maxMessageBytes !== maxMessageBytes
        ? new MessageTooLargeError(maxMessageBytes)
        : error;
    throw cancelReason;
  } finally {
    lines.clear();
    eventData.clear();
    if (!finished) {
      void reader.cancel(cancelReason).catch(() => {});
    }
    reader.releaseLock();
  }
}

function parseSseEvent(data: string): AnyMessage | undefined {
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
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): AsyncIterable<{ message: AnyMessage | undefined; id: string | undefined }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let afterCr = false;
  let lineBytes = 0;
  let eventBytes = 0;
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
          const point = char.codePointAt(0)!;
          lineBytes +=
            point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
          if (lineBytes > maxMessageBytes + maxLineOverhead) {
            throw new MessageTooLargeError(maxMessageBytes);
          }
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
        lineBytes = 0;
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
          eventBytes = 0;
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
        if (field === "data") {
          eventBytes +=
            new TextEncoder().encode(value).byteLength +
            (data.length > 0 ? 1 : 0);
          if (eventBytes > maxMessageBytes)
            throw new MessageTooLargeError(maxMessageBytes);
          data.push(value);
        }
        if (field === "id" && !value.includes("\0")) id = value;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
