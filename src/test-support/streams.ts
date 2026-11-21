const encoder = new TextEncoder();

/** Builds a byte stream that enqueues each chunk and closes. */
export function streamFromChunks(
  chunks: Array<string | Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

/**
 * Builds a message stream for one side of a connection. The test pushes the
 * incoming messages. Messages pushed in one call can all be read at once, as
 * when the peer's messages arrive in one chunk. `end` ends the incoming side
 * as a peer that exits does. `written` collects what the connection writes.
 */
export function pushedMessageStream<Message>(): {
  stream: {
    readable: ReadableStream<Message>;
    writable: WritableStream<Message>;
  };
  push(...messages: Message[]): void;
  end(): void;
  written: Message[];
} {
  let controller!: ReadableStreamDefaultController<Message>;
  const written: Message[] = [];
  return {
    stream: {
      readable: new ReadableStream<Message>({
        start(readableController) {
          controller = readableController;
        },
      }),
      writable: new WritableStream<Message>({
        write(message) {
          written.push(message);
        },
      }),
    },
    push(...messages) {
      for (const message of messages) {
        controller.enqueue(message);
      }
    },
    end() {
      controller.close();
    },
    written,
  };
}

/** Splits data into fixed-size byte chunks. */
export function chunkBytes(data: string, chunkSize: number): Uint8Array[] {
  if (chunkSize <= 0) {
    throw new RangeError("chunkSize must be positive");
  }
  const bytes = encoder.encode(data);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.subarray(i, i + chunkSize));
  }
  return chunks;
}

/** Reads a stream to completion, collecting every value. */
export async function collectStream<T>(
  readable: ReadableStream<T>,
): Promise<T[]> {
  const values: T[] = [];
  const reader = readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      values.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return values;
}

/** Collects an async iterable to completion. */
export async function collectAll<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}
