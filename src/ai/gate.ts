// "Gate with AI": the plot image (+ context and the density peaks found locally) goes to the model, which answers with a
// position / box / range in plot-frame units; that seed is handed to the plot's own auto gate preview (tightness slider,
// OK / Cancel), so the boundary is computed from the data and the result is reproducible.
import { SENSITIVITY } from '../core/autogate';
import { engine } from '../core/engine';
import type { PlotItem, PopProvenance } from '../core/model';
import { windowScale } from '../core/transforms';
import { effectiveScale, plotSampleId, resolveLayers } from '../render/plot';
import { useStore } from '../state/store';
import { autoSession, requestAutoPreview, type AutoPreviewHandle, type AutoSession } from '../ui/gateOps';
import { anon, plotContext, redact, treeText } from './context';
import { gatePrompt } from './prompts';
import { AiError, completeJson, type AiProvider } from './provider';
import { renderAiImage, type AiPlotImage } from './render';
import { chooseSeed1D, chooseSeed2D, peaks1D, peaks2D, peaksText, type AiGateAnswer, type Peak, type SeedChoice } from './seed';

export const TARGETS = ['Cells (exclude debris)', 'Singlets', 'Live cells', 'Lymphocytes', 'Monocytes', 'Granulocytes', 'CD3+ T cells', 'CD4+ T cells', 'CD8+ T cells', 'B cells', 'NK cells', 'Debris to exclude', 'Beads'];

export interface GatePrep {
  itemId: string;
  target: string;
  hist: boolean;
  sampleId: string;
  popId: string;
  image: AiPlotImage | null;
  prompt: string;
  peaks: Peak[];
  session: AutoSession;
  /** the settings it was built with ("Hide sample and file names", images on): a view rebuilds it when they change */
  anonymized: boolean;
  withImages: boolean;
}

export function findPlot(itemId: string): PlotItem | null {
  const ws = useStore.getState().ws;
  for (const sh of ws.worksheets) {
    const it = sh.items.find((i) => i.id === itemId);
    if (it) return it.kind === 'plot' ? it : null;
  }
  return null;
}

/** Everything that will be sent, built locally (no network). */
export async function prepareAiGate(itemId: string, target: string, images: boolean): Promise<GatePrep> {
  const { ws, ui } = useStore.getState();
  const hidden = anon();
  const item = findPlot(itemId);
  if (!item) throw new AiError('no_plot', 'Select a plot first.');
  // the population and scales the plot shows (as the plot view and the auto gate see them)
  const prim = resolveLayers(item, ws, ui.activeSampleId, engine)[0];
  if (!prim) throw new AiError('no_data', 'This plot shows no data for the active sample.');
  const o = item.options;
  const sid = plotSampleId(item, ui.activeSampleId);
  const sc = (ch: string, ov: typeof o.xScale, win: typeof o.xWin) => (win ? windowScale(effectiveScale(ws, ch, ov, sid), win[0], win[1]) : effectiveScale(ws, ch, ov, sid));
  const geom = { primarySample: prim.sampleId, primaryPop: prim.popId, xScale: sc(item.xParam, o.xScale, o.xWin), yScale: item.plotType === 'histogram' ? null : sc(item.yParam, o.yScale, o.yWin) };
  const session = autoSession(ws, item, { xScale: geom.xScale, yScale: geom.yScale }, geom.primarySample, geom.primaryPop);
  if (!session) throw new AiError('no_data', 'This plot shows no data for the active sample.');
  const image = images ? await renderAiImage(ws, item, geom.primarySample) : null;
  const hist = session.kind === '1d';
  const peaks = session.kind === '1d' ? peaks1D(session.map) : peaks2D(session.map);
  const prompt = redact(gatePrompt({
    target: target.trim(),
    hist,
    context: plotContext(ws, item, geom.primarySample, geom.primaryPop, geom.xScale, geom.yScale),
    peaks: peaksText(peaks),
    tree: treeText(ws, geom.primarySample, 40),
    image: !!image,
  }), ws);
  // "Hide sample and file names" switched while the image was encoded: build it again, so image and text agree
  if (anon() !== hidden) {
    if (image) URL.revokeObjectURL(image.url);
    return prepareAiGate(itemId, target, images);
  }
  return { itemId, target: target.trim(), hist, sampleId: geom.primarySample, popId: geom.primaryPop, image, prompt, peaks, session, anonymized: hidden, withImages: images };
}

export interface GateOutcome {
  answer: AiGateAnswer;
  choice: SeedChoice;
  model: string;
  name: string;
}

export async function askAiGate(prep: GatePrep, provider: AiProvider, signal: AbortSignal, fresh = false): Promise<GateOutcome> {
  const { value, result } = await completeJson<AiGateAnswer>(provider, {
    prompt: prep.prompt,
    images: prep.image ? [prep.image.blob] : undefined,
    tier: 'default',
    signal,
    maxTokens: 700,
    fresh,
  });
  const answer: AiGateAnswer = value && typeof value === 'object' && !Array.isArray(value) ? value : { found: false, rationale: 'The answer was not an object.' };
  const s = prep.session;
  const choice = s.kind === '1d' ? chooseSeed1D(s.map, answer) : chooseSeed2D(s.map, answer);
  const nm = typeof answer.name === 'string' ? answer.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  const t = prep.target.replace(/\s*\(.*\)\s*$/, '');
  return { answer, choice, model: result.model, name: nm || t.charAt(0).toUpperCase() + t.slice(1) };
}

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/**
 * Show the auto gate preview for the AI's seed on the plot (waits until the plot is on screen). Resolves with the
 * preview handle, or 'none' / null when nothing was found / the plot is not shown; `onDone` gets the new population.
 */
export async function previewAiGate(prep: GatePrep, out: GateOutcome, onDone: (popId: string | null) => void, nameOverride?: string): Promise<AutoPreviewHandle | 'none' | null> {
  if (!out.choice.seed) return 'none';
  const conf = typeof out.answer.confidence === 'number' && out.answer.confidence >= 0 && out.answer.confidence <= 1 ? out.answer.confidence : undefined;
  const name = nameOverride?.trim() || out.name;
  const provenance: PopProvenance = { method: 'ai-autogate', model: out.model, date: new Date().toISOString(), target: prep.target, seed: out.choice.frame.map((v) => Math.round(v * 1000) / 1000) };
  const why = clip(out.answer.rationale, 400);
  if (why) provenance.rationale = why;
  if (conf !== undefined) provenance.confidence = conf;
  const meta = {
    title: `AI: ${name}${conf !== undefined ? ` (confidence ${Math.round(conf * 100)}%)` : ''}`,
    note: [why, out.choice.note].filter(Boolean).join(' '),
    extra: { name, provenance },
  };
  for (let t = 0; t < 60; t++) {
    const h = requestAutoPreview({ itemId: prep.itemId, seed: out.choice.seed, alpha: SENSITIVITY.normal, meta, onDone });
    if (h) return h;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return null;
}
