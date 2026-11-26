// UTF-8 bytes from a socket to strings. The mod runtime (QuickJS) has no TextDecoder, and a
// read can end in the middle of a character: the incomplete tail waits for the next chunk.

export class Utf8Stream {
  constructor() {
    this.carry = null;
  }

  /** Decodes `bytes` (a Uint8Array) after whatever the previous chunk left over. */
  push(bytes) {
    let all = bytes;
    if (this.carry) {
      all = new Uint8Array(this.carry.length + bytes.length);
      all.set(this.carry);
      all.set(bytes, this.carry.length);
      this.carry = null;
    }
    let end = all.length;
    // step back over continuation bytes to the start of the last sequence
    let i = end - 1, back = 0;
    while (i >= 0 && back < 3 && (all[i] & 0xc0) === 0x80) { i--; back++; }
    if (i >= 0) {
      const b = all[i];
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (need > end - i) end = i;
    }
    if (end < all.length) this.carry = all.slice(end);
    return decode(all, end);
  }
}

/** Decodes `a[0..end)`; ASCII runs (almost all of kns's JSON) go through fromCharCode in slices. */
export function decode(a, end = a.length) {
  const parts = [];
  let i = 0;
  while (i < end) {
    let j = i;
    while (j < end && a[j] < 0x80) j++;
    for (let k = i; k < j; k += 8192) parts.push(String.fromCharCode.apply(null, a.subarray(k, Math.min(j, k + 8192))));
    i = j;
    if (i >= end) break;
    const b = a[i];
    let n, cp;
    if (b >= 0xf0) { n = 4; cp = b & 0x07; }
    else if (b >= 0xe0) { n = 3; cp = b & 0x0f; }
    else if (b >= 0xc0) { n = 2; cp = b & 0x1f; }
    else { parts.push("�"); i++; continue; }
    if (i + n > end) { parts.push("�"); break; }
    for (let k = 1; k < n; k++) cp = (cp << 6) | (a[i + k] & 0x3f);
    parts.push(String.fromCodePoint(cp));
    i += n;
  }
  return parts.join("");
}
