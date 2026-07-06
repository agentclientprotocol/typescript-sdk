import { describe, it, expect, vi } from "vitest";
import { ndJsonStream } from "./stream.js";
import {
  chunkBytes,
  collectStream,
  streamFromChunks,
} from "./test-support/streams.js";

describe("ndJsonStream", () => {
  const nullWritable = new WritableStream<Uint8Array>();

  it("parses a single message", async () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "test" };
    const input = streamFromChunks([JSON.stringify(msg) + "\n"]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg]);
  });

  it("parses multiple messages", async () => {
    const msg1 = { jsonrpc: "2.0" as const, id: 1, method: "first" };
    const msg2 = { jsonrpc: "2.0" as const, id: 2, method: "second" };
    const input = streamFromChunks([
      JSON.stringify(msg1) + "\n" + JSON.stringify(msg2) + "\n",
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg1, msg2]);
  });

  it("parses a message split across chunks", async () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "split" };
    const full = JSON.stringify(msg) + "\n";
    const mid = Math.floor(full.length / 2);

    const input = streamFromChunks([full.slice(0, mid), full.slice(mid)]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg]);
  });

  it("parses a large message spanning many chunks", async () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "large",
      params: { data: "héllo wörld ".repeat(10_000) },
    };
    const chunks = chunkBytes(JSON.stringify(msg) + "\n", 1024);
    expect(chunks.length).toBeGreaterThan(100);

    const { readable } = ndJsonStream(nullWritable, streamFromChunks(chunks));
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg]);
  });

  it("parses messages when chunk boundaries fall mid-message", async () => {
    const msg1 = { jsonrpc: "2.0" as const, id: 1, method: "first" };
    const msg2 = { jsonrpc: "2.0" as const, id: 2, method: "second" };
    const msg3 = { jsonrpc: "2.0" as const, id: 3, method: "third" };
    const full = [msg1, msg2, msg3]
      .map((m) => JSON.stringify(m) + "\n")
      .join("");

    // One chunk ends with a complete message plus the start of the next.
    const cut = full.indexOf('"second"');
    const input = streamFromChunks([full.slice(0, cut), full.slice(cut)]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg1, msg2, msg3]);
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

    const input = streamFromChunks([
      bytes.slice(0, éOffset + 1), // includes 0xC3 but not 0xA9
      bytes.slice(éOffset + 1), // starts with 0xA9
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg]);
  });

  it("parses a final message without trailing newline", async () => {
    const msg = { jsonrpc: "2.0" as const, id: 1, method: "unterminated" };
    const input = streamFromChunks([JSON.stringify(msg)]); // no \n

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

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

    const input = streamFromChunks([
      bytes.slice(0, éOffset + 1), // includes 0xC3 but not 0xAB
      bytes.slice(éOffset + 1),
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg]);
  });

  it("skips malformed lines and continues parsing", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const msg1 = { jsonrpc: "2.0" as const, id: 1, method: "before" };
    const msg2 = { jsonrpc: "2.0" as const, id: 2, method: "after" };
    const input = streamFromChunks([
      JSON.stringify(msg1) +
        "\n" +
        "not valid json\n" +
        JSON.stringify(msg2) +
        "\n",
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg1, msg2]);
    expect(error).toHaveBeenCalledOnce();

    error.mockRestore();
  });

  it("skips non-object JSON lines that would break the connection layer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const msg1 = { jsonrpc: "2.0" as const, id: 1, method: "before" };
    const msg2 = { jsonrpc: "2.0" as const, id: 2, method: "after" };
    const input = streamFromChunks([
      JSON.stringify(msg1) +
        "\n" +
        '42\n"str"\nnull\n' +
        JSON.stringify(msg2) +
        "\n",
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([msg1, msg2]);
    expect(warn).toHaveBeenCalledTimes(3);

    warn.mockRestore();
  });

  it("passes through object messages without validating their shape", async () => {
    // Lenient peers may omit the jsonrpc field or send unusual response
    // shapes; the connection layer decides how to handle them.
    const lenient = { id: 1, method: "initialize", params: {} };
    const bothMembers = {
      jsonrpc: "2.0" as const,
      id: 2,
      result: {},
      error: null,
    };
    const input = streamFromChunks([
      JSON.stringify(lenient) + "\n" + JSON.stringify(bothMembers) + "\n",
    ]);

    const { readable } = ndJsonStream(nullWritable, input);
    const messages = await collectStream(readable);

    expect(messages).toEqual([lenient, bothMembers]);
  });

  it("cancels the underlying input reader when canceled", async () => {
    const { promise: canceled, resolve: resolveCanceled } =
      Promise.withResolvers<unknown>();
    const input = new ReadableStream<Uint8Array>({
      cancel(reason) {
        resolveCanceled(reason);
      },
    });
    const reason = new Error("connection closed");
    const { readable } = ndJsonStream(nullWritable, input);
    const reader = readable.getReader();

    await reader.cancel(reason);
    reader.releaseLock();

    await expect(canceled).resolves.toBe(reason);
    await vi.waitFor(() => {
      const inputReader = input.getReader();
      inputReader.releaseLock();
    });
  });
});
