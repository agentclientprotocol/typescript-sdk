import {
  MessageBuffer,
  MessageTooLargeError,
  resolveMaxMessageBytes,
} from "./stream-limits.js";

const newline = 0x0a;

/**
 * Incrementally splits a byte stream into newline-terminated lines.
 *
 * Only the newly pushed chunk is scanned for newlines, so splitting costs
 * O(total bytes) no matter how many chunks a line spans.
 *
 * Chunks passed to {@link push} must not be mutated while its iterator is
 * in use.
 */
export class LineBuffer {
  /** Bytes of the current (incomplete) line, carried across chunks. */
  readonly #pending: MessageBuffer;
  readonly #maxMessageBytes: number;

  constructor(maxMessageBytes?: number) {
    this.#maxMessageBytes = resolveMaxMessageBytes(maxMessageBytes);
    this.#pending = new MessageBuffer(
      Math.min(Number.MAX_SAFE_INTEGER, this.#maxMessageBytes + 1),
    );
  }

  /**
   * Consumes a chunk, yielding each complete line without its trailing
   * LF or CRLF.
   */
  *push(chunk: Uint8Array): Generator<Uint8Array> {
    let start = 0;
    let newlineIndex = chunk.indexOf(newline, start);
    while (newlineIndex !== -1) {
      yield this.#takeLine(chunk.subarray(start, newlineIndex));
      start = newlineIndex + 1;
      newlineIndex = chunk.indexOf(newline, start);
    }
    if (start < chunk.byteLength) {
      const tail = chunk.subarray(start);
      this.#checkLine(tail);
      this.#pending.append(tail);
    }
  }

  /**
   * Returns the trailing unterminated line and resets the buffer, or
   * undefined if no bytes are buffered.
   */
  flush(): Uint8Array | undefined {
    if (this.#pending.byteLength === 0) {
      return undefined;
    }
    return stripCarriageReturn(this.#pending.take());
  }

  clear(): void {
    this.#pending.clear();
  }

  #takeLine(tail: Uint8Array): Uint8Array {
    this.#checkLine(tail);
    if (this.#pending.byteLength === 0) {
      return stripCarriageReturn(tail);
    }
    this.#pending.append(tail);
    return stripCarriageReturn(this.#pending.take());
  }

  #checkLine(tail: Uint8Array): void {
    const lastByte =
      tail.byteLength > 0 ? tail[tail.byteLength - 1] : this.#pending.lastByte;
    const byteLength =
      this.#pending.byteLength + tail.byteLength - (lastByte === 0x0d ? 1 : 0);
    if (byteLength > this.#maxMessageBytes) {
      this.clear();
      throw new MessageTooLargeError(this.#maxMessageBytes);
    }
  }
}

function stripCarriageReturn(line: Uint8Array): Uint8Array {
  return line[line.byteLength - 1] === 0x0d ? line.subarray(0, -1) : line;
}
