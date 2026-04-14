import { describe, it, expect } from "vitest";
import { ndJsonStream } from "./stream.js";
import type { AnyMessage } from "./jsonrpc.js";

function readableFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collectMessages(
  readable: ReadableStream<AnyMessage>,
): Promise<AnyMessage[]> {
  const messages: AnyMessage[] = [];
  const reader = readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    messages.push(value);
  }
  return messages;
}

describe("ndJsonStream", () => {
  const nullWritable = new WritableStream<Uint8Array>();

  it("parses a single message", async () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "test" };
    const input = readableFromChunks([
      new TextEncoder().encode(JSON.stringify(msg) + "\n"),
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectMessages(readable);

    expect(messages).toEqual([msg]);
  });

  it("parses multiple messages", async () => {
    const msg1 = { jsonrpc: "2.0" as const, id: 1, method: "first" };
    const msg2 = { jsonrpc: "2.0" as const, id: 2, method: "second" };
    const input = readableFromChunks([
      new TextEncoder().encode(
        JSON.stringify(msg1) + "\n" + JSON.stringify(msg2) + "\n",
      ),
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectMessages(readable);

    expect(messages).toEqual([msg1, msg2]);
  });

  it("parses a message split across chunks", async () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "split" };
    const full = JSON.stringify(msg) + "\n";
    const mid = Math.floor(full.length / 2);
    const encoder = new TextEncoder();

    const input = readableFromChunks([
      encoder.encode(full.slice(0, mid)),
      encoder.encode(full.slice(mid)),
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectMessages(readable);

    expect(messages).toEqual([msg]);
  });

  it("handles multi-byte UTF-8 characters split across chunks", async () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "test",
      params: { text: "héllo wörld" },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(msg) + "\n");

    // Find the byte offset of 'é' (0xC3 0xA9) and split between its two bytes
    const éOffset = bytes.indexOf(0xc3);
    expect(éOffset).toBeGreaterThan(0);

    const input = readableFromChunks([
      bytes.slice(0, éOffset + 1), // includes 0xC3 but not 0xA9
      bytes.slice(éOffset + 1), // starts with 0xA9
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectMessages(readable);

    expect(messages).toEqual([msg]);
  });

  it("parses a final message without trailing newline", async () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "unterminated" };
    const input = readableFromChunks([
      new TextEncoder().encode(JSON.stringify(msg)), // no \n
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectMessages(readable);

    expect(messages).toEqual([msg]);
  });

  it("parses a final message without trailing newline with multi-byte chars split across chunks", async () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tëst",
    };
    const bytes = new TextEncoder().encode(JSON.stringify(msg)); // no \n
    const éOffset = bytes.indexOf(0xc3);
    expect(éOffset).toBeGreaterThan(0);

    const input = readableFromChunks([
      bytes.slice(0, éOffset + 1), // includes 0xC3 but not 0xAB
      bytes.slice(éOffset + 1),
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectMessages(readable);

    expect(messages).toEqual([msg]);
  });

  it("skips malformed lines and continues parsing", async () => {
    const msg1 = { jsonrpc: "2.0" as const, id: 1, method: "before" };
    const msg2 = { jsonrpc: "2.0" as const, id: 2, method: "after" };
    const input = readableFromChunks([
      new TextEncoder().encode(
        JSON.stringify(msg1) +
          "\n" +
          "not valid json\n" +
          JSON.stringify(msg2) +
          "\n",
      ),
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectMessages(readable);

    expect(messages).toEqual([msg1, msg2]);
  });
});
