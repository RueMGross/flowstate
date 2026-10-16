// Streaming PNG writer for images too large for one canvas (rows added top to bottom, deflated as they come).
import { Zlib } from 'fflate';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}

/** A PNG chunk (length, type, data, CRC of type + data). */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** pHYs chunk: the physical resolution, so image editors and journals see the intended size. */
export function physChunk(dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const d = new Uint8Array(9);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, ppm);
  dv.setUint32(4, ppm);
  d[8] = 1; // metre
  return pngChunk('pHYs', d);
}

export class PngWriter {
  private parts: Uint8Array[] = [];
  private z: Zlib;
  private rows = 0;
  private readonly rowBytes: number;

  constructor(
    width: number,
    private height: number,
    private channels: 3 | 4,
    dpi: number,
  ) {
    this.rowBytes = width * channels;
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = channels === 4 ? 6 : 2; // RGBA / RGB
    this.parts.push(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), physChunk(dpi));
    this.z = new Zlib({ level: 6 });
    this.z.ondata = (chunk) => {
      if (chunk.length) this.parts.push(pngChunk('IDAT', chunk));
    };
  }

  /** Add `rows` rows of interleaved RGB / RGBA bytes. */
  addRows(data: Uint8Array, rows: number) {
    // 'Sub' filter: neighbouring pixels of figures are mostly equal, which deflates far better than raw bytes
    const n = this.channels;
    const block = new Uint8Array(rows * (this.rowBytes + 1));
    for (let r = 0; r < rows; r++) {
      const src = r * this.rowBytes;
      const dst = r * (this.rowBytes + 1);
      block[dst] = 1;
      for (let i = 0; i < this.rowBytes; i++) block[dst + 1 + i] = (data[src + i] - (i >= n ? data[src + i - n] : 0)) & 0xff;
    }
    this.rows += rows;
    this.z.push(block, false);
  }

  finish(): Blob {
    if (this.rows !== this.height) throw new Error(`PNG: ${this.rows} of ${this.height} rows written`);
    this.z.push(new Uint8Array(0), true);
    this.parts.push(pngChunk('IEND', new Uint8Array(0)));
    return new Blob(this.parts as BlobPart[], { type: 'image/png' });
  }
}
