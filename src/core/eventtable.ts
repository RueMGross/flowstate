// Event tables (CSV / TSV / TXT) as samples: FlowJo / FlowLogic / FCS Express "channel values" exports, FlowState's own
// population CSV export, or any table of numbers with a header row of channel names.
//   - delimiter: tab, semicolon or comma (from the header line), whitespace as a last resort; decimal commas are read
//     when the delimiter is not a comma
//   - header cells "FITC-A :: CD3" (FlowJo / FlowState export) give the channel name and its label; a first line of
//     numbers only means there is no header (channels P1, P2, ...)
//   - read in pieces (EventTableParser.push), so files of millions of events load without holding the whole text and
//     without blocking the page for long (parseEventStream yields between pieces)
//   - text columns (all cells non-numeric) are left out; single unreadable cells become 0 (reported)
// The values are taken as they are: an exported table holds no compensation keywords, so the sample is uncompensated
// unless a matrix is assigned by hand (and values exported compensated must not be compensated again).
import { parseTextSegment, usableRange, writeFcs, type FcsChannel, type FcsDataset } from './fcs';
import { detectDelimiter, parseNumberCell, splitLine, tableLines } from './matrixio';

export interface EventTable {
  names: string[];
  labels: string[];
  data: Float32Array[];
  rows: number;
  delimiter: string;
  notes: string[];
}

/** Keyword marking a sample read from an event table (shown in the sample's info as "Origin"). */
export const TABLE_ORIGIN_KEY = 'FLOWSTATE_SOURCE';
export const TABLE_ORIGIN = 'imported from CSV (values as exported; no compensation keywords)';

const MAX_COLUMNS = 10000;

export class EventTableParser {
  private rest = '';
  private started = false;
  private delim = ',';
  private names: string[] = [];
  private labels: string[] = [];
  private cols: Float32Array[] = [];
  private bad: number[] = [];
  private missing: number[] = [];
  private longRows = 0;
  private cap = 0;
  rows = 0;
  private lineNo = 0;

  /** Add the next piece of text (any split, also inside a line). */
  push(chunk: string) {
    let text = this.rest + chunk;
    if (!this.started) text = text.replace(/^﻿/, '');
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      this.line(text.charCodeAt(nl - 1) === 13 ? text.slice(start, nl - 1) : text.slice(start, nl));
      start = nl + 1;
    }
    this.rest = text.slice(start);
  }

  private header(line: string) {
    this.delim = detectDelimiter([line]);
    const cells = splitLine(line, this.delim).map((c) => c.trim());
    while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > MAX_COLUMNS) throw new Error(`The table has ${cells.length} columns; at most ${MAX_COLUMNS} are supported.`);
    const numeric = cells.every((c) => Number.isFinite(parseNumberCell(c, this.delim)));
    const used = new Set<string>();
    cells.forEach((c, i) => {
      const parts = numeric ? [] : c.split(' :: ');
      let name = (parts[0] ?? '').trim() || `P${i + 1}`;
      const label = parts.slice(1).join(' :: ').trim();
      if (used.has(name)) {
        let k = 2;
        while (used.has(`${name} (${k})`)) k++;
        name = `${name} (${k})`;
      }
      used.add(name);
      this.names.push(name);
      this.labels.push(label === name ? '' : label);
    });
    this.cap = 1024;
    this.cols = cells.map(() => new Float32Array(this.cap));
    this.bad = cells.map(() => 0);
    this.missing = cells.map(() => 0);
    this.started = true;
    return numeric;
  }

  private line(line: string) {
    this.lineNo++;
    if (!this.started) {
      if (!line.trim()) return;
      if (this.header(line)) this.line(line); // no header: the first line is data
      return;
    }
    if (!line || !line.trim()) return;
    const d = this.delim;
    const cells = line.includes('"') || d === ' ' ? splitLine(line, d) : line.split(d);
    const n = this.cols.length;
    if (this.rows === this.cap) {
      this.cap *= 2;
      this.cols = this.cols.map((a) => {
        const b = new Float32Array(this.cap);
        b.set(a);
        return b;
      });
    }
    const r = this.rows;
    let got = cells.length;
    while (got > n && cells[got - 1].trim() === '') got--;
    if (got > n) this.longRows++;
    for (let j = 0; j < n; j++) {
      const c = j < cells.length ? cells[j] : '';
      let v = c.length ? +c : NaN;
      if (v !== v || (v === 0 && !c.trim())) {
        v = parseNumberCell(c.replace(/"/g, ''), d);
        if (v !== v) {
          if (c.trim()) this.bad[j]++;
          else this.missing[j]++;
        }
      }
      this.cols[j][r] = Number.isFinite(v) ? v : NaN;
    }
    this.rows++;
  }

  finish(): EventTable {
    if (this.rest) {
      this.line(this.rest.endsWith('\r') ? this.rest.slice(0, -1) : this.rest);
      this.rest = '';
    }
    if (!this.started) throw new Error('The file is empty: no header row and no values.');
    const notes: string[] = [];
    const n = this.rows;
    if (!n) throw new Error('The table has a header row but no rows of values.');
    // text columns (no number in any row) are left out
    const keep = this.names.map((_, j) => j).filter((j) => this.bad[j] < n);
    const dropped = this.names.filter((_, j) => !keep.includes(j));
    if (!keep.length) throw new Error('No column of the table holds numbers.');
    if (dropped.length) notes.push(`Text columns left out: ${dropped.slice(0, 4).join(', ')}${dropped.length > 4 ? ` and ${dropped.length - 4} more` : ''}`);
    let unread = 0;
    let missing = 0;
    const data = keep.map((j) => {
      const a = this.cols[j].length === n ? this.cols[j] : this.cols[j].slice(0, n);
      let nan = 0;
      for (let i = 0; i < n; i++)
        if (a[i] !== a[i]) {
          a[i] = 0;
          nan++;
        }
      missing += this.missing[j];
      unread += nan - this.missing[j];
      return a;
    });
    if (unread > 0) notes.push(`${unread} cell${unread > 1 ? 's' : ''} that are not numbers were read as 0`);
    if (missing > 0) notes.push(`${missing} empty or missing cell${missing > 1 ? 's' : ''} were read as 0`);
    if (this.longRows) notes.push(`${this.longRows} row${this.longRows > 1 ? 's have' : ' has'} more values than the header has names; the extra values were ignored`);
    this.cols = [];
    return { names: keep.map((j) => this.names[j]), labels: keep.map((j) => this.labels[j]), data, rows: n, delimiter: this.delim, notes };
  }
}

export function parseEventTable(text: string): EventTable {
  const p = new EventTableParser();
  p.push(text);
  return p.finish();
}

/**
 * Read an event table from a byte stream in pieces, yielding to the page every `yieldBytes` (so a table of millions
 * of events does not freeze it). `onProgress` gets the bytes read so far.
 */
export async function parseEventStream(stream: ReadableStream<Uint8Array>, opts: { yieldBytes?: number; onProgress?: (bytes: number) => void } = {}): Promise<EventTable> {
  const reader = stream.getReader();
  const dec = new TextDecoder('utf-8');
  const p = new EventTableParser();
  const every = opts.yieldBytes ?? 4 << 20;
  let total = 0;
  let sinceYield = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    sinceYield += value.byteLength;
    p.push(dec.decode(value, { stream: true }));
    if (sinceYield >= every) {
      sinceYield = 0;
      opts.onProgress?.(total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  p.push(dec.decode());
  return p.finish();
}

/**
 * Whether the start of a text file is an event table: (optional header and) rows of numbers. A table whose first
 * column holds names in every row (a matrix, a reference spectra table) is not one. `partial`: the text was cut off
 * (its last line may be incomplete).
 */
export function looksLikeEventTable(head: string, partial = false): boolean {
  let lines = tableLines(head);
  if (partial && lines.length > 1) lines = lines.slice(0, -1);
  lines = lines.slice(0, 200);
  if (!lines.length) return false;
  const d = detectDelimiter(lines.slice(0, 1));
  const rows = lines.map((l) => splitLine(l, d).map((c) => c.trim().replace(/^"|"$/g, '')));
  const num = (c: string) => Number.isFinite(parseNumberCell(c, d));
  const hasHeader = !rows[0].every(num);
  const body = hasHeader ? rows.slice(1) : rows;
  if (!body.length) return false;
  let cells = 0;
  let good = 0;
  let firstOk = 0;
  for (const r of body) {
    if (num(r[0] ?? '')) firstOk++;
    for (const c of r) {
      if (c === '') continue;
      cells++;
      if (num(c)) good++;
    }
  }
  return good >= 0.9 * cells && firstOk >= 0.9 * body.length;
}

/**
 * The sample of an event table: an FCS dataset (float32, $PnR from the data maximum, no compensation keywords, marked
 * with TABLE_ORIGIN_KEY) and the bytes of the equivalent FCS 3.1 file (kept for saving bundles and the session).
 */
export function eventTableDataset(t: EventTable, fileName: string): { ds: FcsDataset; bytes: ArrayBuffer } {
  const ranges = t.data.map((a) => {
    let mx = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];
    return mx;
  });
  const kw: Record<string, string> = {
    $FIL: fileName.replace(/^.*[\\/]/, ''),
    $COM: `Event table ${fileName.replace(/^.*[\\/]/, '')} read by FlowState`,
    [TABLE_ORIGIN_KEY]: TABLE_ORIGIN,
  };
  const bytes = writeFcs({ channels: t.names.map((name, i) => ({ name, label: t.labels[i], range: ranges[i] })), data: t.data, keywords: kw });
  // the keywords exactly as reading the FCS bytes would give them
  const ts = parseInt(String.fromCharCode(...bytes.subarray(10, 18)).trim(), 10);
  const te = parseInt(String.fromCharCode(...bytes.subarray(18, 26)).trim(), 10);
  const keywords = parseTextSegment(bytes.subarray(ts, te + 1));
  const channels: FcsChannel[] = t.names.map((name, i) => ({
    index: i,
    name,
    label: t.labels[i],
    range: usableRange(parseFloat(keywords[`$P${i + 1}R`]) || 0, t.data[i]),
    bits: 32,
    logDecades: 0,
    logOffset: 0,
    gain: 1,
    displayHint: '',
  }));
  const ds: FcsDataset = { version: 'FCS3.1', keywords, channels, eventCount: t.rows, data: t.data, warnings: [...t.notes] };
  return { ds, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
}
