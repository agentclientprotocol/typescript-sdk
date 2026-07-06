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
