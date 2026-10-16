// Baseline TIFF writer for figure export: 8-bit RGB (or RGBA with unassociated alpha), LZW-compressed strips,
// resolution tags in dots per inch. Rows are added top to bottom, so very large images never need one big buffer.

/** Codes of TIFF LZW (Adobe TIFF 6.0, section 13): MSB-first bit order, 9 to 12 bit codes. */
const CLEAR = 256;
const EOI = 257;
const FIRST = 258;
const MAX_CODE = 4095;

let tabStamp: Int32Array | null = null;
let tabCode: Uint16Array | null = null;
let gen = 0;

/**
 * LZW-compress one strip the way libtiff does (and every TIFF reader expects): a Clear code first, the code width grows
 * when the next free code no longer fits, the table is reset (Clear) before it holds 4094 entries, EOI at the end.
 */
export function lzwEncode(data: Uint8Array): Uint8Array {
  if (!tabStamp || !tabCode) {
    tabStamp = new Int32Array(1 << 20);
    tabCode = new Uint16Array(1 << 20);
  }
  const stamp = tabStamp;
  const codes = tabCode;
  let out = new Uint8Array(Math.max(64, (data.length >> 1) + 64));
  let op = 0;
  let acc = 0; // pending bits (right-aligned)
  let nacc = 0;
  let width = 9;
  let next = FIRST;
  const put = (code: number) => {
    acc = (acc << width) | code;
    nacc += width;
    while (nacc >= 8) {
      nacc -= 8;
      if (op >= out.length) {
        const bigger = new Uint8Array(out.length * 2);
        bigger.set(out);
        out = bigger;
      }
      out[op++] = (acc >>> nacc) & 0xff;
    }
    acc &= (1 << nacc) - 1;
  };
  const reset = () => {
    gen++;
    if (gen > 0x7ffffff0) {
      stamp.fill(0);
      gen = 1;
    }
    next = FIRST;
  };
  reset();
  put(CLEAR);
  if (!data.length) {
    put(EOI);
  } else {
    let prefix = data[0];
    for (let i = 1; i < data.length; i++) {
      const c = data[i];
      const key = (prefix << 8) | c;
      if (stamp[key] === gen) {
        prefix = codes[key];
        continue;
      }
      put(prefix);
      stamp[key] = gen;
      codes[key] = next++;
      prefix = c;
      if (next === MAX_CODE - 1) {
        put(CLEAR);
        reset();
        width = 9;
      } else if (next > (1 << width) - 1) width++;
    }
    put(prefix);
    // the reader adds one more entry after this code: follow its width change before EOI
    next++;
    if (next === MAX_CODE - 1) {
      put(CLEAR);
      width = 9;
    } else if (next > (1 << width) - 1) width++;
    put(EOI);
  }
  if (nacc > 0) {
    if (op >= out.length) {
      const bigger = new Uint8Array(out.length + 8);
      bigger.set(out);
      out = bigger;
    }
    out[op++] = (acc << (8 - nacc)) & 0xff;
  }
  return out.slice(0, op);
}

/** Decoder for tests and self-checks (the inverse of lzwEncode, following libtiff's reader). */
export function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let op = 0;
  const prefixOf = new Int32Array(4096);
  const suffixOf = new Uint8Array(4096);
  const lenOf = new Int32Array(4096);
  for (let i = 0; i < 256; i++) {
    prefixOf[i] = -1;
    suffixOf[i] = i;
    lenOf[i] = 1;
  }
  let bitPos = 0;
  let width = 9;
  let next = FIRST;
  let old = -1;
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = src[(bitPos >> 3)] ?? 0;
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  const firstByte = (code: number) => {
    while (prefixOf[code] >= 0) code = prefixOf[code];
    return suffixOf[code];
  };
  const emit = (code: number) => {
    const n = lenOf[code];
    let p = op + n - 1;
    let c = code;
    while (c >= 0) {
      if (p < expected) out[p] = suffixOf[c];
      p--;
      c = prefixOf[c];
    }
    op += n;
  };
  while (bitPos + width <= src.length * 8) {
    const code = read();
    if (code === EOI) break;
    if (code === CLEAR) {
      width = 9;
      next = FIRST;
      old = -1;
      continue;
    }
    if (old < 0) {
      emit(code);
      old = code;
      continue;
    }
    if (code < next) {
      emit(code);
      prefixOf[next] = old;
      suffixOf[next] = firstByte(code);
    } else {
      prefixOf[next] = old;
      suffixOf[next] = firstByte(old);
      lenOf[next] = lenOf[old] + 1;
      emit(next);
    }
    lenOf[next] = lenOf[old] + 1;
    next++;
    if (next > (1 << width) - 2 && width < 12) width++;
    old = code;
  }
  return out;
}

export interface TiffOptions {
  width: number;
  height: number;
  /** 3: RGB, 4: RGB + unassociated alpha */
  channels: 3 | 4;
  dpi: number;
  compression?: 'lzw' | 'none';
  software?: string;
}

/** Streaming TIFF writer: addRows() top to bottom (interleaved RGB / RGBA bytes), then finish(). */
export class TiffWriter {
  readonly rowBytes: number;
  readonly rowsPerStrip: number;
  private pending: Uint8Array;
  private pendingRows = 0;
  private rowsDone = 0;
  private parts: Uint8Array[] = [];
  private offset = 8;
  private stripOffsets: number[] = [];
  private stripCounts: number[] = [];

  constructor(private o: TiffOptions) {
    this.rowBytes = o.width * o.channels;
    // strips of about 128 kB of pixels (readers prefer many moderate strips to one huge one)
    this.rowsPerStrip = Math.max(1, Math.min(o.height, Math.floor((1 << 17) / this.rowBytes)));
    this.pending = new Uint8Array(this.rowsPerStrip * this.rowBytes);
  }

  /** Add `rows` rows (rows * width * channels bytes). */
  addRows(data: Uint8Array, rows: number) {
    let src = 0;
    for (let r = 0; r < rows; r++) {
      this.pending.set(data.subarray(src, src + this.rowBytes), this.pendingRows * this.rowBytes);
      src += this.rowBytes;
      this.pendingRows++;
      this.rowsDone++;
      if (this.pendingRows === this.rowsPerStrip) this.flush();
    }
  }

  private flush() {
    if (!this.pendingRows) return;
    const raw = this.pending.subarray(0, this.pendingRows * this.rowBytes);
    const strip = this.o.compression === 'none' ? raw.slice() : lzwEncode(raw);
    this.stripOffsets.push(this.offset);
    this.stripCounts.push(strip.length);
    this.parts.push(strip);
    this.offset += strip.length;
    if (strip.length & 1) {
      // keep the next strip word-aligned
      this.parts.push(new Uint8Array(1));
      this.offset += 1;
    }
    this.pendingRows = 0;
  }

  /** The finished file (header, strips, then the image file directory). */
  finish(): Blob {
    if (this.rowsDone !== this.o.height) throw new Error(`TIFF: ${this.rowsDone} of ${this.o.height} rows written`);
    this.flush();
    const { width, height, channels, dpi } = this.o;
    const n = this.stripOffsets.length;
    const software = (this.o.software ?? 'FlowState') + '\0';
    type Entry = { tag: number; type: 3 | 4 | 5 | 2; count: number; values: number[] | string };
    const res = Math.round(dpi * 100);
    const entries: Entry[] = [
      { tag: 256, type: 4, count: 1, values: [width] },
      { tag: 257, type: 4, count: 1, values: [height] },
      { tag: 258, type: 3, count: channels, values: new Array(channels).fill(8) },
      { tag: 259, type: 3, count: 1, values: [this.o.compression === 'none' ? 1 : 5] },
      { tag: 262, type: 3, count: 1, values: [2] }, // RGB
      { tag: 273, type: 4, count: n, values: this.stripOffsets },
      { tag: 277, type: 3, count: 1, values: [channels] },
      { tag: 278, type: 4, count: 1, values: [this.rowsPerStrip] },
      { tag: 279, type: 4, count: n, values: this.stripCounts },
      { tag: 282, type: 5, count: 1, values: [res, 100] },
      { tag: 283, type: 5, count: 1, values: [res, 100] },
      { tag: 284, type: 3, count: 1, values: [1] }, // chunky
      { tag: 296, type: 3, count: 1, values: [2] }, // inch
      { tag: 305, type: 2, count: software.length, values: software },
    ];
    if (channels === 4) entries.push({ tag: 338, type: 3, count: 1, values: [2] }); // unassociated alpha
    const size = (e: Entry) => (e.type === 3 ? 2 : e.type === 5 ? 8 : e.type === 2 ? 1 : 4) * e.count;
    const ifdOffset = this.offset + (this.offset & 1);
    const ifdSize = 2 + entries.length * 12 + 4;
    let extra = ifdOffset + ifdSize; // out-of-line values follow the directory
    const extras: { at: number; e: Entry }[] = [];
    for (const e of entries) {
      if (size(e) > 4) {
        extras.push({ at: extra, e });
        extra += size(e) + (size(e) & 1);
      }
    }
    const tail = new Uint8Array(extra - this.offset);
    const dv = new DataView(tail.buffer);
    const base = this.offset;
    const writeVals = (pos: number, e: Entry) => {
      if (e.type === 2) {
        const s = e.values as string;
        for (let i = 0; i < s.length; i++) tail[pos - base + i] = s.charCodeAt(i) & 0x7f;
        return;
      }
      const v = e.values as number[];
      for (let i = 0; i < v.length; i++) {
        if (e.type === 3) dv.setUint16(pos - base + i * 2, v[i], true);
        else dv.setUint32(pos - base + i * 4, v[i] >>> 0, true);
      }
    };
    let p = ifdOffset - base;
    dv.setUint16(p, entries.length, true);
    p += 2;
    for (const e of entries) {
      dv.setUint16(p, e.tag, true);
      dv.setUint16(p + 2, e.type, true);
      dv.setUint32(p + 4, e.count, true);
      const ex = extras.find((x) => x.e === e);
      if (ex) dv.setUint32(p + 8, ex.at, true);
      else writeVals(base + p + 8, e);
      p += 12;
    }
    dv.setUint32(p, 0, true); // no next directory
    for (const x of extras) writeVals(x.at, x.e);
    const head = new Uint8Array(8);
    head.set([0x49, 0x49, 42, 0]); // "II*\0": little endian
    new DataView(head.buffer).setUint32(4, ifdOffset, true);
    return new Blob([head, ...this.parts, tail] as BlobPart[], { type: 'image/tiff' });
  }
}

/** Encode a whole RGBA image (e.g. canvas ImageData) as TIFF; alpha is kept only with `keepAlpha`, else flattened on white. */
export function encodeTiff(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, dpi: number, keepAlpha = false): Blob {
  const ch = keepAlpha ? 4 : 3;
  const w = new TiffWriter({ width, height, channels: ch, dpi });
  const row = new Uint8Array(width * ch);
  for (let y = 0; y < height; y++) {
    rgbaRow(rgba, y * width * 4, width, row, ch);
    w.addRows(row, 1);
  }
  return w.finish();
}

/** One row of RGBA pixels as RGB (flattened on white) or RGBA. */
export function rgbaRow(src: Uint8ClampedArray | Uint8Array, at: number, width: number, out: Uint8Array, channels: 3 | 4) {
  if (channels === 4) {
    out.set(src.subarray(at, at + width * 4));
    return;
  }
  for (let x = 0, i = at, o = 0; x < width; x++, i += 4, o += 3) {
    const a = src[i + 3];
    if (a === 255) {
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
    } else {
      const k = a / 255;
      out[o] = Math.round(src[i] * k + 255 * (1 - k));
      out[o + 1] = Math.round(src[i + 1] * k + 255 * (1 - k));
      out[o + 2] = Math.round(src[i + 2] * k + 255 * (1 - k));
    }
  }
}
