import type { AnyMessage } from "./jsonrpc.js";
import { isRecord } from "./jsonrpc.js";
import { LineBuffer } from "./line-buffer.js";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  MessageBuffer,
  MessageTooLargeError,
} from "./stream-limits.js";

const dataPrefix = new TextEncoder().encode("data:");
const dataSeparator = new Uint8Array([0x0a]);
const maxLineOverhead = 9; // UTF-8 BOM + "data: "; LineBuffer strips LF/CRLF.

export function serializeSseEvent(msg: AnyMessage): string {
  return `data: ${JSON.stringify(msg)}\n\n`;
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
