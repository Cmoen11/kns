// Row heights of the virtual list, in line units (1 unit = one 16px line). A prefix-sum array
// gives O(1) offsets and O(log n) hit-testing for rows of different heights (wrapped or expanded
// lines), and rows can fall off the front in O(1) when the ring buffer drops its head.

export class Heights {
  /** cum[i] = units of all rows before backing index i; one longer than the row count */
  private cum: number[] = [0];
  private start = 0;

  get rows(): number {
    return this.cum.length - 1 - this.start;
  }
  /** total units of all rows */
  get total(): number {
    return this.cum[this.cum.length - 1] - this.cum[this.start];
  }

  push(units: number): void {
    this.cum.push(this.cum[this.cum.length - 1] + units);
  }

  /** Drops `n` rows from the front; returns the units they took. */
  dropFront(n = 1): number {
    const k = Math.min(n, this.rows);
    const units = this.cum[this.start + k] - this.cum[this.start];
    this.start += k;
    if (this.start > 4096 && this.start * 2 > this.cum.length) {
      this.cum = this.cum.slice(this.start);
      this.start = 0;
    }
    return units;
  }

  /** Units above `row` (0 for the first row; total for row === rows). */
  offset(row: number): number {
    const i = this.start + Math.max(0, Math.min(row, this.rows));
    return this.cum[i] - this.cum[this.start];
  }

  units(row: number): number {
    const i = this.start + row;
    return this.cum[i + 1] - this.cum[i];
  }

  /** Changes one row's height; returns the difference in units. O(rows after it). */
  set(row: number, units: number): number {
    if (row < 0 || row >= this.rows) return 0;
    const diff = units - this.units(row);
    if (diff !== 0) for (let i = this.start + row + 1; i < this.cum.length; i++) this.cum[i] += diff;
    return diff;
  }

  /** The row that covers the given unit offset, clamped to the valid rows (-1 when empty). */
  rowAt(unit: number): number {
    const n = this.rows;
    if (n === 0) return -1;
    const target = this.cum[this.start] + Math.max(0, unit);
    // last backing index whose cum <= target
    let lo = this.start;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.cum[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo - this.start, n - 1);
  }

  clear(): void {
    this.cum = [0];
    this.start = 0;
  }
}
