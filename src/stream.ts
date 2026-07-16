import type { AnyMessage, AnyWireMessage } from "./jsonrpc.js";
import { isRecord } from "./jsonrpc.js";
import { LineBuffer } from "./line-buffer.js";

/**
 * Stream interface for ACP connections.
 *
 * This type powers the bidirectional communication for an ACP connection,
 * providing readable and writable streams of messages.
 *
 * The most common way to create a Stream is using {@link ndJsonStream}.
 */
export type Stream<Message extends AnyWireMessage = AnyMessage> = {
  /**
   * Outgoing JSON-RPC messages written by this side of the ACP connection.
   */
  writable: WritableStream<Message>;
  /**
   * Incoming JSON-RPC messages read by this side of the ACP connection.
   */
  readable: ReadableStream<Message>;
};

/**
 * ACP stream that exposes JSON-RPC batch messages in addition to individual
 * messages.
 */
export type WireStream = Stream<AnyWireMessage>;

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
export function ndJsonStream<Message extends AnyWireMessage = AnyMessage>(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): Stream<Message> {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  let cancelled = false;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const readable = new ReadableStream<Message>({
    async start(controller) {
      const lines = new LineBuffer();

      const enqueueLine = (lineBytes: Uint8Array) => {
        const trimmedLine = textDecoder.decode(lineBytes).trim();
        if (trimmedLine) {
          try {
            const message: unknown = JSON.parse(trimmedLine);
            // Skip primitive lines with a useful warning; individual objects
            // and batch arrays are left for the connection layer to validate.
            if (isRecord(message) || Array.isArray(message)) {
              controller.enqueue(message as Message);
            } else {
              console.warn(
                "Skipping JSON line that is not an object:",
                trimmedLine,
              );
            }
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
          for (const line of lines.push(value)) {
            enqueueLine(line);
            if (cancelled) {
              return;
            }
          }
        }
        if (cancelled) {
          return;
        }
        const lastLine = lines.flush();
        if (lastLine) {
          enqueueLine(lastLine);
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

  const writable = new WritableStream<Message>({
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
