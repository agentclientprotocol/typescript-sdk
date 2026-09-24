import { describe, expect, it, vi } from "vitest";

import { OutboundMailbox } from "./connection.js";
import { createSseBody, createSseBodySource } from "./server-sse.js";
import { serializeSseEvent, serializeSseKeepAlive } from "./sse.js";

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
    const mailbox = new OutboundMailbox<string>();
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

    await source.pull?.(controller);
    await flushMicrotasks();
    desiredSize = 0;

    mailbox.push(JSON.stringify(message));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(enqueued.map(decodeText)).toEqual([serializeSseEvent(message)]);
  });
});

describe("createSseBody", () => {
  it("leaves messages queued until its reader asks for one", async () => {
    const mailbox = new OutboundMailbox<string>();
    const lease = mailbox.tryAcquire();
    if (!lease) {
      throw new Error("Expected outbound mailbox lease");
    }
    const reader = createSseBody(lease).getReader();

    mailbox.push(JSON.stringify(message));
    await flushMicrotasks();
    expect(mailbox.hasQueuedMessages).toBe(true);

    const { value } = await reader.read();
    expect(value && decodeText(value)).toBe(serializeSseEvent(message));
    expect(mailbox.hasQueuedMessages).toBe(false);
    await reader.cancel();
  });

  it("ends cleanly when its stream shuts down while the reader waits", async () => {
    const mailbox = new OutboundMailbox<string>();
    const lease = mailbox.tryAcquire();
    if (!lease) {
      throw new Error("Expected outbound mailbox lease");
    }
    const reader = createSseBody(lease).getReader();
    const read = reader.read();
    await flushMicrotasks();

    mailbox.abort();

    await expect(read).resolves.toEqual({ done: true, value: undefined });
  });

  it("sends keep-alives only while its reader waits, and aborts once stopped otherwise", async () => {
    vi.useFakeTimers();

    try {
      const mailbox = new OutboundMailbox<string>();
      const lease = mailbox.tryAcquire();
      if (!lease) {
        throw new Error("Expected outbound mailbox lease");
      }
      const reader = createSseBody(lease).getReader();

      // The reader takes a keep-alive, then stops asking, as if stuck writing
      // it to a client that stopped reading.
      const read = reader.read();
      await vi.advanceTimersByTimeAsync(15_000);
      const { value } = await read;
      expect(value && decodeText(value)).toBe(serializeSseKeepAlive());
      await vi.advanceTimersByTimeAsync(60_000);

      // Even a clean shutdown aborts the body, and no keep-alives piled up.
      mailbox.abort();
      await expect(reader.read()).rejects.toThrow("ACP connection is closed");
    } finally {
      vi.useRealTimers();
    }
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function decodeText(chunk: Uint8Array): string {
  return new TextDecoder().decode(chunk);
}
