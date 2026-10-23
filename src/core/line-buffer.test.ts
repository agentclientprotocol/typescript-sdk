import { describe, it, expect } from "vitest";
import { LineBuffer } from "./line-buffer.js";
import { MessageTooLargeError } from "./stream-limits.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function pushAll(buffer: LineBuffer, chunks: string[]): string[] {
  const lines: string[] = [];
  for (const chunk of chunks) {
    for (const line of buffer.push(encoder.encode(chunk))) {
      lines.push(decoder.decode(line));
    }
  }
  return lines;
}

describe("LineBuffer", () => {
  it("splits complete lines within one chunk", () => {
    const buffer = new LineBuffer();

    expect(pushAll(buffer, ["a\nbb\nccc\n"])).toEqual(["a", "bb", "ccc"]);
    expect(buffer.flush()).toBeUndefined();
  });

  it("carries an incomplete line across chunks", () => {
    const buffer = new LineBuffer();

    expect(pushAll(buffer, ["ab", "cd ef", "gh\nnext"])).toEqual(["abcd efgh"]);
    expect(decoder.decode(buffer.flush())).toBe("next");
  });

  it("handles a newline at a chunk boundary", () => {
    const buffer = new LineBuffer();

    expect(pushAll(buffer, ["one", "\ntwo\n"])).toEqual(["one", "two"]);
    expect(buffer.flush()).toBeUndefined();
  });

  it("yields empty lines", () => {
    const buffer = new LineBuffer();

    expect(pushAll(buffer, ["a\n\nb\n"])).toEqual(["a", "", "b"]);
  });

  it("flushes a trailing unterminated line once", () => {
    const buffer = new LineBuffer();

    expect(pushAll(buffer, ["tail"])).toEqual([]);
    expect(decoder.decode(buffer.flush())).toBe("tail");
    expect(buffer.flush()).toBeUndefined();
  });

  it("handles empty chunks", () => {
    const buffer = new LineBuffer();

    expect(pushAll(buffer, ["", "a", "", "\n"])).toEqual(["a"]);
  });

  it("keeps a bare CR inside a line by default", () => {
    const buffer = new LineBuffer();

    expect(pushAll(buffer, ["a\rb\r\n", "c\r", "\n"])).toEqual(["a\rb", "c"]);
  });

  describe("with splitOnCarriageReturn", () => {
    it("splits at CR, LF, and CRLF", () => {
      const buffer = new LineBuffer(undefined, { splitOnCarriageReturn: true });

      expect(pushAll(buffer, ["a\rb\nc\r\nd\n\re\r\r\nf"])).toEqual([
        "a",
        "b",
        "c",
        "d",
        "",
        "e",
        "",
      ]);
      expect(decoder.decode(buffer.flush())).toBe("f");
    });

    it("joins a CRLF split across chunks", () => {
      const buffer = new LineBuffer(undefined, { splitOnCarriageReturn: true });

      expect(
        pushAll(buffer, ["a\r", "\nb\r", "", "\nc\r", "\r\nd\r", "e", "\n"]),
      ).toEqual(["a", "b", "c", "", "d", "e"]);
      expect(buffer.flush()).toBeUndefined();
    });

    it("applies the line limit without counting the line ending", () => {
      const buffer = new LineBuffer(3, { splitOnCarriageReturn: true });

      expect(pushAll(buffer, ["abc\r", "\nde", "f\r"])).toEqual(["abc", "def"]);
      expect(() => pushAll(buffer, ["abcd\r"])).toThrow(MessageTooLargeError);
    });
  });
});
