import type { AnyMessage } from "./jsonrpc.js";
import { RequestError, isRecord, protocolErrorResponse } from "./jsonrpc.js";
import { LineBuffer } from "./line-buffer.js";
import { resolveMaxMessageBytes } from "./stream-limits.js";

export interface NdJsonStreamOptions {
  readonly maxMessageBytes?: number;
}

/**
 * Stream interface for ACP connections.
 *
 * This type powers the bidirectional communication for an ACP connection,
 * providing readable and writable streams of messages.
 *
 * The most common way to create a Stream is using {@link ndJsonStream}.
 */
export type Stream<Message extends AnyMessage = AnyMessage> = {
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
 * Reports a failure to the reader of a message stream after the messages
 * already queued for it. `controller.error()` alone drops them, so the last
 * messages a peer sent before its transport failed would never be read.
 *
 * A source calls `fail` where it would call `controller.error`, and calls
 * `pull` from its `pull()`. The stream calls `pull()` once its queue is
 * empty, which is when a waiting failure is reported. This relies on the
 * default high-water mark of 1.
 *
 * @internal
 */
export function failureAfterQueued<Message>(): {
  fail(
    controller: ReadableStreamDefaultController<Message>,
    error: unknown,
  ): void;
  pull(controller: ReadableStreamDefaultController<Message>): void;
} {
  let waiting: { error: unknown } | undefined;
  return {
    fail(controller, error) {
      if (waiting) {
        return;
      }

      // There is room in the queue only when it is empty.
      if ((controller.desiredSize ?? 1) > 0) {
        controller.error(error);
      } else {
        waiting = { error };
      }
    },
    pull(controller) {
      if (waiting) {
        controller.error(waiting.error);
      }
    },
  };
}

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
export function ndJsonStream<Message extends AnyMessage = AnyMessage>(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options: NdJsonStreamOptions = {},
): Stream<Message> {
  const maxMessageBytes = resolveMaxMessageBytes(options.maxMessageBytes);
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  let cancelled = false;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let outputWrite: Promise<void> = Promise.resolve();
  const failure = failureAfterQueued<Message>();

  const writeJson = (message: unknown): Promise<void> => {
    const content = JSON.stringify(message) + "\n";
    const write = outputWrite.then(async () => {
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    });
    outputWrite = write.catch(() => {});
    return write;
  };

  const readable = new ReadableStream<Message>({
    async start(controller) {
      const lines = new LineBuffer(maxMessageBytes);

      const enqueueLine = async (lineBytes: Uint8Array) => {
        const trimmedLine = textDecoder.decode(lineBytes).trim();
        if (!trimmedLine) {
          return;
        }

        let message: unknown;
        try {
          message = JSON.parse(trimmedLine);
        } catch {
          await writeJson(protocolErrorResponse(RequestError.parseError()));
          return;
        }

        // ACP does not use JSON-RPC batches: answer a JSON array with a
        // single -32600 response with `id: null`, without processing it.
        if (Array.isArray(message)) {
          await writeJson(
            protocolErrorResponse(
              RequestError.invalidRequest(
                undefined,
                "JSON-RPC batches are not supported",
              ),
            ),
          );
        } else if (isRecord(message)) {
          controller.enqueue(message as Message);
        } else {
          await writeJson(
            protocolErrorResponse(RequestError.invalidRequest(message)),
          );
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
            await enqueueLine(line);
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
          await enqueueLine(lastLine);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        // The messages parsed before the input failed are read first.
        failure.fail(controller, err);
        void reader.cancel(err).catch(() => {});
        return;
      } finally {
        lines.clear();
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
    pull(controller) {
      failure.pull(controller);
    },
    cancel(reason) {
      cancelled = true;
      return inputReader?.cancel(reason);
    },
  });

  const writable = new WritableStream<Message>({
    write(message) {
      return writeJson(message);
    },
  });

  return { readable, writable };
}
