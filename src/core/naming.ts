// Automatic names of quadrant, range and split gates: marker labels when known ("CD4+ CD8-"), else short channel
// names ("AF700+ PE-"), and the rename offer when a marker label is set later.
import { popById, type GateGeom, type Population, type Workspace } from './model';

const ABBREV: [RegExp, string][] = [
  [/^Alexa\s*Fluor\s*/i, 'AF'],
  [/^Brilliant\s*Violet\s*/i, 'BV'],
  [/^Brilliant\s*Ultraviolet\s*/i, 'BUV'],
  [/^Brilliant\s*Blue\s*/i, 'BB'],
  [/^Super\s*Bright\s*/i, 'SB'],
  [/^Pacific\s*Blue/i, 'PacBlue'],
  [/^Pacific\s*Orange/i, 'PacOrange'],
];

/**
 * Short form of a channel name for gate names: without the area suffix ("PE-A" -> "PE", "CD4 PE-Cy7 FLR-A" ->
 * "CD4 PE-Cy7") and with common dye names abbreviated ("Alexa Fluor 700-A" -> "AF700"). Height / width channels keep
 * their suffix ("FSC-H").
 */
export function shortChannelName(ch: string): string {
  let s = ch.trim();
  s = s.replace(/\s+FLR-A$/i, '').replace(/[-_ ]A(rea)?$/i, '');
  for (const [re, rep] of ABBREV) if (re.test(s)) {
    s = s.replace(re, rep);
    break;
  }
  return s.trim() || ch;
}

/** Marker label of a channel (workspace label, the file's $PnS, a computed channel's label), or null. */
export function markerLabel(ws: Workspace, ch: string): string | null {
  return (
    ws.channelLabels[ch]?.trim() ||
    ws.samples.map((s) => s.channels.find((c) => c.name === ch)?.label?.trim()).find((l) => !!l) ||
    ws.derived?.flatMap((d) => d.outputs).find((o) => o.name === ch)?.label?.trim() ||
    null
  );
}

/** Name of a channel in gate names: its marker label if known ("CD4"), else the short channel name ("AF700"). */
export function markerName(ws: Workspace, ch: string): string {
  return markerLabel(ws, ch) ?? shortChannelName(ch);
}

/** Name of a range gate by its position: "X-" from the low end of the axis, "X+" up to the high end, else "X range". */
export function rangeName(label: string, min: number, max: number): string {
  if ((min === -Infinity || min === null) && max !== Infinity && max !== null) return `${label}-`;
  if ((max === Infinity || max === null) && min !== -Infinity && min !== null) return `${label}+`;
  return `${label} range`;
}

const QSIGN: Record<'UL' | 'UR' | 'LR' | 'LL', [string, string]> = { UL: ['-', '+'], UR: ['+', '+'], LR: ['+', '-'], LL: ['-', '-'] };

/** Name of a quadrant region: "CD4+ CD8-" (x marker first). */
export function quadrantName(xl: string, yl: string, q: 'UL' | 'UR' | 'LR' | 'LL'): string {
  const [sx, sy] = QSIGN[q];
  return `${xl}${sx} ${yl}${sy}`;
}

/** Automatic name of a quadrant / range / split gate with the given channel names, or null for other gates. */
function autoNameWith(g: GateGeom, nameOf: (ch: string) => string): string | null {
  switch (g.type) {
    case 'quadrant':
      return quadrantName(nameOf(g.x), nameOf(g.y), g.quadrant);
    case 'range':
      return rangeName(nameOf(g.x), g.min, g.max);
    case 'split':
      return `${nameOf(g.x)}${g.side === 'lo' ? '-' : '+'}`;
    default:
      return null;
  }
}

/** The automatic name of a gate in workspace `ws` (null for gates that are not named after their channels). */
export function autoGateName(ws: Workspace, g: GateGeom): string | null {
  return autoNameWith(g, (ch) => markerName(ws, ch));
}

/**
 * Every name the app may have given this gate automatically in workspace `ws`: with the marker label, the full channel
 * name (older versions) and the short channel name.
 */
function autoNameVariants(ws: Workspace, g: GateGeom): string[] {
  const out = new Set<string>();
  for (const f of [(ch: string) => markerName(ws, ch), (ch: string) => ch, (ch: string) => shortChannelName(ch), (ch: string) => markerLabel(ws, ch) ?? ch]) {
    const n = autoNameWith(g, f);
    if (n) out.add(n);
  }
  return [...out];
}

/** "name" or "name 2" (the suffix uniquePopName adds): the base name and the suffix. */
function splitSuffix(name: string): [string, string] {
  const m = /^(.*?)( \d+)$/.exec(name);
  return m ? [m[1], m[2]] : [name, ''];
}

export interface GateRename {
  id: string;
  from: string;
  to: string;
}

/**
 * Gates still carrying their automatic name in `prev` (as made with the channel names or labels of then) whose automatic
 * name changes in `next` because a marker label was set or changed: the renames to offer. Names the user typed are kept.
 */
export function autoNameRenames(prev: Workspace, next: Workspace, channels?: string[]): GateRename[] {
  const out: GateRename[] = [];
  const chans = channels ? new Set(channels) : null;
  for (const p of next.populations) {
    const g = p.gate;
    if (g.type !== 'quadrant' && g.type !== 'range' && g.type !== 'split') continue;
    if (chans && ![g.x, 'y' in g ? g.y : g.x].some((c) => chans.has(c))) continue;
    const old = popById(prev, p.id);
    if (!old || old.name !== p.name) continue;
    const [base, suffix] = splitSuffix(p.name);
    const variants = autoNameVariants(prev, old.gate);
    const isAuto = variants.includes(p.name) || (suffix && variants.includes(base));
    if (!isAuto) continue;
    const to = autoGateName(next, g);
    if (!to) continue;
    const keepSuffix = variants.includes(p.name) ? '' : suffix;
    const name = to + keepSuffix;
    if (name !== p.name) out.push({ id: p.id, from: p.name, to: name });
  }
  return out;
}

/** Channels whose marker label differs between two workspaces. */
export function changedLabelChannels(prev: Workspace, next: Workspace): string[] {
  const keys = new Set([...Object.keys(prev.channelLabels), ...Object.keys(next.channelLabels)]);
  return [...keys].filter((k) => (prev.channelLabels[k] ?? '') !== (next.channelLabels[k] ?? ''));
}

/** Apply renames, keeping sibling names unique (a clash gets " 2", " 3", ...). */
export function applyRenames(pops: Population[], renames: GateRename[]) {
  const byId = new Map(renames.map((r) => [r.id, r.to]));
  for (const p of pops) {
    const to = byId.get(p.id);
    if (!to) continue;
    const taken = new Set(pops.filter((q) => q.id !== p.id && q.parentId === p.parentId).map((q) => q.name));
    let n = to;
    for (let k = 2; taken.has(n); k++) n = `${to} ${k}`;
    p.name = n;
  }
}
