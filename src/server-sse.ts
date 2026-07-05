import { serializeSseEvent, serializeSseKeepAlive } from "./sse.js";

import type { OutboundSubscription } from "./connection.js";
import type { AnyMessage } from "./jsonrpc.js";

export function createSseBody(
  subscription: OutboundSubscription,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(createSseBodySource(subscription));
}

/** @internal */
export function createSseBodySource(
  subscription: OutboundSubscription,
): UnderlyingDefaultSource<Uint8Array> {
  const encoder = new TextEncoder();
  const replay = [...subscription.replay];
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<AnyMessage> | undefined;
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
      if (isClosed || reader || !hasDemand(controller)) {
        return;
      }

      const replayMessage = replay.shift();
      if (replayMessage) {
        if (!enqueueText(controller, serializeSseEvent(replayMessage))) {
          closeBody(controller);
        }

        return;
      }

      const currentReader = subscription.stream.getReader();
      reader = currentReader;

      try {
        const result = await currentReader.read();

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
        if (reader === currentReader) {
          reader = undefined;
        }

        currentReader.releaseLock();
      }
    },
    cancel() {
      isClosed = true;
      clearKeepAlive();

      if (reader) {
        void reader.cancel();
      } else {
        void subscription.stream.cancel();
      }
    },
  };
}
