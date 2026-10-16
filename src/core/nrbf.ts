// Minimal reader for .NET BinaryFormatter streams (MS-NRBF), as far as Beckman CytExpert compensation files (.comp)
// use them, and the extraction of their compensation matrices.
//
// Format notes (from [MS-NRBF] and the CytExpert / CytExpert nano file of figshare 31855687, "compensation_liposome_atto.comp"):
//   - A .comp file is several BinaryFormatter streams written one after the other, each starting with a
//     SerializedStreamHeader record (0x00) and ending with MessageEnd (0x0B):
//       System.Int32 (4), System.Boolean (true), System.Boolean (false),
//       CTG_Tube_RDC.CompensationInfo (Height matrix), CTG_Tube_RDC.CompensationInfo (Area matrix),
//       six System.Int32,
//     then a trailer that is not NRBF: "CytExpert nano Integrity Check" in UTF-32LE and a binary checksum (ignored).
//   - CompensationInfo members: m_ArrayChannelName (string[], detector names like "V447", "B531", "Y595", "R670"),
//     m_CompensationMatrix (System.Single[,] n x n: BinaryArray record, rectangular, rank 2, little-endian float32 in
//     row-major order), m_ArrayBackGroundValue (float[]), m_ArrayAutoFluoRadio (float[]), m_ArrayGain (int[]).
//   - m_CompensationMatrix[d][s] is the spillover of fluorochrome s into detector d (rows = detectors), i.e. the transpose
//     of the FCS $SPILLOVER layout (rows = fluorochromes). Checked against the FCS files of the same experiment: their
//     COMPH / COMPA keywords (tab-separated, same layout as the .comp matrix) and $SPILLOVER (12 x 12, FL1-H..FL6-H,
//     FL1-A..FL6-A) agree with the transposed .comp values, except for the V447 fluorochrome, which the FCS files
//     compensate and this .comp file does not (0).
//   - The first CompensationInfo is the Height matrix (background 375 = COMPBGH), the second the Area matrix
//     (background 7500 = COMPBGA). A file with a single CompensationInfo is taken as Area.
//   - CytExpert names detectors by laser and band ("B531" = blue laser, 531 nm band); the FCS files call the parameters
//     FL1-A... ($PnN) and carry the detector in $PnS ("B531-A", or "Atto488 B531-H" when the user named the stain).
//
// Records read: SerializedStreamHeader (0), ClassWithId (1), SystemClassWithMembers (2), ClassWithMembers (3),
// SystemClassWithMembersAndTypes (4), ClassWithMembersAndTypes (5), BinaryObjectString (6), BinaryArray (7),
// MemberPrimitiveTyped (8), MemberReference (9), ObjectNull (10), MessageEnd (11), BinaryLibrary (12),
// ObjectNullMultiple256 (13), ObjectNullMultiple (14), ArraySinglePrimitive (15), ArraySingleObject (16),
// ArraySingleString (17). Anything else (remoting method calls, untyped members) stops with a clear error.

export interface NrbfClass {
  kind: 'class';
  className: string;
  members: Record<string, NrbfValue>;
}
export interface NrbfArray {
  kind: 'array';
  /** dimensions (one entry for a one-dimensional array) */
  dims: number[];
  /** elements in row-major order */
  values: NrbfValue[];
}
export interface NrbfRef {
  kind: 'ref';
  id: number;
}
export type NrbfValue = NrbfClass | NrbfArray | NrbfRef | string | number | boolean | bigint | null;

const PRIM_SIZE: Record<number, number> = { 1: 1, 2: 1, 6: 8, 7: 2, 8: 4, 9: 8, 10: 1, 11: 4, 12: 8, 13: 8, 14: 2, 15: 4, 16: 8 };
const PRIM_NAME: Record<number, string> = { 1: 'Boolean', 2: 'Byte', 3: 'Char', 5: 'Decimal', 6: 'Double', 7: 'Int16', 8: 'Int32', 9: 'Int64', 10: 'SByte', 11: 'Single', 12: 'TimeSpan', 13: 'DateTime', 14: 'UInt16', 15: 'UInt32', 16: 'UInt64', 18: 'String' };

interface ClassMeta {
  name: string;
  members: string[];
  /** BinaryTypeEnum per member (undefined: untyped ClassWithMembers, not supported for reading values) */
  types?: number[];
  /** PrimitiveTypeEnum for Primitive (0) / PrimitiveArray (7) members */
  prims?: (number | undefined)[];
}

class NrbfError extends Error {}

class Reader {
  pos: number;
  private dv: DataView;
  private td = new TextDecoder('utf-8');
  constructor(
    private b: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get left() {
    return this.b.length - this.pos;
  }
  need(n: number, what: string) {
    if (n < 0 || this.pos + n > this.b.length) throw new NrbfError(`the file ends inside ${what} (byte ${this.pos})`);
  }
  u8() {
    this.need(1, 'a record');
    return this.b[this.pos++];
  }
  i32() {
    this.need(4, 'a record');
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  str(): string {
    // LengthPrefixedString: 7-bit encoded length (at most 5 bytes), then UTF-8
    let len = 0;
    for (let k = 0; ; k++) {
      if (k >= 5) throw new NrbfError(`invalid string length at byte ${this.pos}`);
      const c = this.u8();
      len |= (c & 0x7f) << (7 * k);
      if (!(c & 0x80)) break;
    }
    this.need(len, 'a string');
    const s = this.td.decode(this.b.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
  prim(t: number): NrbfValue {
    const at = this.pos;
    switch (t) {
      case 1:
        return this.u8() !== 0;
      case 2:
        return this.u8();
      case 10: {
        const v = this.u8();
        return v > 127 ? v - 256 : v;
      }
      case 3: {
        // Char: one UTF-8 encoded character
        const c = this.u8();
        const n = c < 0x80 ? 0 : c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
        this.need(n, 'a character');
        const s = this.td.decode(this.b.subarray(at, at + 1 + n));
        this.pos = at + 1 + n;
        return s;
      }
      case 5:
      case 18:
        return this.str();
      case 6:
        this.need(8, 'a number');
        this.pos += 8;
        return this.dv.getFloat64(at, true);
      case 7:
        this.need(2, 'a number');
        this.pos += 2;
        return this.dv.getInt16(at, true);
      case 14:
        this.need(2, 'a number');
        this.pos += 2;
        return this.dv.getUint16(at, true);
      case 8:
        return this.i32();
      case 15:
        this.need(4, 'a number');
        this.pos += 4;
        return this.dv.getUint32(at, true);
      case 11:
        this.need(4, 'a number');
        this.pos += 4;
        return this.dv.getFloat32(at, true);
      case 9:
      case 12:
      case 13:
        this.need(8, 'a number');
        this.pos += 8;
        return this.dv.getBigInt64(at, true);
      case 16:
        this.need(8, 'a number');
        this.pos += 8;
        return this.dv.getBigUint64(at, true);
    }
    throw new NrbfError(`unsupported primitive type ${t} at byte ${at}`);
  }
}

/** One BinaryFormatter stream: the objects by id and the root object id. */
export interface NrbfStream {
  rootId: number;
  objects: Map<number, NrbfValue>;
  /** byte offset after the stream's MessageEnd */
  end: number;
}

/** Marker for null runs inside arrays (ObjectNullMultiple). */
interface NullRun {
  nullRun: number;
}

function parseStream(bytes: Uint8Array, start: number): NrbfStream {
  const r = new Reader(bytes, start);
  if (r.u8() !== 0) throw new NrbfError(`no SerializedStreamHeader at byte ${start}`);
  const rootId = r.i32();
  r.i32(); // header id
  const major = r.i32();
  const minor = r.i32();
  if (major !== 1 || minor !== 0) throw new NrbfError(`unsupported format version ${major}.${minor}`);
  const objects = new Map<number, NrbfValue>();
  const metas = new Map<number, ClassMeta>();
  let depth = 0;

  const classInfo = (): { id: number; meta: ClassMeta } => {
    const id = r.i32();
    const name = r.str();
    const n = r.i32();
    if (n < 0 || n > 10000) throw new NrbfError(`implausible member count ${n} for class ${name}`);
    const members: string[] = [];
    for (let k = 0; k < n; k++) members.push(r.str());
    return { id, meta: { name, members } };
  };
  const memberTypes = (meta: ClassMeta) => {
    const n = meta.members.length;
    const types: number[] = [];
    for (let k = 0; k < n; k++) types.push(r.u8());
    const prims: (number | undefined)[] = [];
    for (const t of types) {
      if (t === 0 || t === 7) prims.push(r.u8());
      else if (t === 3) {
        r.str();
        prims.push(undefined);
      } else if (t === 4) {
        r.str();
        r.i32();
        prims.push(undefined);
      } else if (t === 1 || t === 2 || t === 5 || t === 6) prims.push(undefined);
      else throw new NrbfError(`unknown member type ${t} in class ${meta.name}`);
    }
    meta.types = types;
    meta.prims = prims;
  };
  const readMembers = (meta: ClassMeta): NrbfClass => {
    if (!meta.types) throw new NrbfError(`class ${meta.name} is written without member types, which is not supported`);
    const members: Record<string, NrbfValue> = {};
    meta.members.forEach((m, k) => {
      const t = meta.types![k];
      if (t === 0) members[m] = r.prim(meta.prims![k]!);
      else {
        const v = record();
        if (v && typeof v === 'object' && 'nullRun' in v) throw new NrbfError(`unexpected null run in member ${m} of ${meta.name}`);
        members[m] = v as NrbfValue;
      }
    });
    return { kind: 'class', className: meta.name, members };
  };
  /** Elements of an array of records (strings, objects), with runs of nulls. */
  const recordElements = (len: number): NrbfValue[] => {
    const out: NrbfValue[] = [];
    while (out.length < len) {
      const v = record();
      if (v && typeof v === 'object' && 'nullRun' in v) {
        if (out.length + v.nullRun > len) throw new NrbfError('a run of nulls is longer than its array');
        for (let k = 0; k < v.nullRun; k++) out.push(null);
      } else out.push(v as NrbfValue);
    }
    return out;
  };
  const primElements = (t: number, len: number): NrbfValue[] => {
    const size = PRIM_SIZE[t];
    // the array must fit in the rest of the file (a damaged length must not allocate gigabytes)
    if (size) r.need(size * len, `an array of ${len} ${PRIM_NAME[t] ?? 'values'}`);
    else if (len > r.left) throw new NrbfError(`array length ${len} exceeds the file`);
    const out: NrbfValue[] = new Array(len);
    for (let k = 0; k < len; k++) out[k] = r.prim(t);
    return out;
  };
  const checkLen = (len: number) => {
    if (len < 0 || len > r.left * 8 + 256) throw new NrbfError(`implausible array length ${len}`);
  };

  function record(): NrbfValue | NullRun {
    if (++depth > 200) throw new NrbfError('objects nested too deeply');
    try {
      const at = r.pos;
      const t = r.u8();
      switch (t) {
        case 1: {
          // ClassWithId: the members of a class described before
          const id = r.i32();
          const metaId = r.i32();
          const meta = metas.get(metaId);
          if (!meta) throw new NrbfError(`reference to an unknown class description ${metaId} at byte ${at}`);
          const v = readMembers(meta);
          objects.set(id, v);
          return v;
        }
        case 2:
        case 3:
        case 4:
        case 5: {
          const { id, meta } = classInfo();
          if (t === 4 || t === 5) memberTypes(meta);
          if (t === 3 || t === 5) r.i32(); // library id
          metas.set(id, meta);
          if (t === 2 || t === 3) throw new NrbfError(`class ${meta.name} is written without member types, which is not supported`);
          const v = readMembers(meta);
          objects.set(id, v);
          return v;
        }
        case 6: {
          const id = r.i32();
          const s = r.str();
          objects.set(id, s);
          return s;
        }
        case 7: {
          // BinaryArray: jagged / rectangular / single, optionally with lower bounds
          const id = r.i32();
          const arrType = r.u8();
          const rank = r.i32();
          if (rank < 1 || rank > 32) throw new NrbfError(`implausible array rank ${rank} at byte ${at}`);
          const dims: number[] = [];
          for (let k = 0; k < rank; k++) dims.push(r.i32());
          if (arrType >= 3 && arrType <= 5) for (let k = 0; k < rank; k++) r.i32(); // lower bounds
          if (arrType > 5) throw new NrbfError(`unknown array type ${arrType} at byte ${at}`);
          const itemType = r.u8();
          let prim: number | undefined;
          if (itemType === 0 || itemType === 7) prim = r.u8();
          else if (itemType === 3) r.str();
          else if (itemType === 4) {
            r.str();
            r.i32();
          } else if (itemType > 7) throw new NrbfError(`unknown array element type ${itemType} at byte ${at}`);
          const len = dims.reduce((a, d) => a * d, 1);
          checkLen(len);
          const values = itemType === 0 ? primElements(prim!, len) : recordElements(len);
          const v: NrbfArray = { kind: 'array', dims, values };
          objects.set(id, v);
          return v;
        }
        case 8:
          return r.prim(r.u8());
        case 9:
          return { kind: 'ref', id: r.i32() };
        case 10:
          return null;
        case 12:
          r.i32();
          r.str();
          return record(); // a library record precedes the object that uses it
        case 13:
          return { nullRun: r.u8() };
        case 14:
          return { nullRun: r.i32() };
        case 15: {
          const id = r.i32();
          const len = r.i32();
          checkLen(len);
          const v: NrbfArray = { kind: 'array', dims: [len], values: primElements(r.u8(), len) };
          objects.set(id, v);
          return v;
        }
        case 16:
        case 17: {
          const id = r.i32();
          const len = r.i32();
          checkLen(len);
          const v: NrbfArray = { kind: 'array', dims: [len], values: recordElements(len) };
          objects.set(id, v);
          return v;
        }
        case 11:
          throw new NrbfError(`unexpected end of message at byte ${at}`);
      }
      throw new NrbfError(`unsupported record type ${t} at byte ${at}`);
    } finally {
      depth--;
    }
  }

  // top level: records until MessageEnd (referenced objects follow the object that refers to them)
  for (;;) {
    if (r.left <= 0) throw new NrbfError('the stream has no end record (MessageEnd); the file is cut off');
    if (bytes[r.pos] === 11) {
      r.pos++;
      break;
    }
    record();
  }
  return { rootId, objects, end: r.pos };
}

/** Resolve MemberReferences (deeply) within one stream. */
export function resolveRefs(v: NrbfValue, objects: Map<number, NrbfValue>, seen = new Set<object>()): NrbfValue {
  if (v && typeof v === 'object') {
    if (v.kind === 'ref') {
      const o = objects.get(v.id);
      if (o === undefined) throw new NrbfError(`reference to a missing object ${v.id}`);
      return resolveRefs(o, objects, seen);
    }
    if (seen.has(v)) return v;
    seen.add(v);
    if (v.kind === 'class') for (const k of Object.keys(v.members)) v.members[k] = resolveRefs(v.members[k], objects, seen);
    else if (v.kind === 'array') for (let i = 0; i < v.values.length; i++) v.values[i] = resolveRefs(v.values[i], objects, seen);
  }
  return v;
}

/**
 * All BinaryFormatter streams at the start of `bytes` (one after the other), with their root objects resolved. Reading
 * stops at the first byte that does not start a stream (e.g. a checksum trailer); `trailing` is the number of bytes left.
 */
export function parseNrbf(bytes: Uint8Array): { roots: NrbfValue[]; trailing: number } {
  const roots: NrbfValue[] = [];
  let pos = 0;
  while (pos < bytes.length && bytes[pos] === 0 && bytes.length - pos >= 17) {
    let s: NrbfStream;
    try {
      s = parseStream(bytes, pos);
    } catch (e) {
      if (!(e instanceof NrbfError)) throw e;
      if (!roots.length) throw new Error(`Not a readable .NET serialized file: ${e.message}.`);
      throw new Error(`Stream ${roots.length + 1} of the file (at byte ${pos}) could not be read: ${e.message}.`);
    }
    const root = s.objects.get(s.rootId);
    roots.push(root === undefined ? null : resolveRefs(root, s.objects));
    pos = s.end;
  }
  if (!roots.length) throw new Error('Not a .NET serialized (BinaryFormatter) file: it does not start with a stream header.');
  return { roots, trailing: bytes.length - pos };
}

// ------------------------------------------------------------------ CytExpert compensation

export interface CytExpertMatrix {
  /** 'H' (height), 'A' (area) or '' when the file does not tell */
  kind: 'H' | 'A' | '';
  /** detector names as CytExpert writes them ("V447", "B531", ...) */
  detectors: string[];
  /** spillover [fluorochrome][detector] as fractions (the transpose of the stored m_CompensationMatrix) */
  spill: number[][];
  background?: number[];
  autofluorescence?: number[];
  gain?: number[];
}

const numArray = (v: NrbfValue | undefined): number[] | undefined =>
  v && typeof v === 'object' && v.kind === 'array' && v.values.every((x) => typeof x === 'number') ? (v.values as number[]) : undefined;

/** Is this the start of a BinaryFormatter stream (SerializedStreamHeader, version 1.0)? */
export function isNrbf(bytes: Uint8Array): boolean {
  return bytes.length >= 17 && bytes[0] === 0 && bytes[9] === 1 && bytes[10] === 0 && bytes[13] === 0 && bytes[14] === 0;
}

/** Compensation matrices of a CytExpert .comp file (see the format notes at the top of this file). */
export function parseCytExpertComp(bytes: Uint8Array): { matrices: CytExpertMatrix[]; notes: string[] } {
  // bytes after the last stream (CytExpert's integrity check, a checksum) are not needed to read the matrices
  const { roots } = parseNrbf(bytes);
  const infos = roots.filter((r): r is NrbfClass => !!r && typeof r === 'object' && r.kind === 'class' && /CompensationInfo$/.test(r.className));
  if (!infos.length) {
    const names = [...new Set(roots.map((r) => (r && typeof r === 'object' && r.kind === 'class' ? r.className : typeof r)))].slice(0, 5).join(', ');
    throw new Error(`No CytExpert compensation (CompensationInfo) in this file; it holds ${names}.`);
  }
  const notes: string[] = [];
  const matrices = infos.map((info, k) => {
    const nm = info.members['m_ArrayChannelName'];
    const mx = info.members['m_CompensationMatrix'];
    if (!nm || typeof nm !== 'object' || nm.kind !== 'array' || !nm.values.every((x) => typeof x === 'string'))
      throw new Error('The CytExpert compensation has no detector names (m_ArrayChannelName).');
    const detectors = nm.values as string[];
    const n = detectors.length;
    if (!mx || typeof mx !== 'object' || mx.kind !== 'array' || mx.dims.length !== 2 || mx.dims[0] !== n || mx.dims[1] !== n || !mx.values.every((x) => typeof x === 'number'))
      throw new Error(`The CytExpert compensation matrix (m_CompensationMatrix) is not a ${n} x ${n} array of numbers for the ${n} detectors.`);
    const vals = mx.values as number[];
    // stored [detector][fluorochrome]: transposed into the FCS $SPILLOVER layout; float32 rounding removed (7 digits)
    const spill = detectors.map((_, s) => detectors.map((__, d) => Number(vals[d * n + s].toPrecision(7))));
    const kind: CytExpertMatrix['kind'] = infos.length === 2 ? (k === 0 ? 'H' : 'A') : infos.length === 1 ? 'A' : '';
    return { kind, detectors, spill, background: numArray(info.members['m_ArrayBackGroundValue']), autofluorescence: numArray(info.members['m_ArrayAutoFluoRadio']), gain: numArray(info.members['m_ArrayGain']) };
  });
  if (infos.length > 2) notes.push(`The file holds ${infos.length} matrices; they are imported in file order`);
  return { matrices, notes };
}
