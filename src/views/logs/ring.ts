// Fixed-capacity ring buffer with monotonic sequence numbers. Lives outside React: the logs view
// reads it by index. A sequence number identifies an entry for as long as it is in the buffer,
// so cursor, selection and match positions survive the head being dropped.

export class Ring<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;
  private firstSeq = 0;
  readonly cap: number;

  constructor(cap: number) {
    this.cap = Math.max(1, Math.floor(cap));
    this.buf = [];
  }

  get size(): number {
    return this.count;
  }
  /** sequence number of the oldest entry (= nextSeq when empty) */
  get first(): number {
    return this.firstSeq;
  }
  /** sequence number the next push gets */
  get nextSeq(): number {
    return this.firstSeq + this.count;
  }
  get full(): boolean {
    return this.count === this.cap;
  }

  /** Appends; returns the entry that fell off the head, if the buffer was full. */
  push(item: T): T | undefined {
    if (this.count < this.cap) {
      const i = this.head + this.count;
      this.buf[i >= this.cap ? i - this.cap : i] = item;
      this.count++;
      return undefined;
    }
    const dropped = this.buf[this.head];
    this.buf[this.head] = item;
    this.head = this.head + 1 === this.cap ? 0 : this.head + 1;
    this.firstSeq++;
    return dropped;
  }

  /** Entry by position, 0 = oldest. */
  at(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined;
    const i = this.head + index;
    return this.buf[i >= this.cap ? i - this.cap : i];
  }

  /** Entry by sequence number; undefined when it was dropped or not written yet. */
  get(seq: number): T | undefined {
    return this.at(seq - this.firstSeq);
  }

  /** Empties the buffer. Sequence numbers keep counting, so old ones never come back. */
  clear(): void {
    this.firstSeq += this.count;
    this.buf = [];
    this.head = 0;
    this.count = 0;
  }

  forEach(fn: (item: T, seq: number) => void): void {
    for (let i = 0; i < this.count; i++) fn(this.at(i) as T, this.firstSeq + i);
  }
}

/**
 * An ascending list of sequence numbers that loses entries from the front (hits, filtered rows).
 * Dropping from the front is O(1); the backing array is compacted now and then.
 */
export class SeqList {
  private arr: number[] = [];
  private start = 0;

  get length(): number {
    return this.arr.length - this.start;
  }
  at(i: number): number {
    return this.arr[this.start + i];
  }
  push(seq: number): void {
    this.arr.push(seq);
  }
  first(): number | undefined {
    return this.arr[this.start];
  }
  last(): number | undefined {
    return this.length > 0 ? this.arr[this.arr.length - 1] : undefined;
  }
  shift(): void {
    if (this.start >= this.arr.length) return;
    this.start++;
    if (this.start > 4096 && this.start * 2 > this.arr.length) {
      this.arr = this.arr.slice(this.start);
      this.start = 0;
    }
  }
  clear(): void {
    this.arr = [];
    this.start = 0;
  }
  /** Index of the first entry >= seq (length when there is none). */
  lowerBound(seq: number): number {
    let lo = this.start;
    let hi = this.arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.arr[mid] < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo - this.start;
  }
  has(seq: number): boolean {
    const i = this.lowerBound(seq);
    return i < this.length && this.at(i) === seq;
  }
}
