import { describe, expect, it } from "vitest";

import { OutboundMailbox } from "./connection.js";
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
    const mailbox = new OutboundMailbox<AnyMessage>();
    const lease = mailbox.tryAcquire();
    if (!lease) {
      throw new Error("Expected outbound mailbox lease");
    }
    const source = createSseBodySource(lease);
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

    mailbox.push(message);
    await pull;

    expect(enqueued.map(decodeText)).toEqual([serializeSseEvent(message)]);
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function decodeText(chunk: Uint8Array): string {
  return new TextDecoder().decode(chunk);
}
