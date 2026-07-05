import { describe, expect, it } from "vitest";

import { createSseBodySource } from "./server-sse.js";
import { serializeSseEvent } from "./sse.js";

import type { AnyMessage } from "./jsonrpc.js";

const message = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    ok: true,
  },
} satisfies AnyMessage;

describe("createSseBodySource", () => {
  it("enqueues a subscription message after it has been read even if demand changed", async () => {
    const backend = new TransformStream<AnyMessage, AnyMessage>();
    const writer = backend.writable.getWriter();
    const source = createSseBodySource({
      replay: [],
      stream: backend.readable,
    });
    const enqueued: Uint8Array[] = [];
    let desiredSize: number | null = 1;
    const controller = {
      get desiredSize() {
        return desiredSize;
      },
      enqueue(chunk: Uint8Array) {
        enqueued.push(chunk);
      },
      close() {
        return undefined;
      },
      error(error?: unknown) {
        if (error) {
          throw error;
        }
      },
    } as ReadableStreamDefaultController<Uint8Array>;

    const pull = Promise.resolve(source.pull?.(controller));
    await flushMicrotasks();
    desiredSize = 0;

    await Promise.all([pull, writer.write(message)]);

    expect(enqueued.map(decodeText)).toEqual([serializeSseEvent(message)]);
    writer.releaseLock();
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function decodeText(chunk: Uint8Array): string {
  return new TextDecoder().decode(chunk);
}
