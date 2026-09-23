export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export class MessageTooLargeError extends Error {
  constructor(readonly maxMessageBytes: number) {
    super(
      `Incoming ACP data exceeds the configured ${maxMessageBytes} byte limit`,
    );
    this.name = "MessageTooLargeError";
  }
}

export function resolveMaxMessageBytes(value: number | undefined): number {
  const maxMessageBytes = value ?? DEFAULT_MAX_MESSAGE_BYTES;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new RangeError("maxMessageBytes must be a positive safe integer");
  }
  return maxMessageBytes;
}

export class MessageBuffer {
  #buffer = new Uint8Array(0);
  #length = 0;
  readonly #maxMessageBytes: number;

  constructor(maxMessageBytes: number) {
    this.#maxMessageBytes = resolveMaxMessageBytes(maxMessageBytes);
  }

  get byteLength(): number {
    return this.#length;
  }

  get lastByte(): number | undefined {
    return this.#buffer[this.#length - 1];
  }

  #checkAppend(byteLength: number): void {
    if (byteLength > this.#maxMessageBytes - this.#length) {
      this.clear();
      throw new MessageTooLargeError(this.#maxMessageBytes);
    }
  }

  append(bytes: Uint8Array): void {
    this.#checkAppend(bytes.byteLength);
    const length = this.#length + bytes.byteLength;
    if (length > this.#buffer.byteLength) {
      const capacity = Math.min(
        this.#maxMessageBytes,
        Math.max(length, this.#buffer.byteLength * 2, 1024),
      );
      const buffer = new Uint8Array(capacity);
      buffer.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = buffer;
    }
    this.#buffer.set(bytes, this.#length);
    this.#length = length;
  }

  take(): Uint8Array {
    const bytes = this.#buffer.subarray(0, this.#length);
    this.clear();
    return bytes;
  }

  clear(): void {
    this.#buffer = new Uint8Array(0);
    this.#length = 0;
  }
}
