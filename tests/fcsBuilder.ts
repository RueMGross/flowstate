// Builds small synthetic FCS files for reader tests: any version, per-parameter data types (FCS 3.2), byte order,
// wrong HEADER / TEXT DATA offsets, several data sets per file. Not a test file itself (see fcs_reader.test.ts).

export interface Par {
  name: string;
  /** data type of this parameter: written as $PnDATATYPE when it differs from $DATATYPE (or `pnDatatype` is set) */
  type?: 'I' | 'F' | 'D';
  bits?: number;
  range?: number | string;
  e?: string;
  s?: string;
  g?: string;
}

export interface BuildOpts {
  version?: string; // 'FCS3.1'
  datatype?: 'I' | 'F' | 'D';
  big?: boolean; // big-endian ($BYTEORD 4,3,2,1)
  pars: Par[];
  data: number[][]; // [parameter][event]
  kw?: Record<string, string>;
  /** write $PnDATATYPE for every parameter */
  pnDatatype?: boolean;
  /** $BEGINDATA/$ENDDATA = real + shift (a stale TEXT offset) */
  textShift?: number;
  /** HEADER DATA offsets = real + shift */
  headerShift?: number;
  /** $BEGINDATA (only) set to this absolute value, e.g. inside TEXT */
  textBegin?: number;
  /** HEADER DATA start (only) set to this value */
  headerBegin?: number;
  /** HEADER DATA end set to this value */
  headerEnd?: number;
  /** $ENDDATA and HEADER end one past the last data byte (a common writer bug) */
  endPastLast?: boolean;
  /** bytes between TEXT and DATA */
  gap?: number;
  /** bytes after DATA */
  tail?: number;
  /** omit $BEGINDATA / $ENDDATA from TEXT (FCS 2.0) */
  noTextOffsets?: boolean;
  nextData?: number;
}

const pad = (n: number, w = 10) => String(n).padStart(w, '0');

function typeOf(o: BuildOpts, p: Par): 'I' | 'F' | 'D' {
  return p.type ?? o.datatype ?? 'F';
}

function bytesOf(o: BuildOpts, p: Par): number {
  const t = typeOf(o, p);
  return t === 'F' ? 4 : t === 'D' ? 8 : Math.ceil((p.bits ?? 16) / 8);
}

function textOf(o: BuildOpts, begin: number, end: number, next: number): string {
  const dt = o.datatype ?? 'F';
  const nEv = o.data[0]?.length ?? 0;
  const kw: [string, string][] = [
    ['$BEGINANALYSIS', '0'],
    ['$ENDANALYSIS', '0'],
    ['$BEGINSTEXT', '0'],
    ['$ENDSTEXT', '0'],
  ];
  if (!o.noTextOffsets) kw.push(['$BEGINDATA', pad(begin)], ['$ENDDATA', pad(end)]);
  kw.push(['$BYTEORD', o.big ? '4,3,2,1' : '1,2,3,4'], ['$DATATYPE', dt], ['$MODE', 'L'], ['$NEXTDATA', pad(next)], ['$PAR', String(o.pars.length)], ['$TOT', String(nEv)]);
  o.pars.forEach((p, i) => {
    const n = i + 1;
    const t = typeOf(o, p);
    kw.push([`$P${n}N`, p.name], [`$P${n}B`, String(t === 'F' ? 32 : t === 'D' ? 64 : p.bits ?? 16)], [`$P${n}E`, p.e ?? '0,0'], [`$P${n}R`, String(p.range ?? 1024)]);
    if (p.s !== undefined) kw.push([`$P${n}S`, p.s]);
    if (p.g !== undefined) kw.push([`$P${n}G`, p.g]);
    if (o.pnDatatype || (p.type && p.type !== dt)) kw.push([`$P${n}DATATYPE`, t]);
  });
  for (const [k, v] of Object.entries(o.kw ?? {})) kw.push([k, v]);
  return '/' + kw.map(([k, v]) => `${k}/${v.replace(/\//g, '//')}`).join('/') + '/';
}

/** One data set (HEADER + TEXT + DATA); offsets relative to its own start. */
export function buildFcs(o: BuildOpts): Uint8Array {
  const version = o.version ?? 'FCS3.1';
  const nEv = o.data[0]?.length ?? 0;
  const row = o.pars.reduce((a, p) => a + bytesOf(o, p), 0);
  const dataLen = row * nEv;
  const textStart = 58;
  const textLen = textOf(o, 0, 0, 0).length; // fixed-width numbers: the length does not depend on the values
  const dataStart = textStart + textLen + (o.gap ?? 0);
  const dataEnd = dataStart + dataLen - 1 + (o.endPastLast ? 1 : 0);
  const tBegin = o.textBegin ?? dataStart + (o.textShift ?? 0);
  const tEnd = dataEnd + (o.textShift ?? 0);
  const text = textOf(o, tBegin, tEnd, o.nextData ?? 0);
  if (text.length !== textLen) throw new Error('TEXT length changed');
  const total = dataStart + dataLen + (o.tail ?? 0);
  const out = new Uint8Array(total);
  out.fill(32, 0, textStart);
  const put = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  put(version, 0);
  const off8 = (n: number) => String(n).padStart(8, ' ');
  put(off8(textStart), 10);
  put(off8(textStart + textLen - 1), 18);
  put(off8(o.headerBegin ?? dataStart + (o.headerShift ?? 0)), 26);
  put(off8(o.headerEnd ?? dataEnd + (o.headerShift ?? 0)), 34);
  put(off8(0), 42);
  put(off8(0), 50);
  put(text, textStart);
  const dv = new DataView(out.buffer, dataStart, dataLen);
  const little = !o.big;
  let off = 0;
  for (let e = 0; e < nEv; e++) {
    o.pars.forEach((p, i) => {
      const v = o.data[i][e];
      const t = typeOf(o, p);
      if (t === 'F') dv.setFloat32(off, v, little);
      else if (t === 'D') dv.setFloat64(off, v, little);
      else {
        const b = bytesOf(o, p);
        if (b === 1) dv.setUint8(off, v);
        else if (b === 2) dv.setUint16(off, v, little);
        else if (b === 4) dv.setUint32(off, v, little);
        else throw new Error('unsupported integer size');
      }
      off += bytesOf(o, p);
    });
  }
  return out;
}

/** Several data sets in one file, chained with $NEXTDATA. */
export function buildMulti(sets: BuildOpts[]): Uint8Array {
  const parts = sets.map((s, i) => {
    const len = buildFcs(s).length;
    return buildFcs({ ...s, nextData: i + 1 < sets.length ? len : 0 });
  });
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const toBuf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
