// Marker assistant: suggests marker labels for fluorescence channels from the files' $PnS keywords, sample names and a
// panel description the user pastes; accepted rows are written to ws.channelLabels in one undo step.
import { allChannels, type Workspace } from '../core/model';
import { isScatterOrTime } from '../core/transforms';
import { useStore } from '../state/store';
import { redact, sampleHints } from './context';
import { markerPrompt } from './prompts';

export interface MarkerRow {
  channel: string;
  current: string;
  pns: string;
  suggestion: string;
  note: string;
  accept: boolean;
}

/** Fluorescence channels with their $PnS texts (all samples) and current label. */
export function markerRows(ws: Workspace): MarkerRow[] {
  return allChannels(ws)
    .filter((c) => !isScatterOrTime(c.name) && !/^(time|event|width)/i.test(c.name))
    .map((c) => {
      const pns = [...new Set(ws.samples.map((s) => s.channels.find((x) => x.name === c.name)?.label?.trim()).filter((x): x is string => !!x))];
      return { channel: c.name, current: ws.channelLabels[c.name] ?? pns[0] ?? '', pns: pns.join(' / '), suggestion: '', note: '', accept: false };
    });
}

export function markerRequest(ws: Workspace, rows: MarkerRow[], panel: string): string {
  const channels = rows.map((r) => `${r.channel} | ${r.pns || '-'} | ${r.current || '(none)'}`).join('\n');
  return redact(markerPrompt({ channels, samples: sampleHints(ws), panel: panel.trim().slice(0, 6000) }), ws);
}

export function mergeMarkers(rows: MarkerRow[], v: unknown): MarkerRow[] {
  const list = Array.isArray((v as { labels?: unknown })?.labels) ? ((v as { labels: unknown[] }).labels as Record<string, unknown>[]) : [];
  return rows.map((r) => {
    const m = list.find((x) => x && typeof x.channel === 'string' && x.channel.trim().toLowerCase() === r.channel.toLowerCase());
    const sug = typeof m?.marker === 'string' ? m.marker.trim().slice(0, 40) : '';
    return { ...r, suggestion: sug, note: typeof m?.note === 'string' ? m.note.slice(0, 160) : m ? '' : 'no suggestion', accept: !!sug && sug !== r.current };
  });
}

/** Write the accepted suggestions (one undo step). Returns how many labels changed. */
export function applyMarkers(rows: MarkerRow[]): number {
  const take = rows.filter((r) => r.accept && r.suggestion.trim() && r.suggestion.trim() !== r.current);
  if (!take.length) return 0;
  useStore.getState().update((w) => {
    for (const r of take) w.channelLabels[r.channel] = r.suggestion.trim();
  });
  return take.length;
}
