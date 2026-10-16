// Text the AI assistant sends along with plot images: axes, populations, counts, panel. Built locally; sample and file
// names are replaced by "Sample 1..n" when the user hides them (default). Never raw event values.
import { engine } from '../core/engine';
import { channelDisplayName, popById, popPath, type GateGeom, type PlotItem, type Workspace } from '../core/model';
import { applies } from '../core/scope';
import { describeScale } from '../core/transforms';
import { useAiSettings } from './settings';

export const anon = () => useAiSettings.getState().anonymize;

/** "Sample 3" (hidden names) or the sample's name. */
export function sampleLabel(ws: Workspace, id: string | null | undefined): string {
  const i = ws.samples.findIndex((s) => s.id === id);
  if (i < 0) return 'no sample';
  return anon() ? `Sample ${i + 1}` : ws.samples[i].name;
}

/**
 * Words in sample names that describe controls / conditions; what is sent instead of names when names are hidden. Only
 * whole words from this list: "_", "-", "." and spaces separate words (so "FMO_CD8_P0123" yields "fmo", never the rest).
 */
const HINT = /(?<![A-Za-z0-9])(unstained|unstain|blank|fmo|isotype|iso|single[- _]?stain(ed)?|comp(ensation)?|beads?|control|ctrl|stim(ulated)?|unstim(ulated)?|live|dead|viability|untreated|treated)(?![A-Za-z0-9])/gi;
/** "FMO" followed by one more word (the marker left out, e.g. "FMO_CD8", "FMO-PE"): the word is checked against the panel */
const FMO_OF = /(?<![A-Za-z0-9])fmo[\s_.-]+([^\s_.]+)/gi;

/** Channel names and marker labels (whole, and their words) of the workspace, lower case. */
function panelWords(ws: Workspace): Set<string> {
  const out = new Set<string>();
  const add = (t: string | undefined) => {
    const v = t?.trim().toLowerCase();
    if (!v) return;
    out.add(v);
    for (const w of v.split(/[\s/,;:()]+/)) if (w.length >= 2) out.add(w);
  };
  for (const l of Object.values(ws.channelLabels)) add(l);
  for (const s of ws.samples)
    for (const c of s.channels) {
      add(c.name);
      add(c.label);
    }
  return out;
}

/** Control / condition words of a name (hidden names): the list words, and "fmo <marker>" only for a known channel or marker. */
export function nameHints(name: string, panel: Set<string>): string[] {
  const w = (name.match(HINT) ?? []).map((x) => x.toLowerCase().replace(/[\s_]+/g, ' '));
  for (const m of name.matchAll(FMO_OF)) {
    const t = m[1].toLowerCase();
    const k = [t, t.split('-')[0]].find((x) => x.length >= 2 && panel.has(x));
    if (k) w.push(`fmo ${k}`);
  }
  const u = [...new Set(w)];
  // "fmo cd8" says more than "fmo"
  return u.some((x) => x.startsWith('fmo ')) ? u.filter((x) => x !== 'fmo') : u;
}

/** Sample names (or, hidden, only control / condition words found in them). */
export function sampleHints(ws: Workspace, max = 24): string {
  const panel = anon() ? panelWords(ws) : new Set<string>();
  return ws.samples
    .slice(0, max)
    .map((s, i) => {
      if (!anon()) return `${s.name}`;
      const w = nameHints(s.name, panel);
      return `Sample ${i + 1}${w.length ? ` (${w.join(', ')})` : ''}`;
    })
    .join('; ');
}

/**
 * With names hidden: sample and file names that occur in free text (plot titles, table names, text you typed) are
 * replaced by "Sample n" as well. Names that are also channel, marker or population names, or only condition words
 * (e.g. "stim"), are left alone so the text keeps its meaning.
 */
export function redact(text: string, ws: Workspace): string {
  if (!anon()) return text;
  const keep = new Set([...ws.populations.map((p) => p.name), ...Object.values(ws.channelLabels), ...ws.samples.flatMap((s) => s.channels.flatMap((c) => [c.name, c.label]))].map((x) => x.trim().toLowerCase()));
  const pairs: [string, string][] = [];
  ws.samples.forEach((s, i) => {
    for (const n of [s.fileName, s.fileName.replace(/\.[^.]+$/, ''), s.name]) {
      const t = n.trim();
      if (t.length >= 3 && !/^sample\s*\d*$/i.test(t) && !keep.has(t.toLowerCase()) && t.replace(HINT, '').replace(/[\s_.-]+/g, '') !== '') pairs.push([t, `Sample ${i + 1}`]);
    }
  });
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [n, a] of pairs) text = text.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), a);
  return text;
}

/** Instrument ($CYT) of a sample, if the file says. */
export function instrumentOf(sampleId: string | null | undefined): string {
  return (sampleId && engine.samples.get(sampleId)?.ds.keywords['$CYT']?.trim()) || '';
}

export function chan(ws: Workspace, ch: string): string {
  return channelDisplayName(ws, ch, 'both');
}

export function gateDesc(ws: Workspace, g: GateGeom): string {
  switch (g.type) {
    case 'range':
      return `range on ${chan(ws, g.x)}`;
    case 'split':
      return `split on ${chan(ws, g.x)}`;
    case 'bool':
      return `Boolean ${g.op.toUpperCase()}`;
    default:
      return `${g.type === 'rect' ? 'rectangle' : g.type} on ${chan(ws, g.x)} vs ${chan(ws, g.y)}`;
  }
}

const fmtN = (n: number) => n.toLocaleString('en-US');
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(a / b < 0.1 ? 2 : 1)}%` : '-');

/** Gating tree with gate types and (for a sample) counts and % of parent; one line per population. */
export function treeText(ws: Workspace, sampleId: string | null, maxLines = 60): string {
  const lines: string[] = [];
  const total = sampleId && engine.has(sampleId) ? engine.count(ws, sampleId, null) : 0;
  if (sampleId) lines.push(`All events: ${fmtN(total)}`);
  const walk = (parent: string | null, depth: number) => {
    for (const p of ws.populations.filter((q) => (q.parentId ?? null) === parent)) {
      if (lines.length >= maxLines) return;
      let n = '';
      if (sampleId && engine.has(sampleId)) {
        if (!applies(ws, sampleId, p.id)) n = ': n/a in this sample';
        else {
          const c = engine.count(ws, sampleId, p.id);
          const pc = p.parentId ? engine.count(ws, sampleId, p.parentId) : total;
          n = `: ${fmtN(c)} events (${pct(c, pc)} of parent)`;
        }
      }
      lines.push(`${'  '.repeat(depth)}- ${p.name} [${gateDesc(ws, p.gate)}]${n}`);
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  if (!ws.populations.length) lines.push('(no gates yet)');
  return lines.join('\n');
}

/** Axes, population and gates of a plot, as the AI should read the image. */
export function plotContext(ws: Workspace, item: PlotItem, sampleId: string, popId: string, xScale: unknown, yScale: unknown): string {
  const hist = item.plotType === 'histogram';
  const n = engine.has(sampleId) ? engine.count(ws, sampleId, popId === 'root' ? null : popId) : 0;
  const kind = hist ? 'histogram' : item.plotType === 'dot' ? 'dot plot' : item.plotType === 'contour' || item.plotType === 'zebra' ? 'contour plot' : 'pseudocolor density plot (blue = few events, red = many)';
  const sc = (s: unknown) => (s ? describeScale(s as Parameters<typeof describeScale>[0]) : '');
  const lines = [
    `Plot: ${kind} of the population "${popPath(ws, popId)}" (${fmtN(n)} events) of ${sampleLabel(ws, sampleId)}${instrumentOf(sampleId) ? `, instrument ${instrumentOf(sampleId)}` : ''}.`,
    `X axis: ${chan(ws, item.xParam)}, ${sc(xScale)} scale.`,
    hist ? 'Y axis: event count (normalized).' : `Y axis: ${chan(ws, item.yParam)}, ${sc(yScale)} scale.`,
  ];
  const onPlot = ws.populations.filter((p) => (p.parentId ?? 'root') === popId && p.gate.type !== 'bool' && 'x' in p.gate && [item.xParam, item.yParam].includes(p.gate.x));
  if (onPlot.length) lines.push(`Gates already drawn on this plot: ${onPlot.map((p) => p.name).join(', ')}.`);
  return lines.join('\n');
}

/** Population name for a parent reference ('root' -> All events). */
export function popName(ws: Workspace, id: string): string {
  return id === 'root' ? 'All events' : popById(ws, id)?.name ?? id;
}
