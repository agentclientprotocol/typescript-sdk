import { serializeSseEvent, serializeSseKeepAlive } from "./sse.js";

import type { OutboundLease } from "./connection.js";

export function createSseBody(
  lease: OutboundLease,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(createSseBodySource(lease));
}

/** @internal */
export function createSseBodySource(
  lease: OutboundLease,
): UnderlyingDefaultSource<Uint8Array> {
  const encoder = new TextEncoder();
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  let isReceiving = false;
  let isClosed = false;

  const clearKeepAlive = (): void => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = undefined;
    }
  };

  const enqueueText = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): boolean => {
    try {
      controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      return false;
    }
  };

  const hasDemand = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => controller.desiredSize !== null && controller.desiredSize > 0;

  const closeBody = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (isClosed) {
      return;
    }

    isClosed = true;
    clearKeepAlive();
    lease.release();

    try {
      controller.close();
    } catch {
      // Stream may already be cancelled by the consumer.
    }
  };

  return {
    start(controller) {
      keepAliveTimer = setInterval(() => {
        if (isClosed || !hasDemand(controller)) {
          return;
        }

        if (!enqueueText(controller, serializeSseKeepAlive())) {
          closeBody(controller);
        }
      }, 15_000);
    },
    async pull(controller) {
      if (isClosed || isReceiving || !hasDemand(controller)) {
        return;
      }

      isReceiving = true;

      try {
        const result = await lease.receive();

        if (isClosed) {
          return;
        }

        if (result.done) {
          closeBody(controller);
          return;
        }

        if (!enqueueText(controller, serializeSseEvent(result.value))) {
          closeBody(controller);
        }
      } catch (error) {
        if (!isClosed) {
          isClosed = true;
          clearKeepAlive();
          controller.error(error);
        }
      } finally {
        isReceiving = false;
      }
    },
    cancel() {
      isClosed = true;
      clearKeepAlive();
      lease.release();
    },
  };
}
