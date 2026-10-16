import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeSpillover, guessControlChannel } from '../core/autocomp';
import { invertMatrix } from '../core/compensation';
import { engine } from '../core/engine';
import { channelDisplayName, defaultPlotOptions, isDerivedChannel, popPath, uid, type CompDef, type PlotItem, type Workspace } from '../core/model';
import { isScatterOrTime } from '../core/transforms';
import { CanvasPainter } from '../render/painter';
import { renderPlot } from '../render/plot';
import { useStore } from '../state/store';
import { exportMatrixFile, importMatrixFiles } from '../io/files';
import { Icon } from './icons';
import { Check, Modal, Sel, Seg } from './widgets';
import { MiddleText } from './MiddleText';

/** Measured fluorescence detectors (Area) of the loaded samples; computed (derived) channels are never compensated. */
function fluorChannels(ws: Workspace) {
  const seen = new Set<string>();
  for (const s of ws.samples) for (const c of s.channels) seen.add(c.name);
  return [...seen].filter((c) => !isScatterOrTime(c) && !/-[HW]$/i.test(c) && !isDerivedChannel(ws, c));
}

/**
 * Merge a computed spillover block (control detectors only) into a base matrix: entries between two control detectors
 * come from the controls, everything else (detectors without a control) is kept from the base.
 */
export function mergeSpillover(base: Pick<CompDef, 'channels' | 'matrix'> | null, comp: { channels: string[]; matrix: number[][] }): { channels: string[]; matrix: number[][]; kept: string[] } {
  if (!base) return { channels: [...comp.channels], matrix: comp.matrix.map((r) => [...r]), kept: [] };
  const channels = [...base.channels, ...comp.channels.filter((c) => !base.channels.includes(c))];
  const bi = (c: string) => base.channels.indexOf(c);
  const ci = (c: string) => comp.channels.indexOf(c);
  const matrix = channels.map((r, i) =>
    channels.map((c, j) => {
      if (ci(r) >= 0 && ci(c) >= 0) return comp.matrix[ci(r)][ci(c)];
      if (bi(r) >= 0 && bi(c) >= 0) return base.matrix[bi(r)][bi(c)];
      return i === j ? 1 : 0;
    }),
  );
  return { channels, matrix, kept: base.channels.filter((c) => !comp.channels.includes(c)) };
}

export function CompView() {
  const ws = useStore((s) => s.ws);
  const ui = useStore((s) => s.ui);
  const st = useStore.getState();
  const [selId, setSelId] = useState<string | null>(null);
  const [cell, setCell] = useState<[number, number] | null>(null);
  const [showGrid, setShowGrid] = useState(false);
  const comp = ws.compensations.find((c) => c.id === selId) ?? ws.compensations.find((c) => c.id === ws.samples.find((s) => s.id === ui.activeSampleId)?.compId) ?? ws.compensations[0];

  const upComp = (f: (c: CompDef) => void, key?: string) =>
    st.update((w) => {
      const c = w.compensations.find((x) => x.id === comp!.id);
      if (c) f(c as CompDef);
    }, key);

  const singular = useMemo(() => {
    if (!comp) return false;
    try {
      invertMatrix(comp.matrix);
      return false;
    } catch {
      return true;
    }
  }, [comp]);

  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const newMatrix = (from?: CompDef, chosen?: string[]) => {
    const chans = from?.channels ?? chosen ?? fluorChannels(ws);
    const id = uid('comp');
    st.update((w) => {
      w.compensations.push({
        id,
        name: from ? `${from.name} (edited)` : `Matrix ${w.compensations.length + 1}`,
        channels: [...chans],
        matrix: from ? from.matrix.map((r) => [...r]) : chans.map((_, i) => chans.map((__, j) => (i === j ? 1 : 0))),
        source: 'manual',
      });
    });
    setSelId(id);
  };

  return (
    <div className="doc-view">
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h3>Matrices</h3>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {ws.compensations.map((c) => (
              <div key={c.id} className={`srow${comp?.id === c.id ? ' on' : ''}`} style={{ gridTemplateColumns: '1fr auto' }} onClick={() => setSelId(c.id)}>
                <span className="nm">{c.name}</span>
                <span className="meta">
                  {c.channels.length}×{c.channels.length} · {c.source}
                </span>
              </div>
            ))}
            {!ws.compensations.length && <div className="empty-note">No matrix yet. Matrices stored in FCS files (SPILL / $SPILLOVER) are picked up automatically; matrix files of other programs can be imported.</div>}
            <div className="row" style={{ padding: 10 }}>
              <button className="btn sm" onClick={() => setPicking(true)} disabled={!ws.samples.length} title="New identity matrix for the detectors you choose">
                <Icon.plus /> New
              </button>
              {comp && (
                <button className="btn sm" onClick={() => newMatrix(comp)}>
                  <Icon.copy /> Duplicate
                </button>
              )}
              <button className="btn sm" onClick={() => st.setUI({ dialog: { kind: 'compWizard' } })} disabled={!ws.samples.length}>
                <Icon.wand /> From controls
              </button>
              <button
                className="btn sm"
                onClick={() => fileRef.current?.click()}
                title="Import a matrix file: FlowJo .mtx, CytExpert .comp, FlowLogic or other text / CSV tables (channel names and values, fractions or %). Matrix files dropped on the window are imported too."
              >
                <Icon.open /> Import matrix...
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".mtx,.comp,.txt,.csv,.tsv,.xml"
                aria-label="Import compensation matrix"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length)
                    void importMatrixFiles(files).then((ids) => {
                      if (ids.length) setSelId(ids[ids.length - 1]);
                    });
                }}
              />
            </div>
          </div>
          <div className="card-head" style={{ borderTop: '1px solid var(--line)' }}>
            <h3>Samples</h3>
          </div>
          <div className="card-body" style={{ padding: '6px 10px' }}>
            {ws.samples.map((s) => (
              <div key={s.id} className="frow" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.25fr)' }}>
                <label>
                  <MiddleText text={s.name} />
                </label>
                {/* matrix names shortened in the middle ("Acquisition…15/10/2026"), the full name as tooltip */}
                <Sel
                  fit
                  value={s.compId ?? 'none'}
                  ariaLabel={`Compensation for ${s.name}`}
                  options={[{ value: 'none', label: 'Uncompensated' }, ...ws.compensations.map((c) => ({ value: c.id, label: c.name }))]}
                  onChange={(v) =>
                    st.update((w) => {
                      const x = w.samples.find((y) => y.id === s.id);
                      if (x) x.compId = v === 'none' ? null : v;
                    })
                  }
                />
              </div>
            ))}
            {comp && ws.samples.length > 0 && (
              <button
                className="btn sm"
                title={`Compensate all samples with "${comp.name}"`}
                onClick={() =>
                  st.update((w) => {
                    for (const s of w.samples) s.compId = comp.id;
                  })
                }
              >
                Use the selected matrix for all samples
              </button>
            )}
          </div>
        </div>

        {comp ? (
          <div className="card" style={{ minWidth: 0 }}>
            <div className="card-head">
              <input className="inp" style={{ width: 240 }} value={comp.name} aria-label="Matrix name" onChange={(e) => upComp((c) => {
                c.name = e.target.value;
              }, 'cn' + comp.id)} onKeyDown={(e) => e.stopPropagation()} />
              <span className="hint">Spillover in % (row = fluorochrome, column = detector). Click a cell to check it on the active sample.</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => void exportMatrixFile(comp, 'txt')} title="Tab-separated text: header row and first column of channel names, spillover as fractions (rows = fluorochromes). For FlowLogic, FlowJo and others.">
                <Icon.export /> Export TXT
              </button>
              <button className="btn sm" onClick={() => void exportMatrixFile(comp, 'csv')} title="Comma-separated: header row and first column of channel names, spillover as fractions (rows = fluorochromes)">
                <Icon.export /> Export CSV
              </button>
              <button
                className="btn sm"
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  st.update((w) => {
                    w.compensations = w.compensations.filter((c) => c.id !== comp.id);
                    for (const s of w.samples) if (s.compId === comp.id) s.compId = null;
                  });
                  setSelId(null);
                }}
              >
                Delete matrix
              </button>
            </div>
            <div className="card-body">
              {singular && <p style={{ color: 'var(--danger)', marginTop: 0 }}>This matrix cannot be inverted; compensation is not applied.</p>}
              <div className="tbl-wrap">
                <table className="data matrix">
                  <thead>
                    <tr>
                      <th className="left">Fluor \ Detector</th>
                      {comp.channels.map((c) => (
                        <th key={c} title={channelDisplayName(ws, c)}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comp.channels.map((r, i) => (
                      <tr key={r}>
                        <th className="left" title={channelDisplayName(ws, r)}>
                          {channelDisplayName(ws, r, 'both')}
                        </th>
                        {comp.channels.map((c, j) =>
                          i === j ? (
                            <td key={c} className="diag">
                              100
                            </td>
                          ) : (
                            <td key={c} style={{ background: cell && cell[0] === i && cell[1] === j ? 'var(--accent-soft)' : heat(comp.matrix[i][j]) }}>
                              <MatrixCell
                                value={comp.matrix[i][j] * 100}
                                onFocus={() => setCell([i, j])}
                                onChange={(v) => upComp((cc) => {
                                  cc.matrix[i][j] = v / 100;
                                  if (cc.source === 'file') cc.source = 'manual';
                                }, `m${comp.id}${i}_${j}`)}
                              />
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {cell && <CompPreview comp={comp} i={cell[0]} j={cell[1]} />}
              {!cell && <p className="hint">Tip: select a cell and use ↑/↓ (Shift = ×10) to adjust in 0.1 % steps while watching the preview.</p>}
              <div className="row" style={{ marginTop: 10 }}>
                <Check checked={showGrid} label="Show N×N plot matrix for the active sample" onChange={setShowGrid} />
              </div>
              {showGrid && <MatrixGrid comp={comp} onPick={(i, j) => setCell([i, j])} sel={cell} />}
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="card-body empty-note">
              {ws.samples.length
                ? 'No compensation matrix yet. Click New to start from an identity matrix, or From controls to compute one from single-stained controls.'
                : 'Open FCS files to create or edit compensation matrices. Matrices stored in the files are picked up automatically.'}
            </div>
          </div>
        )}
      </div>
      {ui.dialog?.kind === 'compWizard' && <CompWizard onClose={() => st.setUI({ dialog: null })} onCreated={(id) => setSelId(id)} />}
      {picking && (
        <NewMatrixDialog
          onClose={() => setPicking(false)}
          onCreate={(chans) => {
            setPicking(false);
            newMatrix(undefined, chans);
          }}
        />
      )}
    </div>
  );
}

function heat(v: number): string | undefined {
  const a = Math.min(1, Math.abs(v) * 3);
  if (a < 0.02) return undefined;
  return `rgba(232, 137, 12, ${(a * 0.35).toFixed(3)})`;
}

function MatrixCell({ value, onChange, onFocus }: { value: number; onChange: (v: number) => void; onFocus: () => void }) {
  const [s, setS] = useState<string | null>(null);
  const shown = s ?? (Math.abs(value) < 1e-9 ? '0' : value.toFixed(value < 1 ? 3 : 2));
  return (
    <input
      value={shown}
      aria-label="Spillover percent"
      inputMode="decimal"
      onFocus={onFocus}
      onChange={(e) => setS(e.target.value)}
      onBlur={() => {
        if (s !== null) {
          const v = parseFloat(s.replace(',', '.'));
          if (Number.isFinite(v)) onChange(v);
        }
        setS(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const d = (e.key === 'ArrowUp' ? 0.1 : -0.1) * (e.shiftKey ? 10 : 1);
          onChange(Math.round((value + d) * 1000) / 1000);
          setS(null);
        }
      }}
    />
  );
}

function CompPreview({ comp, i, j }: { comp: CompDef; i: number; j: number }) {
  const ws = useStore((s) => s.ws);
  const sid = useStore((s) => s.ui.activeSampleId);
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv || !sid) return;
    const W = 300,
      H = 270;
    const k = window.devicePixelRatio || 1;
    cv.width = W * k;
    cv.height = H * k;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    // preview the active sample with this matrix, whatever the sample currently uses
    const tmp: Workspace = { ...ws, samples: ws.samples.map((s) => (s.id === sid ? { ...s, compId: comp.id } : s)) };
    const item: PlotItem = {
      id: 'preview',
      kind: 'plot',
      plotType: 'pseudo',
      xParam: comp.channels[i],
      yParam: comp.channels[j],
      layers: [{ id: 'l', sample: sid, population: 'root' }],
      options: { ...defaultPlotOptions(), fontSize: 8, title: `${ws.samples.find((s) => s.id === sid)?.name ?? ''}: ${comp.channels[i]} into ${comp.channels[j]}`, showGates: false },
      x: 0,
      y: 0,
      w: W,
      h: H,
    };
    renderPlot(new CanvasPainter(ctx, k), item, W, H, {
      ws: tmp,
      engine,
      activeSampleId: sid,
      rasterScale: k,
      makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
    });
  }, [ws, sid, comp, i, j]);
  if (!sid) return <p className="hint">Select a sample to preview.</p>;
  return (
    <div style={{ marginTop: 12 }}>
      <canvas ref={ref} style={{ width: 300, height: 270, border: '1px solid var(--line)', borderRadius: 4 }} />
      <p className="hint" style={{ maxWidth: 520 }}>
        Correct compensation: the positive population for {comp.channels[i]} sits at the same {comp.channels[j]} level as the negatives (horizontal, not tilted up or down).
      </p>
    </div>
  );
}

function CompWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const ws = useStore((s) => s.ws);
  const st = useStore.getState();
  const fl = fluorChannels(ws);
  const loaded = ws.samples.filter((s) => engine.has(s.id));
  const guessUnstained = loaded.find((s) => /unstain|blank|neg|unst|ctrl/i.test(s.name))?.id ?? null;
  const [unstained, setUnstained] = useState<string | null>(guessUnstained);
  const [assign, setAssign] = useState<Record<string, string>>(() => {
    const a: Record<string, string> = {};
    for (const s of loaded) {
      if (s.id === guessUnstained) continue;
      const g = guessControlChannel(ws, engine, s.id, fl);
      if (g && /comp|single|stain|bead|control|-|_/i.test(s.name)) a[s.id] = g;
    }
    return a;
  });
  const [population, setPopulation] = useState(() => ws.populations.find((p) => p.parentId === null && p.gate.type !== 'bool')?.id ?? 'root');
  const [method, setMethod] = useState<'regression' | 'median'>('regression');
  // matrix the computed values are merged into: the one most samples use, else an acquisition matrix, else none
  const [baseId, setBaseId] = useState<string>(() => {
    const counts = new Map<string, number>();
    for (const s of ws.samples) if (s.compId && ws.compensations.some((c) => c.id === s.compId)) counts.set(s.compId, (counts.get(s.compId) ?? 0) + 1);
    const used = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return used ?? ws.compensations.find((c) => c.source === 'file')?.id ?? 'none';
  });
  const base = baseId === 'none' ? null : ws.compensations.find((c) => c.id === baseId) ?? null;
  const assigned = [...new Set(Object.values(assign).filter(Boolean))];
  const keptDet = base ? base.channels.filter((c) => !assigned.includes(c)) : [];
  // detectors of the samples' current matrix that a control-only matrix would drop
  const current = ws.compensations.find((c) => c.id === ws.samples.find((s) => s.compId)?.compId);
  const dropped = !base && current ? current.channels.filter((c) => !assigned.includes(c)) : [];
  const [apply, setApply] = useState(true);
  const [result, setResult] = useState<string | null>(null);

  const run = () => {
    const controls = Object.entries(assign)
      .filter(([, ch]) => !!ch)
      .map(([sampleId, channel]) => ({ sampleId, channel }));
    const seen = new Set<string>();
    for (const c of controls) {
      if (seen.has(c.channel)) {
        setResult(`Two controls are assigned to ${c.channel}. Each detector needs exactly one control.`);
        return;
      }
      seen.add(c.channel);
    }
    if (controls.length < 2) {
      setResult('Assign at least two single-stained controls.');
      return;
    }
    const res = computeSpillover(ws, engine, controls, { population, unstainedId: unstained, method });
    const merged = mergeSpillover(base, res);
    const id = uid('comp');
    const date = new Date().toLocaleDateString('en-GB');
    st.update((w) => {
      w.compensations.push({ id, name: base ? `${base.name} + controls ${date}` : `Computed ${date}`, channels: merged.channels, matrix: merged.matrix, source: 'computed' });
      if (apply) for (const s of w.samples) s.compId = id;
    });
    onCreated(id);
    const note = base && merged.kept.length ? ` ${merged.kept.length} detector${merged.kept.length > 1 ? 's' : ''} without a control kept from "${base.name}".` : '';
    if (res.warnings.length) st.toast(res.warnings.join(' · ') + note, 'info');
    else st.toast(`Spillover matrix computed.${note}`, 'success');
    onClose();
  };

  return (
    <Modal
      wide
      title="Compute compensation from single-stained controls"
      onClose={onClose}
      footer={
        <>
          {result && <span style={{ color: 'var(--danger)', marginRight: 'auto', fontSize: 12.5 }}>{result}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={run}>
            Compute matrix
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Assign each single-stained control to its detector. Positive events are those brighter than 99.5 % of the negative reference. <b>Robust regression</b> fits the slope of each detector against the primary detector within the positives (insensitive to autofluorescence differences); <b>median difference</b> uses (median positive − median negative) ratios. Restrict to a scatter gate (cells or beads) for best results.
      </p>
      <div className="frow" style={{ gridTemplateColumns: '170px 1fr' }}>
        <label>Method</label>
        <div>
          <Seg value={method} options={[{ value: 'regression', label: 'Robust regression' }, { value: 'median', label: 'Median difference' }]} onChange={setMethod} />
        </div>
      </div>
      <div className="frow" style={{ gridTemplateColumns: '170px 1fr' }}>
        <label>Negative reference</label>
        <Sel value={unstained ?? 'none'} ariaLabel="Unstained control" options={[{ value: 'none', label: 'Internal negatives of each control' }, ...loaded.map((s) => ({ value: s.id, label: s.name }))]} onChange={(v) => setUnstained(v === 'none' ? null : v)} />
      </div>
      <div className="frow" style={{ gridTemplateColumns: '170px 1fr' }}>
        <label>Merge into</label>
        <Sel
          value={baseId}
          ariaLabel="Matrix to merge the computed values into"
          options={[
            ...ws.compensations.map((c) => ({ value: c.id, label: `${c.name} (${c.channels.length} detectors, ${c.source === 'file' ? 'acquisition' : c.source})` })),
            { value: 'none', label: 'Nothing: a new matrix of the control detectors only' },
          ]}
          onChange={setBaseId}
        />
      </div>
      {base && keptDet.length > 0 && (
        <p className="hint" style={{ margin: '0 0 6px 170px' }}>
          {keptDet.length} detector{keptDet.length > 1 ? 's' : ''} without a control keep their values from &quot;{base.name}&quot;: {keptDet.slice(0, 8).join(', ')}
          {keptDet.length > 8 ? ` and ${keptDet.length - 8} more` : ''}.
        </p>
      )}
      {!base && dropped.length > 0 && (
        <p className="hint" style={{ margin: '0 0 6px 170px', color: 'var(--danger)' }}>
          The new matrix covers only the {assigned.length} control detectors. These detectors of &quot;{current!.name}&quot; would be left uncompensated: {dropped.slice(0, 8).join(', ')}
          {dropped.length > 8 ? ` and ${dropped.length - 8} more` : ''}. Merge into that matrix to keep them.
        </p>
      )}
      <div className="frow" style={{ gridTemplateColumns: '170px 1fr' }}>
        <label>Use events in</label>
        <Sel value={population} ariaLabel="Population" options={[{ value: 'root', label: 'All Events' }, ...ws.populations.filter((p) => p.gate.type !== 'bool').map((p) => ({ value: p.id, label: popPath(ws, p.id) }))]} onChange={setPopulation} />
      </div>
      <div className="tbl-wrap" style={{ maxHeight: 320, overflow: 'auto', marginTop: 6 }}>
        <table className="data" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th className="left">Sample</th>
              <th className="left">Detector of the stain</th>
            </tr>
          </thead>
          <tbody>
            {loaded.map((s) => (
              <tr key={s.id}>
                <td className="left">{s.name}</td>
                <td className="left">
                  {s.id === unstained ? (
                    <span className="hint">Unstained reference</span>
                  ) : (
                    <Sel
                      value={assign[s.id] ?? ''}
                      ariaLabel={`Detector for ${s.name}`}
                      options={[{ value: '', label: 'Not a control' }, ...fl.map((c) => ({ value: c, label: channelDisplayName(ws, c) }))]}
                      onChange={(v) => setAssign({ ...assign, [s.id]: v })}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8 }}>
        <Check checked={apply} label="Apply the new matrix to all samples" onChange={setApply} />
      </div>
    </Modal>
  );
}

/** All pairwise plots (x = fluorochrome's detector, y = other detector) of the active sample under this matrix. */
const GRID_MAX = 12;

function MatrixGrid({ comp, onPick, sel }: { comp: CompDef; onPick: (i: number, j: number) => void; sel: [number, number] | null }) {
  const ws = useStore((s) => s.ws);
  const sid = useStore((s) => s.ui.activeSampleId);
  const ref = useRef<HTMLCanvasElement>(null);
  // the grid shows up to GRID_MAX channels (n² plots); with more, the user chooses which
  const [chosen, setChosen] = useState<string[]>(() => comp.channels.slice(0, GRID_MAX));
  useEffect(() => setChosen(comp.channels.slice(0, GRID_MAX)), [comp.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownIdx = useMemo(() => comp.channels.map((c, i) => (chosen.includes(c) ? i : -1)).filter((i) => i >= 0).slice(0, GRID_MAX), [comp.channels, chosen]);
  const n = shownIdx.length;
  const C = 118;
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv || !sid) return;
    const k = window.devicePixelRatio || 1;
    const W = C * n + 20;
    cv.width = W * k;
    cv.height = W * k;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, W);
    const tmp: Workspace = { ...ws, samples: ws.samples.map((s) => (s.id === sid ? { ...s, compId: comp.id } : s)) };
    const p = new CanvasPainter(ctx, k);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        if (r === c) {
          ctx.fillStyle = '#5a6878';
          ctx.font = '10px Arial, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(comp.channels[shownIdx[c]], 20 + c * C + C / 2, r * C + C / 2);
          continue;
        }
        const item: PlotItem = {
          id: 'm',
          kind: 'plot',
          plotType: 'pseudo',
          xParam: comp.channels[shownIdx[c]],
          yParam: comp.channels[shownIdx[r]],
          layers: [{ id: 'l', sample: sid, population: 'root' }],
          options: { ...defaultPlotOptions(), fontSize: 4.5, showTitle: false, showGates: false, xLabel: '', yLabel: '', maxEvents: 20000 },
          x: 0,
          y: 0,
          w: C,
          h: C,
        };
        ctx.save();
        ctx.translate(20 + c * C, r * C);
        renderPlot(p, item, C, C, { ws: tmp, engine, activeSampleId: sid, rasterScale: k, makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }) });
        if (sel && sel[0] === shownIdx[c] && sel[1] === shownIdx[r]) {
          ctx.strokeStyle = '#e8890c';
          ctx.lineWidth = 3;
          ctx.strokeRect(1.5, 1.5, C - 3, C - 3);
        }
        ctx.restore();
      }
  }, [ws, sid, comp, n, sel, shownIdx]);
  if (!sid) return <p className="hint">Select a sample to show the plot matrix.</p>;
  return (
    <div className="tbl-wrap" style={{ marginTop: 8 }}>
      {comp.channels.length > GRID_MAX && (
        <div style={{ marginBottom: 6 }}>
          <p className="hint" style={{ margin: '0 0 4px' }}>
            The plot matrix shows at most {GRID_MAX} of the {comp.channels.length} channels ({n} chosen). Choose the channels to show:
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            {comp.channels.map((c) => {
              const on = chosen.includes(c);
              return (
                <label key={c} className="check" style={{ opacity: !on && chosen.length >= GRID_MAX ? 0.5 : 1 }}>
                  <input type="checkbox" checked={on} disabled={!on && chosen.length >= GRID_MAX} onChange={(e) => setChosen(e.target.checked ? [...chosen, c] : chosen.filter((x) => x !== c))} /> {c}
                </label>
              );
            })}
          </div>
        </div>
      )}
      <canvas
        ref={ref}
        style={{ width: C * n + 20, height: C * n + 20, cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 4 }}
        onClick={(e) => {
          const r0 = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const c = Math.floor((e.clientX - r0.left - 20) / C);
          const r = Math.floor((e.clientY - r0.top) / C);
          if (c >= 0 && r >= 0 && c < n && r < n && c !== r) onPick(shownIdx[c], shownIdx[r]);
        }}
      />
      <p className="hint">Column = fluorochrome (x axis), row = detector (y axis). Click a plot to edit that spillover value above.</p>
    </div>
  );
}

/** Channel picker for a new (identity) matrix: on instruments with many detectors (e.g. 81) only the used ones. */
function NewMatrixDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (channels: string[]) => void }) {
  const ws = useStore((s) => s.ws);
  const activeId = useStore((s) => s.ui.activeSampleId);
  const all = fluorChannels(ws);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<string[]>(() => {
    if (all.length <= 16) return all;
    // many detectors: start from the acquisition matrix of the active sample, if any
    const acq = activeId ? engine.fileCompOf(activeId)?.channels.filter((c) => all.includes(c)) : undefined;
    return acq?.length ? acq : [];
  });
  const shown = all.filter((c) => !filter || `${c} ${channelDisplayName(ws, c)}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal
      title="New compensation matrix"
      onClose={onClose}
      footer={
        <>
          <span className="hint" style={{ marginRight: 'auto' }}>
            {sel.length} of {all.length} detectors
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={sel.length < 2} onClick={() => onCreate(all.filter((c) => sel.includes(c)))}>
            Create {sel.length}×{sel.length} matrix
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Choose the detectors of the fluorochromes in your panel. The matrix starts as identity (no spillover); enter the values or compute them from controls.
      </p>
      <div className="row" style={{ marginBottom: 6 }}>
        <input className="inp" style={{ flex: 1 }} placeholder="Filter detectors" aria-label="Filter detectors" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn sm" onClick={() => setSel([...new Set([...sel, ...shown])])}>
          Select shown
        </button>
        <button className="btn sm" onClick={() => setSel(sel.filter((c) => !shown.includes(c)))}>
          Clear shown
        </button>
      </div>
      <div style={{ maxHeight: 340, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '2px 10px' }}>
        {shown.map((c) => (
          <label key={c} className="check" title={channelDisplayName(ws, c)}>
            <input type="checkbox" checked={sel.includes(c)} onChange={(e) => setSel(e.target.checked ? [...sel, c] : sel.filter((x) => x !== c))} /> {channelDisplayName(ws, c)}
          </label>
        ))}
        {!shown.length && <span className="hint">No detector matches.</span>}
      </div>
    </Modal>
  );
}
