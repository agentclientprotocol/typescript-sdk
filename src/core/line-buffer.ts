import {
  MessageBuffer,
  MessageTooLargeError,
  resolveMaxMessageBytes,
} from "./stream-limits.js";

const newline = 0x0a;
const carriageReturn = 0x0d;

export interface LineBufferOptions {
  /** Also end lines at a bare CR, as SSE allows. Defaults to false. */
  splitOnCarriageReturn?: boolean;
}

/**
 * Incrementally splits a byte stream into LF- or CRLF-terminated lines, and
 * optionally CR-terminated lines.
 *
 * Only the newly pushed chunk is scanned for line endings, so splitting costs
 * O(total bytes) no matter how many chunks a line spans.
 *
 * Chunks passed to {@link push} must not be mutated while its iterator is
 * in use.
 */
export class LineBuffer {
  /** Bytes of the current (incomplete) line, carried across chunks. */
  readonly #pending: MessageBuffer;
  readonly #maxMessageBytes: number;
  readonly #splitOnCarriageReturn: boolean;
  /** Whether the last line ended at a CR whose LF may start the next chunk. */
  #afterCarriageReturn = false;

  constructor(
    maxMessageBytes?: number,
    { splitOnCarriageReturn = false }: LineBufferOptions = {},
  ) {
    this.#maxMessageBytes = resolveMaxMessageBytes(maxMessageBytes);
    this.#pending = new MessageBuffer(
      Math.min(Number.MAX_SAFE_INTEGER, this.#maxMessageBytes + 1),
    );
    this.#splitOnCarriageReturn = splitOnCarriageReturn;
  }

  /**
   * Consumes a chunk, yielding each complete line without its line ending.
   */
  *push(chunk: Uint8Array): Generator<Uint8Array> {
    let start = 0;
    // A CRLF may be split across chunks, even with empty chunks in between.
    if (this.#afterCarriageReturn && chunk.byteLength > 0) {
      this.#afterCarriageReturn = false;
      if (chunk[0] === newline) {
        start = 1;
      }
    }

    let newlineIndex = chunk.indexOf(newline, start);
    let carriageReturnIndex = this.#splitOnCarriageReturn
      ? chunk.indexOf(carriageReturn, start)
      : -1;
    while (newlineIndex !== -1 || carriageReturnIndex !== -1) {
      if (
        carriageReturnIndex === -1 ||
        (newlineIndex !== -1 && newlineIndex < carriageReturnIndex)
      ) {
        yield this.#takeLine(chunk.subarray(start, newlineIndex));
        start = newlineIndex + 1;
        newlineIndex = chunk.indexOf(newline, start);
      } else {
        yield this.#takeLine(chunk.subarray(start, carriageReturnIndex));
        start = carriageReturnIndex + 1;
        if (start === chunk.byteLength) {
          this.#afterCarriageReturn = true;
        } else if (chunk[start] === newline) {
          start++;
          newlineIndex = chunk.indexOf(newline, start);
        }
        carriageReturnIndex = chunk.indexOf(carriageReturn, start);
      }
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
    this.#afterCarriageReturn = false;
    if (this.#pending.byteLength === 0) {
      return undefined;
    }
    return stripCarriageReturn(this.#pending.take());
  }

  clear(): void {
    this.#afterCarriageReturn = false;
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
      this.#pending.byteLength +
      tail.byteLength -
      (lastByte === carriageReturn ? 1 : 0);
    if (byteLength > this.#maxMessageBytes) {
      this.clear();
      throw new MessageTooLargeError(this.#maxMessageBytes);
    }
  }
}

function stripCarriageReturn(line: Uint8Array): Uint8Array {
  return line[line.byteLength - 1] === carriageReturn
    ? line.subarray(0, -1)
    : line;
}
