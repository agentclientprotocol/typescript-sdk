import { describe, expect, it, vi } from "vitest";

import {
  parseSseStream,
  serializeSseEvent,
  serializeSseKeepAlive,
} from "./sse.js";

import type { AnyMessage } from "./jsonrpc.js";

const encoder = new TextEncoder();

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectMessages(
  body: ReadableStream<Uint8Array>,
): Promise<AnyMessage[]> {
  const messages: AnyMessage[] = [];
  for await (const message of parseSseStream(body)) {
    messages.push(message);
  }
  return messages;
}

describe("SSE transport helpers", () => {
  it("serializes a message event", () => {
    const message: AnyMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    };

    expect(serializeSseEvent(message)).toBe(
      `data: ${JSON.stringify(message)}\n\n`,
    );
  });

  it("serializes a keepalive comment", () => {
    expect(serializeSseKeepAlive()).toBe(":\n\n");
  });

  it("parses one event", async () => {
    const message: AnyMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };

    await expect(
      collectMessages(streamFromChunks([serializeSseEvent(message)])),
    ).resolves.toEqual([message]);
  });

  it("parses multiple events in one chunk", async () => {
    const first: AnyMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const second: AnyMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s1" },
    };

    await expect(
      collectMessages(
        streamFromChunks([
          serializeSseEvent(first) + serializeSseEvent(second),
        ]),
      ),
    ).resolves.toEqual([first, second]);
  });

  it("parses events split across chunk boundaries", async () => {
    const message: AnyMessage = {
      jsonrpc: "2.0",
      id: "abc",
      result: { ok: true },
    };
    const serialized = serializeSseEvent(message);

    await expect(
      collectMessages(
        streamFromChunks([
          serialized.slice(0, 7),
          serialized.slice(7, 18),
          serialized.slice(18),
        ]),
      ),
    ).resolves.toEqual([message]);
  });

  it("ignores comments, keepalives, and non-data fields", async () => {
    const message: AnyMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };

    await expect(
      collectMessages(
        streamFromChunks([
          `:\n\nevent: message\nid: 1\ndata: ${JSON.stringify(message)}\nretry: 1000\n\n`,
        ]),
      ),
    ).resolves.toEqual([message]);
  });

  it("joins multiline data fields", async () => {
    const expected: AnyMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    };
    const body = [
      'data: {"jsonrpc":"2.0",\n',
      'data: "id":1,\n',
      'data: "result":{"ok":true}}\n\n',
    ];

    await expect(collectMessages(streamFromChunks(body))).resolves.toEqual([
      expected,
    ]);
  });

  it("skips malformed JSON without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const message: AnyMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };

    await expect(
      collectMessages(
        streamFromChunks(["data: {not-json}\n\n", serializeSseEvent(message)]),
      ),
    ).resolves.toEqual([message]);
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });
});
