// "Check analysis": the plots of the current sheet (up to 8 images) plus the gating tree with counts and the per-sample
// frequencies go to the model, which lists potential problems. Suggestions only; nothing is changed.
import { engine } from '../core/engine';
import { allChannels, type PlotItem, type Workspace } from '../core/model';
import { applies } from '../core/scope';
import { resolveLayers } from '../render/plot';
import { anon, chan, popName, redact, sampleLabel, treeText } from './context';
import { panels } from './methods';
import { checkPrompt } from './prompts';
import { renderAiImage, type AiPlotImage } from './render';

export const MAX_CHECK_IMAGES = 8;

export interface CheckPrep {
  items: PlotItem[];
  images: AiPlotImage[];
  prompt: string;
  /** the settings it was built with ("Hide sample and file names", images on): a view rebuilds it when they change */
  anonymized: boolean;
  withImages: boolean;
}

export interface CheckIssue {
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  itemId?: string;
  population?: string;
}

function perSample(ws: Workspace): string {
  const sids = ws.samples.filter((s) => engine.has(s.id)).slice(0, 12);
  const pops = ws.populations.filter((p) => p.gate.type !== 'bool').slice(0, 14);
  if (sids.length < 2 || !pops.length) return '';
  const rows = [`Population | ${sids.map((s) => sampleLabel(ws, s.id)).join(' | ')}`];
  for (const p of pops)
    rows.push(
      `${p.name} | ${sids
        .map((s) => {
          if (!applies(ws, s.id, p.id)) return 'n/a';
          const d = engine.count(ws, s.id, p.parentId);
          return d ? ((100 * engine.count(ws, s.id, p.id)) / d).toFixed(1) : '-';
        })
        .join(' | ')}`,
    );
  return rows.join('\n');
}

export async function prepareCheck(ws: Workspace, sheetId: string, sampleId: string | null, images: boolean): Promise<CheckPrep> {
  const hidden = anon();
  const sheet = ws.worksheets.find((s) => s.id === sheetId);
  const items = panels(sheet?.items ?? []).filter((i): i is PlotItem => i.kind === 'plot').slice(0, MAX_CHECK_IMAGES);
  const imgs: AiPlotImage[] = [];
  if (images && sampleId) for (const it of items) imgs.push(await renderAiImage(ws, it, sampleId, { px: 400, grid: false, gateLabel: 'name+percent' }));
  // "Hide sample and file names" switched while the images were encoded: build them again, so images and text agree
  if (anon() !== hidden) {
    imgs.forEach((i) => URL.revokeObjectURL(i.url));
    return prepareCheck(ws, sheetId, sampleId, images);
  }
  const desc = items
    .map((it, i) => {
      const ls = resolveLayers(it, ws, sampleId, engine);
      const axes = it.plotType === 'histogram' ? `histogram of ${chan(ws, it.xParam)}` : `${chan(ws, it.xParam)} vs ${chan(ws, it.yParam)}`;
      const who = ls.map((l) => `"${popName(ws, l.popId)}" of ${sampleLabel(ws, l.sampleId)}${ls.length > 1 ? ` (color ${l.color})` : ''}`);
      return `Image ${i + 1}: ${axes}, ${who.length > 1 ? 'overlay of ' : 'population '}${who.join(', ') || '(no data)'}`;
    })
    .join('\n');
  const panel = allChannels(ws)
    .map((c) => chan(ws, c.name))
    .join(', ');
  return { items, images: imgs, prompt: redact(checkPrompt({ images: desc || '(no plots on this sheet)', tree: treeText(ws, sampleId, 60), perSample: perSample(ws), panel, image: imgs.length > 0 }), ws), anonymized: hidden, withImages: images };
}

export function parseIssues(v: unknown, items: PlotItem[]): { issues: CheckIssue[]; summary: string } {
  const o = (v && typeof v === 'object' ? v : {}) as { issues?: unknown; summary?: unknown };
  const list = Array.isArray(o.issues) ? (o.issues as Record<string, unknown>[]) : [];
  const issues = list
    .filter((x) => x && typeof x === 'object' && typeof x.title === 'string')
    .slice(0, 20)
    .map((x): CheckIssue => {
      const n = typeof x.image === 'number' ? x.image : parseInt(String(x.image ?? ''), 10);
      const sev = x.severity === 'high' || x.severity === 'low' ? x.severity : 'medium';
      return { severity: sev, title: String(x.title).slice(0, 120), detail: typeof x.detail === 'string' ? x.detail.slice(0, 600) : '', itemId: items[n - 1]?.id, population: typeof x.population === 'string' ? x.population.slice(0, 60) : undefined };
    });
  const rank = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { issues, summary: typeof o.summary === 'string' ? o.summary.slice(0, 400) : '' };
}
