import type { AnyMessage } from "./jsonrpc.js";

/**
 * Stream interface for ACP connections.
 *
 * This type powers the bidirectional communication for an ACP connection,
 * providing readable and writable streams of messages.
 *
 * The most common way to create a Stream is using {@link ndJsonStream}.
 */
export type Stream = {
  /**
   * Outgoing JSON-RPC messages written by this side of the ACP connection.
   */
  writable: WritableStream<AnyMessage>;
  /**
   * Incoming JSON-RPC messages read by this side of the ACP connection.
   */
  readable: ReadableStream<AnyMessage>;
};

/**
 * Creates an ACP Stream from a pair of newline-delimited JSON streams.
 *
 * This is the typical way to handle ACP connections over stdio, converting
 * between AnyMessage objects and newline-delimited JSON.
 *
 * @param output - The writable stream to send encoded messages to
 * @param input - The readable stream to receive encoded messages from
 * @returns A Stream for bidirectional ACP communication
 */
export function ndJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  let cancelled = false;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const newline = 0x0a;

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      // Bytes of the current (incomplete) line, carried across chunks.
      let pending: Uint8Array[] = [];

      const takeLine = (tail: Uint8Array): Uint8Array => {
        if (pending.length === 0) {
          return tail;
        }
        let total = tail.byteLength;
        for (const part of pending) {
          total += part.byteLength;
        }
        const line = new Uint8Array(total);
        let offset = 0;
        for (const part of pending) {
          line.set(part, offset);
          offset += part.byteLength;
        }
        line.set(tail, offset);
        pending = [];
        return line;
      };

      const enqueueLine = (lineBytes: Uint8Array) => {
        const trimmedLine = textDecoder.decode(lineBytes).trim();
        if (trimmedLine) {
          try {
            const message = JSON.parse(trimmedLine) as AnyMessage;
            controller.enqueue(message);
          } catch (err) {
            console.error("Failed to parse JSON message:", trimmedLine, err);
          }
        }
      };

      const reader = input.getReader();
      inputReader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (cancelled) {
            return;
          }
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          // Scan only the new chunk for newlines so receiving a message costs
          // O(size) no matter how many chunks it spans.
          let start = 0;
          let newlineIndex = value.indexOf(newline, start);
          while (newlineIndex !== -1) {
            enqueueLine(takeLine(value.subarray(start, newlineIndex)));
            if (cancelled) {
              return;
            }
            start = newlineIndex + 1;
            newlineIndex = value.indexOf(newline, start);
          }
          if (start < value.byteLength) {
            pending.push(start === 0 ? value : value.subarray(start));
          }
        }
        if (cancelled) {
          return;
        }
        if (pending.length > 0) {
          enqueueLine(takeLine(new Uint8Array(0)));
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        controller.error(err);
        return;
      } finally {
        if (inputReader === reader) {
          inputReader = undefined;
        }
        reader.releaseLock();
      }
      if (cancelled) {
        return;
      }
      controller.close();
    },
    cancel(reason) {
      cancelled = true;
      return inputReader?.cancel(reason);
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const content = JSON.stringify(message) + "\n";
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}
