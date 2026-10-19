import { serializeSseJson, serializeSseKeepAlive } from "./sse.js";

import type { OutboundLease } from "./connection.js";

/**
 * Streams the JSON text of each message a lease yields as an SSE event. The
 * body takes a message only when its reader asks for one, so messages its
 * client has not read stay queued, and counted, in their connection.
 */
export function createSseBody(
  lease: OutboundLease<string>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(createSseBodySource(lease), {
    highWaterMark: 0,
  });
}

/** @internal */
export function createSseBodySource(
  lease: OutboundLease<string>,
): UnderlyingDefaultSource<Uint8Array> {
  const encoder = new TextEncoder();
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Whether the reader has asked for a chunk it has not been given. With no
   * high-water mark, a reader that is not waiting may still be writing the
   * last chunk out to a client that stopped reading.
   */
  let isReaderWaiting = false;
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
    // The reader takes this chunk at once; pull() runs again when it asks for
    // another.
    isReaderWaiting = false;
    try {
      controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      return false;
    }
  };

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

  const errorBody = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    error: unknown,
  ): void => {
    if (isClosed) {
      return;
    }

    isClosed = true;
    clearKeepAlive();
    lease.release();
    controller.error(error);
  };

  /**
   * Once the stream stops, the body can only end. A waiting reader has taken
   * every chunk, so the pending receive() ends the body, cleanly or with the
   * error. Any other reader may be stuck on a chunk its client will never
   * take, so abort the body rather than leave its response open.
   */
  const endIfStopped = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (lease.stopped.aborted && !isReaderWaiting) {
      errorBody(controller, lease.stopped.reason);
    }
  };

  /** Hands the reader messages for as long as it waits for them. */
  const deliver = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    if (isReceiving) {
      return;
    }

    isReceiving = true;

    try {
      while (isReaderWaiting && !isClosed) {
        const result = await lease.receive();

        if (isClosed) {
          return;
        }

        if (result.done) {
          closeBody(controller);
          return;
        }

        if (!enqueueText(controller, serializeSseJson(result.value))) {
          closeBody(controller);
          return;
        }

        // The stream may have stopped while this message was on its way.
        endIfStopped(controller);
      }
    } catch (error) {
      errorBody(controller, error);
    } finally {
      isReceiving = false;
    }
  };

  return {
    start(controller) {
      lease.stopped.addEventListener(
        "abort",
        () => {
          endIfStopped(controller);
        },
        { once: true },
      );

      keepAliveTimer = setInterval(() => {
        // Only a waiting reader needs a keep-alive.
        if (isClosed || !isReaderWaiting) {
          return;
        }

        if (!enqueueText(controller, serializeSseKeepAlive())) {
          closeBody(controller);
        }
      }, 15_000);
    },
    // With no high-water mark, this runs only when the reader asks for a
    // chunk. It returns at once, so the stream calls it again whenever the
    // reader asks while a receive() is still pending.
    pull(controller) {
      isReaderWaiting = true;
      void deliver(controller);
    },
    cancel() {
      isClosed = true;
      clearKeepAlive();
      lease.release();
    },
  };
}
