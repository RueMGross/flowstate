// Fast numeric sorting of Float32Array values: an LSD radix sort (3 passes of 11 bits) on the float bit patterns.
// The result is identical to Float32Array.prototype.sort (ascending, -0 before +0); arrays holding NaN use the built-in
// sort (it puts NaN last). About 5-10x faster than the built-in sort for the 10^4-10^6 values of a population.

const RADIX_MIN = 2048; // below this the built-in sort is as fast

let scratch: Uint32Array | null = null;

function tmpOf(n: number): Uint32Array {
  // one scratch buffer, reused (sorts run one at a time on a thread); large ones are not kept
  if (scratch && scratch.length >= n) return scratch;
  const t = new Uint32Array(n);
  if (n <= 1 << 21) scratch = t;
  return t;
}

/** Sort `a` in place (ascending, as a.sort()) and return it. */
export function sortFloat32(a: Float32Array): Float32Array {
  const n = a.length;
  if (n < RADIX_MIN) return a.sort();
  const u = new Uint32Array(a.buffer, a.byteOffset, n);
  // keys: flip negative floats (all bits) and set the sign bit of positive ones: unsigned order = numeric order
  const c0 = new Uint32Array(2048);
  const c1 = new Uint32Array(2048);
  const c2 = new Uint32Array(1024);
  for (let i = 0; i < n; i++) {
    const b = u[i];
    // NaN: exponent all ones and a mantissa
    if ((b & 0x7f800000) === 0x7f800000 && (b & 0x007fffff) !== 0) {
      // undo the keys written so far and fall back
      for (let j = 0; j < i; j++) u[j] = u[j] & 0x80000000 ? u[j] ^ 0x80000000 : ~u[j] >>> 0;
      return a.sort();
    }
    const k = b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0;
    u[i] = k;
    c0[k & 2047]++;
    c1[(k >>> 11) & 2047]++;
    c2[k >>> 22]++;
  }
  const t = tmpOf(n);
  // exclusive prefix sums
  let s0 = 0,
    s1 = 0,
    s2 = 0;
  for (let d = 0; d < 2048; d++) {
    const x0 = c0[d];
    c0[d] = s0;
    s0 += x0;
    const x1 = c1[d];
    c1[d] = s1;
    s1 += x1;
    if (d < 1024) {
      const x2 = c2[d];
      c2[d] = s2;
      s2 += x2;
    }
  }
  for (let i = 0; i < n; i++) {
    const k = u[i];
    t[c0[k & 2047]++] = k;
  }
  for (let i = 0; i < n; i++) {
    const k = t[i];
    u[c1[(k >>> 11) & 2047]++] = k;
  }
  for (let i = 0; i < n; i++) {
    const k = u[i];
    t[c2[k >>> 22]++] = k;
  }
  // back to float bit patterns
  for (let i = 0; i < n; i++) {
    const k = t[i];
    u[i] = k & 0x80000000 ? k ^ 0x80000000 : ~k >>> 0;
  }
  return a;
}

/** A sorted copy of the values (as Float32Array.from(a).sort()). */
export function sortedCopy(a: Float32Array): Float32Array {
  return sortFloat32(Float32Array.from(a));
}
