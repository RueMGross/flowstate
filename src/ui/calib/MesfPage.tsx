// MESF / ERF fluorescence calibration page.
import { useEffect, useMemo, useState } from 'react';
import { getBeadKit, kitReferenceValues, kitValueWarnings, type BeadKit } from '../../core/beads';
import type { DerivedDef } from '../../core/derived';
import { engine } from '../../core/engine';
import { autoBeadScale, beadSaturation, findBeadPeaks, fitMesf, mesfValue, type BeadPeak, type BeadSaturation, type MesfFit } from '../../core/mesf';
import { popPath, sampleHasChannel, uid, type Workspace } from '../../core/model';
import { makeScale } from '../../core/transforms';
import { shortChannelName } from '../../core/naming';
import { dataLogScale, defaultOutputName, derivedOutputValues, freeChannelName, upsertDerived } from '../../state/derivedOps';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { Check, Sel, Seg, Txt } from '../widgets';
import { HistChart, logRange, XYChart, type HistWindow } from './charts';
import { addCalibPanelToSheet, mesfFitPanel } from './sheetPanels';
import { ApplyTargets, CalibList, clean, memoOn, Notes, PopulationPicker, popValues, ReportBox, SamplePicker, Stat, StepCard } from './common';
import { emptyMesf, useCalib, type FitMethodMesf, type MesfChanDraft, type MesfDraft } from './draft';
import { chanFromKit, guessKit, intensityKits, kitLabels, unitOf, valuesSource } from './logic';
import { decadeLogScale, fluorChannelsOf, kitName, fmtFix, fmtNum, fmtPct, guessFluor, preferArea, type MesfDef, type MesfProvenance } from './util';

const BASE_UNITS = ['MESF', 'ERF', 'MEFL', 'MEPE', 'ABC'];
const METHODS: { value: FitMethodMesf; label: string; title: string }[] = [
  { value: 'log', label: 'Log-log', title: 'log10(reference) = a + b · log10(MFI), ordinary least squares (default)' },
  { value: 'weightedLog', label: 'Weighted log', title: 'as log-log, each bead weighted by events / rCV² (precision of its median)' },
  { value: 'linear', label: 'Linear', title: 'reference = a + b · MFI (only for detectors with a true zero offset)' },
];

interface ChanResult {
  values: Float32Array | null;
  error?: string;
  k: number;
  presentIdx: number[];
  scale: ReturnType<typeof autoBeadScale> | null;
  hist: { u0: number; u1: number; counts: Float32Array } | null;
  peaks: BeadPeak[];
  detWarnings: string[];
  /** significant peaks in the histogram (automatic detection), to compare with the kit's populations */
  nCandidates: number;
  matched: boolean;
  /** detector saturation of the detected peaks (channel and its -H twin), null without peaks */
  saturation: BeadSaturation | null;
  /** peak indices left out of the regression: by the user, and saturated beads unless the user keeps them */
  exclude: number[];
  fit: MesfFit | null;
  fitError?: string;
}

/**
 * Channels of the bead sample that can be calibrated: measured fluorescence channels (Area first), then computed
 * channels the sample has (e.g. unmixed fluorochromes; the calibration is chained to their definition).
 */
export function mesfChannels(ws: Workspace, sampleId: string | null): { names: string[]; computed: string[] } {
  const sample = ws.samples.find((s) => s.id === sampleId);
  if (!sample) return { names: [], computed: [] };
  const measured = preferArea(fluorChannelsOf(sample.channels.map((c) => c.name)));
  const computed = (ws.derived ?? [])
    .filter((x) => x.kind === 'unmix')
    .flatMap((x) => x.outputs.map((o) => o.name))
    .filter((n) => !measured.includes(n) && sampleHasChannel(ws, sample.id, n));
  return { names: [...measured, ...computed], computed };
}

/** Hints that the detected bead pattern does not fit the chosen kit (wrong kit, missing or extra populations). */
export function kitPatternHints(kitName: string, r: Pick<ChanResult, 'k' | 'nCandidates' | 'matched' | 'fit'>, labels: string[], presentIdx: number[]): string[] {
  const out: string[] = [];
  if (r.nCandidates > r.k + 1) out.push(`The histogram shows ${r.nCandidates} bead-like peaks but ${kitName} has ${r.k} populations in use: is this the right kit (or are doublet peaks gated out)?`);
  if (r.fit && r.matched) {
    const bad = r.fit.points.filter((p) => p.used && Number.isFinite(p.residualPct) && Math.abs(p.residualPct) > 25);
    if (bad.length)
      out.push(
        `The detected peaks do not follow the reference values of ${kitName}: ${bad.map((p) => `${labels[presentIdx[p.index]] ?? `#${p.index + 1}`} ${p.residualPct > 0 ? '+' : ''}${p.residualPct.toFixed(0)} %`).join(', ')}. Check that the sample contains this kit and that no population is missing or extra.`,
      );
  }
  return out;
}

/** Labels (P1 ...) of the beads in the file, in the order of the detected peaks. */
const presetIdxLabels = (names: string[], presentIdx: number[]) => presentIdx.map((i) => names[i] ?? `#${i + 1}`);

/** A bead (kit population index) is flagged as saturated in the detected peaks (the blank is never flagged). */
export function isSaturatedBead(r: Pick<ChanResult, 'matched' | 'presentIdx' | 'saturation'>, c: Pick<MesfChanDraft, 'refs'>, i: number): boolean {
  const j = r.presentIdx.indexOf(i);
  return r.matched && j >= 0 && !!r.saturation?.saturated[j] && c.refs[i] !== 0;
}

/** Peak detection, saturation check and fit for one channel draft (pure apart from engine reads). */
export function analyseMesf(ws: ReturnType<typeof useStore.getState>['ws'], d: MesfDraft, c: MesfChanDraft): ChanResult {
  const { values, error } = popValues(ws, d.sampleId, d.population, c.channel);
  const presentIdx = c.present.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const k = presentIdx.length;
  const res: ChanResult = { values, error, k, presentIdx, scale: null, hist: null, peaks: [], detWarnings: [], nCandidates: 0, matched: false, saturation: null, exclude: [], fit: null };
  if (!values) return res;
  if (values.length < 10) {
    res.error = `Only ${values.length} events in the selected population.`;
    return res;
  }
  // detection is cached per event array (typing reference values does not re-run it)
  const scale = memoOn(values, 'scale', () => autoBeadScale(values));
  res.scale = scale;
  const auto = memoOn(values, `auto${k}`, () => findBeadPeaks(values, Math.max(1, k), { scale }));
  res.hist = auto.histogram.counts.length ? { u0: auto.histogram.u0, u1: auto.histogram.u1, counts: auto.histogram.counts } : null;
  res.nCandidates = auto.candidates.length;
  const det = c.windows ? memoOn(values, `win${k}${JSON.stringify(c.windows.map((w) => w.map(String)))}`, () => findBeadPeaks(values, Math.max(1, k), { scale, windows: c.windows! })) : auto;
  res.peaks = det.peaks;
  res.detWarnings = det.warnings;
  res.matched = k > 0 && det.peaks.length === k;
  // detector saturation on the channel and its height twin (as on the size page): pile-up at the top, median at the
  // top of the range or no spread
  const sample = ws.samples.find((s) => s.id === d.sampleId);
  const range = sample?.channels.find((x) => x.name === c.channel)?.range;
  const hName = /-A$/.test(c.channel) ? c.channel.replace(/-A$/, '-H') : '';
  const hRange = hName ? sample?.channels.find((x) => x.name === hName)?.range : undefined;
  if (det.peaks.length)
    res.saturation = memoOn(det, `sat:${range ?? ''}:${hRange !== undefined ? hName : ''}`, () =>
      beadSaturation(values, det.peaks, { range, height: hRange !== undefined ? popValues(ws, d.sampleId, d.population, hName).values : null, heightRange: hRange }),
    );
  if (!res.matched) return res;
  const refs = presentIdx.map((i) => c.refs[i]);
  // saturated beads are left out unless the user keeps them ("In fit" ticked)
  const exclude = presentIdx.map((i, j) => (c.excluded[i] || (isSaturatedBead(res, c, i) && !c.keepSaturated?.[i]) ? j : -1)).filter((j) => j >= 0);
  res.exclude = exclude;
  try {
    const kit = d.kitId && d.kitId !== 'custom' ? getBeadKit(d.kitId) : undefined;
    const names = kitLabels(kit, d);
    res.fit = fitMesf(det.peaks, refs, { method: c.method, exclude, unit: c.unit, labels: presetIdxLabels(names, presentIdx) });
  } catch (e) {
    res.fitError = (e as Error).message.replace(/^fitMesf: /, '');
  }
  return res;
}

export function MesfPage() {
  const ws = useStore((s) => s.ws);
  const dataVersion = useStore((s) => s.ui.dataVersion);
  const d = useCalib((s) => s.mesf);
  const set = useCalib((s) => s.setMesf);
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  const kit = d.kitId && d.kitId !== 'custom' ? getBeadKit(d.kitId) : undefined;
  const labels = kitLabels(kit, d);
  const sample = ws.samples.find((s) => s.id === d.sampleId);
  const { names: chanNames, computed: computedChans } = mesfChannels(ws, d.sampleId);
  const chanLabel = (ch: string) => sample?.channels.find((c) => c.name === ch)?.label ?? ws.derived?.flatMap((x) => x.outputs).find((o) => o.name === ch)?.label ?? '';
  const chanOption = (n: string) => ({ value: n, label: computedChans.includes(n) ? `${n} (computed)` : chanLabel(n) && chanLabel(n) !== n ? `${n} (${chanLabel(n)})` : n });

  // defaults: a bead-like sample, its kit and the first matching channel
  useEffect(() => {
    if (d.sampleId && ws.samples.some((s) => s.id === d.sampleId)) return;
    const cand = loaded.find((s) => /mesf|bead|rainbow|rcp|quantum|quantibrite|calib|sphero/i.test(s.name) && fluorChannelsOf(s.channels.map((c) => c.name)).length) ?? null;
    if (!cand) return;
    pickSample(cand.id);
  }, [loaded.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickSample(id: string) {
    const s = ws.samples.find((x) => x.id === id);
    if (!s) return;
    // a recognisable kit name in the file wins; otherwise keep the kit chosen so far
    const guessed = guessKit(`${s.name} ${s.fileName}`);
    const kitId = guessed !== 'custom' ? guessed : d.kitId || 'custom';
    const kitChanged = kitId !== d.kitId;
    const k = kitId !== 'custom' ? getBeadKit(kitId) : undefined;
    const names = mesfChannels(ws, id).names;
    const lab = (n: string) => s.channels.find((c) => c.name === n)?.label ?? ws.derived?.flatMap((x) => x.outputs).find((o) => o.name === n)?.label ?? '';
    // channel whose name matches a kit fluorochrome with values, else the first Area channel
    const withVals = names.find((n) => {
      const f = guessFluor(k, n, lab(n));
      return f && kitReferenceValues(k!, f)?.values.some((v) => v !== null && v > 0);
    });
    const ch = withVals ?? names.find((n) => guessFluor(k, n, lab(n))) ?? names[0];
    const keep = d.chans.filter((c) => names.includes(c.channel));
    set((x) => {
      x.sampleId = id;
      x.kitId = kitId;
      if (kitChanged) x.lot = '';
      if (!keep.length) {
        x.chans = ch ? [chanFromKit(k, x, ch, lab(ch))] : [];
        x.active = 0;
      } else if (kitChanged) x.chans = keep.map((c) => ({ ...chanFromKit(k, x, c.channel, lab(c.channel), c), editId: undefined }));
      else x.chans = keep.map((c) => ({ ...c, windows: null, editId: undefined })); // another bead sample: a new calibration
      x.active = Math.min(x.active, Math.max(0, x.chans.length - 1));
    });
  }

  function pickKit(kitId: string) {
    const k = kitId !== 'custom' ? getBeadKit(kitId) : undefined;
    set((x) => {
      if (x.kitId !== kitId) x.lot = '';
      x.kitId = kitId;
      x.chans = x.chans.map((c) => chanFromKit(k, x, c.channel, chanLabel(c.channel), c));
    });
  }

  const results = useMemo(
    () => d.chans.map((c) => analyseMesf(ws, d, c)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.samples, ws.populations, ws.compensations, ws.derived, d.sampleId, d.population, d.chans, dataVersion],
  );
  const ai = Math.min(d.active, Math.max(0, d.chans.length - 1));
  const c = d.chans[ai];
  const r = results[ai];
  const upChan = (f: (c: MesfChanDraft) => void) =>
    set((x) => {
      const cc = x.chans[ai];
      if (cc) f(cc as MesfChanDraft);
    });

  const startEdit = (def: DerivedDef) => {
    if (def.kind !== 'mesf') return;
    const m = def as MesfDef;
    const b = m.beads;
    const sid = (b?.sampleId && ws.samples.some((s) => s.id === b.sampleId) ? b.sampleId : ws.samples.find((s) => s.name === b?.sampleName)?.id) ?? null;
    const k = b?.kitId && b.kitId !== 'custom' ? getBeadKit(b.kitId) : undefined;
    const ui = (b as MesfProvenance & { ui?: Partial<MesfChanDraft> & { labels?: string[] } } | undefined)?.ui;
    set((x) => {
      Object.assign(x, emptyMesf());
      x.sampleId = sid;
      x.population = b?.population ?? 'root';
      x.kitId = b?.kitId ?? 'custom';
      x.lot = b?.lot ?? '';
      if (!k && ui?.labels) x.customLabels = ui.labels;
      const n = (k?.populations ?? x.customLabels).length;
      const fill = <T,>(a: T[] | undefined, v: T) => (a && a.length === n ? a : Array<T>(n).fill(v));
      x.chans = [
        {
          channel: m.channel,
          fluor: ui?.fluor ?? b?.fluor ?? '',
          refs: fill(ui?.refs, null),
          edited: fill(ui?.edited, true),
          unit: m.unit,
          present: fill(ui?.present, true),
          excluded: fill(ui?.excluded, false),
          keepSaturated: fill(ui?.keepSaturated, false),
          windows: ui?.windows ?? null,
          method: m.fit.method,
          editId: m.id,
        },
      ];
      x.active = 0;
      x.applyAll = !m.samples;
      x.applyIds = m.samples ?? [];
    });
    if (!sid) useStore.getState().toast(`The bead sample "${b?.sampleName ?? ''}" is not in the workspace: load it to re-detect the peaks.`, 'info');
  };

  if (!ws.samples.length)
    return (
      <div className="cal-empty card">
        <div className="card-body">
          <h3>Calibrate fluorescence in MESF / ERF units</h3>
          <p className="hint">Load the FCS file of your calibration beads (e.g. Quantum MESF, SPHERO Rainbow, Quantibrite) together with your samples. The beads give a regression from MFI to molecules of equivalent soluble fluorochrome that is then applied to every sample as a new channel.</p>
        </div>
      </div>
    );

  const editingId = c?.editId && ws.derived?.some((x) => x.id === c.editId) ? c.editId : undefined;
  return (
    <>
      <StepCard n="" title="Fluorescence calibrations in this workspace">
        <CalibList kind="mesf" onEdit={startEdit} editingId={editingId} />
      </StepCard>

      <StepCard n={1} title="Bead sample, kit and channels" right={editingId && <span className="badge comp">editing {ws.derived?.find((x) => x.id === editingId)?.outputs[0]?.name}</span>}>
        <div className="cal-grid">
          <div className="frow">
            <label>Bead sample</label>
            <SamplePicker value={d.sampleId} onChange={pickSample} ariaLabel="Bead sample" />
          </div>
          <div className="frow" title="Use a bead singlets gate to exclude doublets and debris">
            <label>Events</label>
            <PopulationPicker value={d.population} sampleId={d.sampleId} ariaLabel="Bead population" onChange={(v) => set((x) => void (x.population = v))} />
          </div>
          <div className="frow">
            <label>Bead kit</label>
            <Sel value={d.kitId || 'custom'} ariaLabel="Bead kit" options={[...intensityKits().map((k) => ({ value: k.id, label: `${kitName(k)} (${k.vendor.split(' (')[0]})` })), { value: 'custom', label: 'Custom beads (enter values)' }]} onChange={pickKit} />
          </div>
          <div className="frow">
            <label>Lot number</label>
            <Txt value={d.lot} ariaLabel="Lot number" placeholder="from the certificate" onChange={(v) => set((x) => void (x.lot = v))} />
          </div>
        </div>
        {kit && (
          <p className="hint" style={{ margin: '2px 0 8px' }}>
            {clean(kit.note)}
            {kit.catalog ? ` Cat. ${kit.catalog}.` : ''}
          </p>
        )}
        {!d.sampleId && <Notes tone="info" items={['Choose the sample with your calibration beads (bead files named e.g. MESF, Rainbow, Quantum or Quantibrite are picked automatically).']} />}
        {!kit && <CustomPops d={d} />}
        {d.sampleId && sample && !chanNames.length && <Notes tone="error" items={[`"${sample.name}" has no fluorescence channels to calibrate.`]} />}
        {sample?.compId && <Notes tone="info" items={['This bead sample is compensated. Calibration beads are usually analysed uncompensated (set its matrix to "Uncompensated" in the Compensation view) unless your samples are calibrated after compensation on purpose.']} />}
        {d.sampleId && chanNames.length > 0 && (
          <div className="cal-chans">
            <div className="row" role="tablist" aria-label="Calibrated channels">
              {d.chans.map((cc, i) => (
                <span key={cc.channel} className={`chip${i === ai ? ' on' : ''}`} role="tab" aria-selected={i === ai} tabIndex={0} onClick={() => set((x) => void (x.active = i))} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && set((x) => void (x.active = i))}>
                  {cc.channel}
                  {results[i]?.fit ? '' : ' (no fit)'}
                  {d.chans.length > 1 && (
                    <button
                      className="chip-x"
                      aria-label={`Remove ${cc.channel}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        set((x) => {
                          x.chans.splice(i, 1);
                          x.active = Math.max(0, Math.min(x.active, x.chans.length - 1));
                        });
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {chanNames.filter((n) => !d.chans.some((cc) => cc.channel === n)).length > 0 && (
                <Sel
                  value=""
                  ariaLabel="Add a channel"
                  options={[{ value: '', label: '+ Add channel' }, ...chanNames.filter((n) => !d.chans.some((cc) => cc.channel === n)).map(chanOption)]}
                  onChange={(v) => {
                    if (!v) return;
                    set((x) => {
                      x.chans.push(chanFromKit(kit, x, v, chanLabel(v)));
                      x.active = x.chans.length - 1;
                    });
                  }}
                />
              )}
            </div>
            {c && computedChans.includes(c.channel) && (
              <Notes tone="info" items={[`${c.channel} is a computed channel: the calibration is chained to its definition (e.g. the unmixing) and follows it when that changes.`]} />
            )}
            {c && (
              <div className="cal-grid" style={{ marginTop: 8 }}>
                <div className="frow">
                  <label>Channel</label>
                  <Sel
                    value={c.channel}
                    ariaLabel="Channel to calibrate"
                    options={[
                      ...(chanNames.includes(c.channel) ? [] : [{ value: c.channel, label: `${c.channel} (not in this sample)` }]),
                      ...chanNames.filter((n) => n === c.channel || !d.chans.some((cc) => cc.channel === n)).map(chanOption),
                    ]}
                    onChange={(v) => upChan((cc) => Object.assign(cc, chanFromKit(kit, d, v, chanLabel(v), { ...cc, editId: cc.editId }), { channel: v }))}
                  />
                </div>
                {kit?.channels && (
                  <div className="frow" title="The kit lists values per fluorochrome; pick the one measured in this channel">
                    <label>Kit values for</label>
                    <Sel
                      value={c.fluor}
                      ariaLabel="Kit values for fluorochrome"
                      options={[{ value: '', label: 'None (enter values)' }, ...kit.channels.map((k) => ({ value: k.fluorochrome, label: `${k.fluorochrome} (${k.unitLabel ?? k.unit})` }))]}
                      onChange={(v) =>
                        upChan((cc) => {
                          const vals = v ? kitReferenceValues(kit, v)?.values : undefined;
                          cc.fluor = v;
                          cc.refs = labels.map((l, i) => (vals ? vals[i] ?? null : /blank/i.test(l) ? 0 : null));
                          cc.edited = labels.map(() => false);
                          cc.unit = unitOf(kit, v);
                        })
                      }
                    />
                  </div>
                )}
                <div className="frow">
                  <label>Unit</label>
                  <Sel value={c.unit} ariaLabel="Unit" options={[...new Set([...BASE_UNITS, c.unit])].map((u) => ({ value: u, label: u }))} onChange={(v) => upChan((cc) => void (cc.unit = v))} />
                </div>
              </div>
            )}
          </div>
        )}
      </StepCard>

      {c && r && <PeaksStep d={d} c={c} r={r} labels={labels} upChan={upChan} />}
      {c && r && <FitStep d={d} c={c} r={r} kit={kit} labels={labels} upChan={upChan} />}
      {c && r && <ApplyStep d={d} results={results} kit={kit} labels={labels} ai={ai} />}
    </>
  );
}

function CustomPops({ d }: { d: MesfDraft }) {
  const set = useCalib((s) => s.setMesf);
  return (
    <div className="row" style={{ margin: '2px 0 8px' }}>
      <span className="hint">Custom beads: {d.customLabels.length} populations (first = blank with reference 0, if your kit has one).</span>
      <button
        className="btn sm"
        onClick={() =>
          set((x) => {
            x.customLabels.push(`P${x.customLabels.length}`);
            for (const c of x.chans) {
              c.refs.push(null);
              c.edited.push(false);
              c.present.push(true);
              c.excluded.push(false);
              c.windows = null;
            }
          })
        }
      >
        <Icon.plus /> Population
      </button>
      <button
        className="btn sm"
        disabled={d.customLabels.length <= 2}
        onClick={() =>
          set((x) => {
            x.customLabels.pop();
            for (const c of x.chans) {
              c.refs.pop();
              c.edited.pop();
              c.present.pop();
              c.excluded.pop();
              c.windows = null;
            }
          })
        }
      >
        Remove last
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- step 2: peaks

function PeaksStep({ d, c, r, labels, upChan }: { d: MesfDraft; c: MesfChanDraft; r: ChanResult; labels: string[]; upChan: (f: (c: MesfChanDraft) => void) => void }) {
  const ws = useStore((s) => s.ws);
  const sample = ws.samples.find((s) => s.id === d.sampleId);
  const win: HistWindow[] = r.peaks.map((p, j) => {
    const pi = r.matched ? r.presentIdx[j] : -1;
    const isBlank = pi >= 0 && c.refs[pi] === 0;
    const sat = r.saturation?.saturated[j] && !isBlank;
    return {
      lo: p.lo,
      hi: p.hi,
      median: p.median,
      label: pi >= 0 ? labels[pi] : `#${j + 1}`,
      tone: pi < 0 ? 'unassigned' : r.exclude.includes(j) ? 'excluded' : isBlank ? 'blank' : 'bead',
      tip: `median ${fmtNum(p.median)}, rCV ${fmtFix(p.rcvPct, 1)} %, ${p.count.toLocaleString('en-US')} events${sat ? `; detector saturation: ${r.saturation!.reasons[j].join(', ')}` : ''}`,
    };
  });
  const addWindow = () => {
    if (!r.scale || !r.hist) return;
    const sc = makeScale(r.scale);
    const { u0, u1 } = r.hist;
    const ws2 = r.peaks.map((p): [number, number] => [p.lo, p.hi]);
    const us = ws2.map(([lo, hi]) => [Number.isFinite(lo) ? sc.fwd(lo) : u0, Number.isFinite(hi) ? sc.fwd(hi) : u1]).sort((a, b) => a[0] - b[0]);
    let best = [u0, u1];
    let prev = u0;
    let gapBest = -1;
    for (const [a, b] of [...us, [u1, u1]]) {
      if (a - prev > gapBest) {
        gapBest = a - prev;
        best = [prev, a];
      }
      prev = Math.max(prev, b);
    }
    const mid = (best[0] + best[1]) / 2;
    const half = Math.min((best[1] - best[0]) * 0.3, 0.03 * (u1 - u0));
    const nw: [number, number] = [sc.inv(mid - half), sc.inv(mid + half)];
    upChan((cc) => void (cc.windows = [...ws2, nw].sort((a, b) => (Number.isFinite(a[0]) ? a[0] : -1e300) - (Number.isFinite(b[0]) ? b[0] : -1e300))));
  };
  const status = r.error
    ? null
    : c.windows
      ? `Manual windows: ${r.peaks.length} for ${r.k} populations`
      : `Automatic detection: ${r.peaks.length} of ${r.k} populations found`;
  return (
    <StepCard
      n={2}
      title="Detect the bead populations"
      right={
        <div className="row">
          <button className="btn sm" onClick={addWindow} disabled={!r.hist} title="Add a window (switches to manual windows); drag its edges onto the missing population">
            <Icon.plus /> Window
          </button>
          <button className="btn sm" onClick={() => upChan((cc) => void (cc.windows = null))} disabled={!c.windows} title="Discard manual windows and detect the populations automatically">
            <Icon.wand /> Re-detect
          </button>
        </div>
      }
    >
      {r.error && <Notes tone="error" items={[r.error]} />}
      {r.hist && r.scale && (
        <>
          <HistChart
            counts={r.hist.counts}
            u0={r.hist.u0}
            u1={r.hist.u1}
            scale={r.scale}
            windows={win}
            height={200}
            xTitle={`${c.channel} (display scale${d.population !== 'root' ? `, ${popPath(ws, d.population)}` : ''})`}
            ariaLabel={`Histogram of ${c.channel} with bead windows`}
            onWindowsChange={(w) => upChan((cc) => void (cc.windows = w))}
          />
          <div className="row cal-hist-foot">
            <span className={`hint${r.matched ? '' : ' cal-warn-text'}`}>{status}. Drag the window edges to adjust; medians and rCVs come from the raw events inside each window.</span>
          </div>
          {c.windows && (
            <div className="row" style={{ marginTop: 4 }}>
              {r.peaks.map((p, j) => (
                <span key={j} className="chip">
                  #{j + 1}: {fmtNum(p.lo)} to {fmtNum(p.hi)}
                  <button className="chip-x" aria-label={`Remove window ${j + 1}`} onClick={() => upChan((cc) => void (cc.windows = r.peaks.filter((_, i) => i !== j).map((q): [number, number] => [q.lo, q.hi])))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {!r.matched && (
            <Notes
              tone="warn"
              items={[
                `${r.peaks.length} windows for ${r.k} populations. Untick populations that are not in the file (step 3), add or remove windows, or choose a gated population (e.g. bead singlets).`,
                ...r.detWarnings.filter((w) => !/^found \d+ of/.test(w)),
              ]}
            />
          )}
        </>
      )}
      {sample && !r.error && !r.hist && <Notes tone="warn" items={['No histogram: too few events with finite values in this channel.']} />}
    </StepCard>
  );
}

// ---------------------------------------------------------------- step 3: references and fit

function FitStep({ d, c, r, kit, labels, upChan }: { d: MesfDraft; c: MesfChanDraft; r: ChanResult; kit: BeadKit | undefined; labels: string[]; upChan: (f: (c: MesfChanDraft) => void) => void }) {
  const fit = r.fit;
  const src = valuesSource(kit, c);
  const peakOf = (i: number) => (r.matched ? r.peaks[r.presentIdx.indexOf(i)] : undefined);
  const ptOf = (i: number) => (fit && r.matched ? fit.points[r.presentIdx.indexOf(i)] : undefined);

  // missing values are listed per bead below; example / nominal status is judged from what the user typed
  const kitWarn = kit ? kitValueWarnings(kit, c.fluor || undefined).filter((w) => !/missing lot values|no values for/.test(w) && !(src === 'user' && /example|nominal/.test(w))) : [];
  const missing = labels.filter((_, i) => c.present[i] && c.refs[i] === null);
  const errs: string[] = [];
  if (src === 'kit-example') errs.push(`The reference values are EXAMPLE values of another lot stored with "${kit ? kitName(kit) : ''}". They are not valid for your beads: type the values from your lot certificate into the table.`);
  if (src === 'mixed') errs.push('Some reference values are still the kit preset (example or nominal) values: check every value against your lot certificate.');
  const warns: string[] = [...kitWarn.filter((w) => !/example/.test(w) || src !== 'kit-example')];
  // detector saturation (shown at the top of the step): saturated beads are left out unless the user keeps them
  const satWarn: string[] = [];
  const satIdx = labels.map((_, i) => i).filter((i) => c.present[i] && isSaturatedBead(r, c, i));
  if (satIdx.length) {
    const why = (i: number) => `${labels[i]} (${r.saturation!.reasons[r.presentIdx.indexOf(i)].join(', ')})`;
    const out = satIdx.filter((i) => r.exclude.includes(r.presentIdx.indexOf(i)));
    const kept = satIdx.filter((i) => !r.exclude.includes(r.presentIdx.indexOf(i)));
    if (out.length)
      satWarn.push(
        `Detector saturation on ${c.channel}: ${out.map(why).join('; ')}. ${out.length > 1 ? 'They are' : 'It is'} left out of the regression: a compressed median bends the fit and the values near the top. Use a lower gain, or tick "In fit" to use ${out.length > 1 ? 'them' : 'it'} anyway.`,
      );
    if (kept.length) errs.push(`${kept.map(why).join('; ')} ${kept.length > 1 ? 'are' : 'is'} saturated but used in the regression (your choice): the slope and the values near the top are biased.`);
  }
  if (missing.length) warns.push(`Enter the reference values for ${missing.join(', ')} (from the certificate), or untick them if they are not in the file.`);
  if (kit) warns.push(...kitPatternHints(`"${kitName(kit)}"`, r, labels, r.presentIdx));
  if (fit) {
    warns.push(...fit.warnings.filter((w) => !/no reference value/.test(w)));
    if (fit.method !== 'linear') {
      const rr = Math.sqrt(Math.max(0, fit.r2));
      if (rr < 0.9995) warns.push(`Correlation r = ${rr.toFixed(4)} is below 0.9995: check the peak assignment, the reference values and saturation of the brightest bead.`);
    }
    for (const p of fit.points) if (p.used && p.count !== undefined && p.count < 300) warns.push(`Only ${p.count} events in ${labels[r.presentIdx[p.index]]}: its median is imprecise.`);
    for (const p of fit.points) if (p.used && p.rcvPct !== undefined && p.rcvPct > 15) warns.push(`${labels[r.presentIdx[p.index]]} is broad (rCV ${p.rcvPct.toFixed(1)} %): check the window and the gate.`);
  }
  // regression plot data
  const used = fit ? fit.points.filter((p) => !p.blank && p.reference !== null && p.reference > 0) : [];
  const xs = used.map((p) => p.median);
  const ys = used.map((p) => p.reference as number);
  const thrMfi = fit?.blank?.thresholdMfi;
  const [x0, x1] = logRange([...xs, ...(fit?.blank && fit.blank.median > 0 ? [fit.blank.median] : [])], 2);
  const [y0, y1] = logRange([...ys, ...used.map((p) => p.fitted)], 2);
  const lineX = Array.from({ length: 60 }, (_, i) => x0 * Math.pow(x1 / x0, i / 59));
  const lineY = fit ? lineX.map((x) => mesfValue(fit, x)) : [];
  const unit = c.unit;
  return (
    <StepCard
      n={3}
      title="Reference values and regression"
      right={
        <div className="row">
          <span className="hint">Fit</span>
          <Seg value={c.method} options={METHODS.map((m) => ({ value: m.value, label: m.label, title: m.title }))} onChange={(v) => upChan((cc) => void (cc.method = v))} />
        </div>
      }
    >
      <Notes tone="error" items={errs} />
      <Notes tone="warn" items={satWarn} />
      <div className="tbl-wrap">
        <table className="data cal-table">
          <thead>
            <tr>
              <th title="Population is in the file (counts for detection)">In file</th>
              <th className="left">Bead</th>
              <th>
                Reference<span className="sub">{unit}</span>
              </th>
              <th>
                Median<span className="sub">MFI</span>
              </th>
              <th>
                rCV<span className="sub">%</span>
              </th>
              <th>Events</th>
              <th>
                Fitted<span className="sub">{unit}</span>
              </th>
              <th>
                Residual<span className="sub">%</span>
              </th>
              <th title="Use this bead in the regression">In fit</th>
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => {
              const p = peakOf(i);
              const pt = ptOf(i);
              const isBlank = c.refs[i] === 0;
              const big = pt && Number.isFinite(pt.residualPct) && Math.abs(pt.residualPct) > 10;
              const sat = c.present[i] && isSaturatedBead(r, c, i);
              const inFit = c.present[i] && !c.excluded[i] && !isBlank && (!sat || !!c.keepSaturated?.[i]);
              return (
                <tr key={i} className={c.present[i] ? '' : 'off'}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${l} is in the file`}
                      checked={c.present[i]}
                      onChange={(e) =>
                        upChan((cc) => {
                          cc.present[i] = e.target.checked;
                          cc.windows = null;
                        })
                      }
                    />
                  </td>
                  <td className="left">{l}</td>
                  <td className="cal-refcell">
                    <RefInput
                      value={c.refs[i]}
                      ariaLabel={`Reference value of ${l}`}
                      edited={c.edited[i]}
                      onChange={(v) =>
                        upChan((cc) => {
                          cc.refs[i] = v;
                          cc.edited[i] = true;
                        })
                      }
                    />
                  </td>
                  <td title={sat ? `Detector saturation: ${r.saturation!.reasons[r.presentIdx.indexOf(i)].join(', ')}` : undefined}>
                    {p ? fmtNum(p.median) : ''}
                    {sat ? <span className="cal-warn-text"> saturated</span> : null}
                  </td>
                  <td>{p ? fmtFix(p.rcvPct, 1) : ''}</td>
                  <td>{p ? p.count.toLocaleString('en-US') : ''}</td>
                  <td>{pt && !isBlank ? fmtNum(pt.fitted) : pt && isBlank ? <span className="hint">blank</span> : ''}</td>
                  <td className={big ? 'cal-bad' : ''}>{pt && !isBlank ? fmtPct(pt.residualPct, 1) : ''}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Use ${l} in the regression`}
                      title={sat ? 'Saturated: left out by default; tick to use it anyway' : undefined}
                      disabled={!c.present[i] || isBlank}
                      checked={inFit}
                      onChange={(e) =>
                        upChan((cc) => {
                          const on = e.target.checked;
                          cc.excluded[i] = !on;
                          // a saturated bead is kept only on request; unticking it returns to the default
                          if (sat) cc.keepSaturated = labels.map((_, t) => (t === i ? on : !!cc.keepSaturated?.[t]));
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ margin: '4px 0 10px' }}>
        Reference values:{' '}
        {kit?.valuesStatus === 'empty' && !c.refs.some((v, i) => c.present[i] && v !== null && v > 0)
          ? 'enter them from your certificate'
          : src === 'user'
            ? 'entered by you'
            : src === 'kit-example' ? 'kit EXAMPLE values (not your lot)' : src === 'mixed' ? 'partly entered by you' : kit?.valuesStatus === 'empty' ? 'enter them from your certificate' : 'kit preset values'}. A blank bead has reference 0 (it gives the detection threshold, not a regression point). Typed values are marked with a bar.
      </p>
      {r.fitError && <Notes tone="error" items={[`No fit: ${r.fitError}.`]} />}
      {fit && (
        <div className="cal-two">
          <XYChart
            height={250}
            ariaLabel="Regression of reference values on bead medians"
            x={{ type: 'log', min: x0, max: x1, title: `${c.channel} median (MFI)` }}
            y={{ type: 'log', min: y0, max: y1, title: `Reference (${unit})` }}
            series={[
              { kind: 'line', x: lineX, y: lineY, color: 'var(--accent)', width: 1.6 },
              {
                kind: 'points',
                x: xs,
                y: ys,
                color: 'var(--sel)',
                hollow: used.map((p) => !p.used),
                tips: used.map((p) => `${labels[r.presentIdx[p.index]]}: median ${fmtNum(p.median)} MFI, reference ${fmtNum(p.reference)} ${unit}, fitted ${fmtNum(p.fitted)} (${fmtPct(p.residualPct)})${p.used ? '' : ', not in fit'}`),
              },
            ]}
            anno={{
              vlines: [
                ...(fit.blank && fit.blank.median > 0 ? [{ x: fit.blank.median, color: 'var(--text-3)', label: 'blank' }] : []),
                ...(thrMfi && thrMfi > 0 ? [{ x: thrMfi, color: 'var(--danger)', dash: '2 3', label: '+2 rSD' }] : []),
              ],
            }}
            legend={[
              { name: 'beads in fit', color: 'var(--sel)', marker: 'dot' },
              ...(used.some((p) => !p.used) ? [{ name: 'excluded', color: 'var(--sel)', marker: 'ring' as const }] : []),
              { name: 'regression', color: 'var(--accent)', marker: 'line' },
            ]}
          />
          <div className="cal-stats">
            <div className="cal-eq">{fit.method === 'linear' ? `${unit} = a + b · MFI` : `log₁₀(${unit}) = a + b · log₁₀(MFI)`}</div>
            <div className="cal-statgrid">
              <Stat label="Slope b" value={fmtFix(fit.slope, 4)} sub={fit.method !== 'linear' ? 'ideal about 1' : undefined} />
              <Stat label="Intercept a" value={fit.method === 'linear' ? fmtNum(fit.intercept, 5) : fmtFix(fit.intercept, 4)} sub={fit.method !== 'linear' ? `10^a = ${fmtNum(Math.pow(10, fit.intercept))} ${unit} per MFI` : undefined} />
              <Stat label="R²" value={fmtFix(fit.r2, 6)} sub={`r = ${fmtFix(Math.sqrt(Math.max(0, fit.r2)), 5)}`} />
              <Stat label="Beads in fit" value={String(fit.n)} sub={METHODS.find((m) => m.value === fit.method)?.label} />
            </div>
            {fit.blank && (
              <div className="cal-thr">
                <b>Detection threshold</b> (blank median + 2 rSD): {fmtNum(fit.blank.thresholdMfi)} MFI = <b>{fmtNum(fit.blank.thresholdValue)} {unit}</b>
                <div className="hint">
                  Blank median {fmtNum(fit.blank.median)} MFI ({fmtNum(fit.blank.value)} {unit}), rSD {fmtNum(fit.blank.rsd)} MFI.
                </div>
              </div>
            )}
            {!fit.blank && <p className="hint">No blank bead (reference 0) in the fit: no detection threshold.</p>}
            <button
              className="btn sm"
              title="Place the regression plot on the active worksheet as a figure panel, with R² and slope"
              onClick={() =>
                addCalibPanelToSheet(
                  mesfFitPanel({
                    channel: c.channel,
                    unit,
                    points: used.map((p) => ({ median: p.median, reference: p.reference as number, used: p.used })),
                    line: { x: lineX, y: lineY },
                    r2: fit.r2,
                    slope: fit.slope,
                    thresholdMfi: thrMfi ?? null,
                  }),
                )
              }
            >
              <Icon.plus /> Add regression to sheet
            </button>
          </div>
        </div>
      )}
      <Notes tone="warn" items={warns} />
    </StepCard>
  );
}

function RefInput({ value, onChange, ariaLabel, edited }: { value: number | null; onChange: (v: number | null) => void; ariaLabel: string; edited: boolean }) {
  const [s, setS] = useState<string | null>(null);
  const shown = s ?? (value === null ? '' : String(value));
  return (
    <input
      className={`cal-ref${edited ? ' edited' : ''}${value === null ? ' missing' : ''}`}
      value={shown}
      aria-label={ariaLabel}
      inputMode="decimal"
      placeholder="enter"
      onChange={(e) => setS(e.target.value)}
      onBlur={() => {
        if (s !== null) {
          const t = s.trim().replace(/[\s,']/g, '');
          if (t === '') onChange(null);
          else {
            const v = parseFloat(t);
            if (Number.isFinite(v) && v >= 0) onChange(v);
          }
        }
        setS(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setS(null);
      }}
    />
  );
}

// ---------------------------------------------------------------- step 4: apply

/** Label of an MESF output only when its name does not already say channel and unit (e.g. a renamed output). */
export function mesfOutputLabel(name: string, channel: string, unit: string): string | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const n = norm(name);
  // "FITC MESF" (the short default name) says it as well as "FITC-A MESF"
  return (n.includes(norm(channel)) || n.includes(norm(shortChannelName(channel)))) && n.includes(norm(unit)) ? undefined : `${channel} ${unit}`;
}

function buildDef(ws: ReturnType<typeof useStore.getState>['ws'], d: MesfDraft, c: MesfChanDraft, r: ChanResult, kit: BeadKit | undefined, labels: string[], outName: string): { def: MesfDef; scale: ReturnType<typeof decadeLogScale> } | null {
  const fit = r.fit;
  if (!fit) return null;
  const sample = ws.samples.find((s) => s.id === d.sampleId);
  const chRange = sample?.channels.find((x) => x.name === c.channel)?.range ?? ws.derived?.flatMap((x) => x.outputs).find((o) => o.name === c.channel)?.range ?? 262144;
  const refsP = r.presentIdx.map((i) => c.refs[i]);
  const maxRef = Math.max(...refsP.map((v) => v ?? 0), 1);
  const lowest = Math.min(...fit.points.filter((p) => p.fitted > 0).map((p) => p.fitted), fit.blank && fit.blank.value > 0 ? fit.blank.value : Infinity);
  const top = mesfValue(fit, chRange);
  const scale = decadeLogScale(Number.isFinite(lowest) ? Math.max(lowest / 10, 1e-3) : 1, Math.min(Number.isFinite(top) && top > 0 ? top : maxRef * 10, maxRef * 30));
  const prov: MesfProvenance & { ui: unknown } = {
    sampleId: d.sampleId ?? undefined,
    population: d.population,
    populationName: popPath(ws, d.population),
    kitId: d.kitId || 'custom',
    fluor: c.fluor,
    valuesSource: valuesSource(kit, c),
    labels: r.presentIdx.map((i) => labels[i]),
    counts: r.peaks.map((p) => p.count),
    rcvPct: r.peaks.map((p) => Number(p.rcvPct.toFixed(3))),
    present: c.present,
    // left out of the regression: by the user and saturated beads not kept
    excluded: [...r.exclude],
    saturated: r.presentIdx.map((i, j) => (isSaturatedBead(r, c, i) ? j : -1)).filter((j) => j >= 0),
    windows: c.windows,
    blankRsd: fit.blank?.rsd,
    blankMedian: fit.blank?.median,
    rangeMfi: chRange,
    ui: { refs: c.refs, edited: c.edited, present: c.present, excluded: c.excluded, keepSaturated: c.keepSaturated ?? labels.map(() => false), windows: c.windows, labels, fluor: c.fluor },
  };
  const def: MesfDef = {
    id: c.editId ?? uid('mesf'),
    kind: 'mesf',
    name: `${c.channel} ${c.unit}`,
    channel: c.channel,
    unit: c.unit,
    outputs: [{ name: outName, label: mesfOutputLabel(outName, c.channel, c.unit), range: Number.isFinite(top) && top > 0 ? top : maxRef * 10 }],
    samples: d.applyAll ? undefined : d.applyIds,
    created: new Date().toISOString(),
    fit: { method: fit.method, slope: fit.slope, intercept: fit.intercept, r2: fit.r2 },
    calibratedRange: { ...fit.calibratedRange, mfi: [...fit.calibratedRange.mfi], mesf: [...fit.calibratedRange.mesf] },
    beads: {
      sampleName: sample?.name,
      kit: kit ? `${kitName(kit)} (${kit.vendor}${kit.catalog ? `, ${kit.catalog}` : ''})` : 'custom beads',
      lot: d.lot || undefined,
      medians: r.peaks.map((p) => p.median),
      refs: refsP,
      threshold: fit.blank?.thresholdValue,
      ...prov,
    },
  };
  return { def, scale };
}

/** The bead range the calibration is supported by (values outside it are extrapolated). */
function CalibratedRangeNote({ fit, unit }: { fit: MesfFit; unit: string }) {
  const cr = fit.calibratedRange;
  if (![...cr.mfi, ...cr.mesf].every(Number.isFinite)) return null;
  return (
    <div className="cal-thr" style={{ margin: '6px 0' }}>
      <b>Calibrated range</b> (beads in the regression): {fmtNum(cr.mfi[0])} to {fmtNum(cr.mfi[1])} MFI ={' '}
      <b>
        {fmtNum(cr.mesf[0])} to {fmtNum(cr.mesf[1])} {unit}
      </b>
      {cr.blankThresholdMesf !== undefined && `; detection threshold ${fmtNum(cr.blankThresholdMesf)} ${unit}`}.
      <div className="hint">Values outside this range are extrapolated from the regression. Statistics tables mark such values with † and the calibration report states the range.</div>
    </div>
  );
}

function ApplyStep({ d, results, kit, labels, ai }: { d: MesfDraft; results: ChanResult[]; kit: BeadKit | undefined; labels: string[]; ai: number }) {
  const ws = useStore((s) => s.ws);
  const set = useCalib((s) => s.setMesf);
  const c = d.chans[ai];
  const r = results[ai];
  const [outName, setOutName] = useState<string | null>(null);
  const [okExample, setOkExample] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const editDef = c.editId ? (ws.derived ?? []).find((x) => x.id === c.editId) : undefined;
  const defaultName = editDef?.outputs[0]?.name ?? defaultOutputName(c.channel, c.unit, c.editId);
  const name = outName ?? defaultName;
  useEffect(() => setOutName(null), [c.channel, c.unit, c.editId]);
  useEffect(() => setLast(null), [d.sampleId, c.channel]);
  const src = valuesSource(kit, c);
  const needOk = src === 'kit-example' || src === 'mixed';
  const missing = r.presentIdx.some((i) => c.refs[i] === null && !c.excluded[i]);
  const can = !!r.fit && (!needOk || okExample) && name.trim() !== '' && (d.applyAll || d.applyIds.length > 0);
  const lastDef = last ? (ws.derived ?? []).find((x) => x.id === last) : undefined;

  const apply = () => {
    const b = buildDef(ws, d, c, r, kit, labels, name.trim());
    if (!b) return;
    const taken = freeChannelName(name.trim(), b.def.id);
    if (taken !== name.trim()) {
      useStore.getState().toast(`"${name.trim()}" is already a channel name; using "${taken}".`, 'info');
      b.def.outputs[0].name = taken;
    }
    upsertDerived(b.def, { [b.def.outputs[0].name]: dataLogScale(derivedOutputValues(useStore.getState().ws, b.def, 0)) ?? b.scale });
    set((x) => void (x.chans[ai].editId = b.def.id));
    setLast(b.def.id);
    useStore.getState().toast(`${editDef ? 'Updated' : 'Created'} "${b.def.outputs[0].name}" (${b.def.unit}) for ${d.applyAll ? 'all samples' : `${d.applyIds.length} samples`}`, 'success');
  };

  const exampleChans = d.chans.length > 1 ? d.chans.filter((cc) => ['kit-example', 'mixed'].includes(valuesSource(kit, cc))).map((cc) => cc.channel) : [];
  const allOk =
    d.chans.length > 1 &&
    (d.applyAll || d.applyIds.length > 0) &&
    d.chans.every((cc, i) => {
      const sv = valuesSource(kit, cc);
      return !!results[i]?.fit && (okExample || (sv !== 'kit-example' && sv !== 'mixed'));
    });
  const applyAll = () => {
    const names: string[] = [];
    d.chans.forEach((cc, i) => {
      const cur = useStore.getState().ws;
      const ed = cc.editId ? (cur.derived ?? []).find((x) => x.id === cc.editId) : undefined;
      const nm = i === ai ? name.trim() : ed?.outputs[0]?.name ?? defaultOutputName(cc.channel, cc.unit, cc.editId);
      const b = buildDef(cur, d, cc, results[i], kit, labels, nm);
      if (!b) return;
      b.def.outputs[0].name = freeChannelName(nm, b.def.id);
      // the label follows the final name (a "2" suffix does not change what it says)
      b.def.outputs[0].label = mesfOutputLabel(b.def.outputs[0].name, cc.channel, cc.unit);
      upsertDerived(b.def, { [b.def.outputs[0].name]: dataLogScale(derivedOutputValues(cur, b.def, 0)) ?? b.scale });
      set((x) => void (x.chans[i].editId = b.def.id));
      names.push(b.def.outputs[0].name);
      if (i === ai) setLast(b.def.id);
    });
    useStore.getState().toast(`Saved ${names.map((n) => `"${n}"`).join(', ')}`, 'success');
  };
  return (
    <StepCard n={4} title="Apply to samples">
      <div className="cal-grid">
        <div className="frow">
          <label>Output channel</label>
          <input className="inp" value={name} aria-label="Output channel name" onChange={(e) => setOutName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      </div>
      <ApplyTargets all={d.applyAll} ids={d.applyIds} channel={c.channel} onChange={(all, ids) => set((x) => void ((x.applyAll = all), (x.applyIds = ids)))} />
      <p className="hint" style={{ margin: '6px 0' }}>
        The new channel holds {c.unit} = f(MFI of {c.channel}) for every event and gets a log display scale;{' '}
        {c.method === 'linear'
          ? 'with the linear fit every event, also at or below 0 MFI, gets a calibrated value.'
          : 'events at or below 0 MFI get 0 (the limit of the log fit), so medians and percentiles of dim populations keep their rank; the geometric mean uses positive values only.'}{' '}
        It appears in all channel lists, statistics and exports.
      </p>
      {r.fit && <CalibratedRangeNote fit={r.fit} unit={c.unit} />}
      {(needOk || exampleChans.length > 0) && (
        <div className="cal-confirm">
          <Check
            checked={okExample}
            onChange={setOkExample}
            label={`Use the example values${needOk ? '' : ` of ${exampleChans.join(', ')}`} anyway (testing only: the calibration and its report are marked as using example values)`}
          />
        </div>
      )}
      {missing && <Notes tone="warn" items={['Beads without a reference value are left out of the regression.']} />}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!can} onClick={apply}>
          {editDef ? `Update "${editDef.outputs[0]?.name}"` : `Create ${name.trim() || 'channel'}`}
        </button>
        {c.editId && (
          <button className="btn" onClick={() => set((x) => void (x.chans[ai].editId = undefined))} title="Keep the existing calibration and create a new one from these settings">
            Save as new
          </button>
        )}
        {d.chans.length > 1 && (
          <button className="btn" disabled={!allOk} onClick={applyAll} title={allOk ? 'Create or update the calibrated channel of every channel above (default output names)' : 'Every channel needs a regression (and confirmed example values)'}>
            Apply all {d.chans.length} channels
          </button>
        )}
        {!r.fit && <span className="hint">Needs a regression (step 3).</span>}
      </div>
      {lastDef && (
        <div style={{ marginTop: 10 }}>
          <Notes tone="ok" items={[`Saved "${lastDef.outputs[0]?.name}". Report:`]} />
          <ReportBox def={lastDef} />
        </div>
      )}
    </StepCard>
  );
}
