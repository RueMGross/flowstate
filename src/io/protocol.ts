// A protocol the scientist attaches for the AI (plate layout, conditions, sample sheet): read locally into text. Excel
// sheets keep their grid (column letters, row numbers), so a plate layout drawn as rows A-H and columns 1-12 stays a
// plate; Word documents give their paragraphs; CSV / TSV / text files are taken as they are.
import { strFromU8, unzipSync } from 'fflate';
import { child, descendants, parseXml, type XNode } from '../core/xml';

/** Most text that goes along (the request has a size limit; a protocol rarely needs more). */
export const PROTOCOL_MAX_CHARS = 25000;

export interface Protocol {
  name: string;
  text: string;
  /** cut at PROTOCOL_MAX_CHARS */
  truncated: boolean;
}

const colIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/** Text of a shared / inline string item (<si> or <is>): its <t> parts, rich-text runs included. */
const itemText = (n: XNode) => descendants(n, 't').map((t) => t.text).join('');

function xlsxText(files: Record<string, Uint8Array>): string {
  const xml = (p: string) => (files[p] ? parseXml(strFromU8(files[p])) : null);
  const shared = (() => {
    const sst = xml('xl/sharedStrings.xml');
    return sst ? descendants(sst, 'si').map(itemText) : [];
  })();
  // sheet names in workbook order, and their files (from the workbook relationships)
  const rels = new Map<string, string>();
  for (const r of descendants(xml('xl/_rels/workbook.xml.rels') ?? parseXml('<x/>'), 'Relationship')) rels.set(r.attrs.Id, r.attrs.Target);
  const sheets = descendants(xml('xl/workbook.xml') ?? parseXml('<x/>'), 'sheet').map((s) => {
    const t = rels.get(s.attrs.id ?? s.attrs['r:id'] ?? '') ?? '';
    return { name: s.attrs.name ?? 'Sheet', path: t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}` };
  });
  const out: string[] = [];
  for (const s of sheets) {
    const doc = xml(s.path);
    if (!doc) continue;
    const rows: { r: number; cells: string[] }[] = [];
    let maxCol = 0;
    for (const row of descendants(doc, 'row')) {
      const cells: string[] = [];
      for (const c of descendants(row, 'c')) {
        const v = child(c, 'v')?.text ?? '';
        const t = c.attrs.t;
        const val = t === 's' ? shared[+v] ?? '' : t === 'inlineStr' ? itemText(child(c, 'is') ?? c) : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
        const i = colIndex(c.attrs.r ?? colName(cells.length));
        if (val.trim()) cells[i] = val.replace(/\s+/g, ' ').trim();
      }
      if (!cells.some(Boolean)) continue;
      maxCol = Math.max(maxCol, cells.length);
      rows.push({ r: +(row.attrs.r ?? rows.length + 1), cells });
    }
    if (!rows.length) continue;
    out.push(`Sheet "${s.name}" (tab-separated; first column = row number):`);
    out.push(['', ...Array.from({ length: maxCol }, (_, i) => colName(i))].join('\t'));
    for (const { r, cells } of rows) out.push([r, ...Array.from({ length: maxCol }, (_, i) => cells[i] ?? '')].join('\t').replace(/\t+$/, ''));
    out.push('');
  }
  return out.join('\n');
}

function docxText(files: Record<string, Uint8Array>): string {
  const f = files['word/document.xml'];
  if (!f) return '';
  const doc = parseXml(strFromU8(f));
  return descendants(doc, 'p')
    .map((p) => descendants(p, 't').map((t) => t.text).join(''))
    .filter((t) => t.trim())
    .join('\n');
}

/** The text of a protocol file (xlsx, docx, csv, tsv, txt, md). Throws with a readable message for anything else. */
export function readProtocol(name: string, bytes: Uint8Array): Protocol {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  let text: string;
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'docx') {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: (e) => /^(xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)|word\/document\.xml)$/.test(e.name) });
    } catch {
      throw new Error(`${name} could not be opened (not an Office file, or damaged).`);
    }
    text = ext === 'docx' ? docxText(files) : xlsxText(files);
  } else if (['csv', 'tsv', 'txt', 'md', 'text'].includes(ext)) text = new TextDecoder().decode(bytes);
  else throw new Error(`${name}: use an Excel (.xlsx), Word (.docx), CSV, TSV or text file. Old .xls / .doc files: save them as .xlsx / .docx first.`);
  text = text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error(`${name} has no text that could be read.`);
  const truncated = text.length > PROTOCOL_MAX_CHARS;
  return { name, text: truncated ? text.slice(0, PROTOCOL_MAX_CHARS) : text, truncated };
}

export async function readProtocolFile(f: File): Promise<Protocol> {
  return readProtocol(f.name, new Uint8Array(await f.arrayBuffer()));
}
