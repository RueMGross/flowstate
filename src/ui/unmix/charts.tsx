// SVG charts of the unmixing view: reference spectra (lines or heatmap), matrix heatmaps and sparklines.
// Colours are CSS variables (see unmix.css), so light and dark themes switch without re-rendering.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DetectorGroup } from './helpers';

// ------------------------------------------------------------------ colours

const DASHES = ['', '6 3', '2 3', '8 3 2 3'];

/** Series colour of a slot: 8 categorical hues; beyond 8 the hue repeats with a different dash (composite encoding). */
export function slotColor(slot: number | 'af'): string {
  return slot === 'af' ? 'var(--um-af)' : `var(--um-s${(slot % 8) + 1})`;
}
export function slotDash(slot: number | 'af', afIndex = 0): string {
  return slot === 'af' ? ['4 3', '1 3', '6 2 1 2'][afIndex % 3] : DASHES[Math.floor(slot / 8) % DASHES.length];
}

const mix = (hi: string, lo: string, p: number) => `color-mix(in oklab, var(${hi}) ${Math.round(Math.max(0, Math.min(1, p)) * 100)}%, var(${lo}))`;

export type Ramp = 'seq' | 'org' | 'div';

/** Cell fill and ink for a value in [0, 1] (sequential) or [-1, 1] (diverging). */
export function rampColor(ramp: Ramp, t: number): { fill: string; ink: string } {
  if (ramp === 'div') {
    const a = Math.min(1, Math.abs(t));
    return { fill: mix(t < 0 ? '--um-div-neg' : '--um-div-pos', '--um-div-mid', a * 0.92), ink: a > 0.6 ? 'var(--um-div-ink)' : 'var(--text)' };
  }
  const hi = ramp === 'seq' ? '--um-seq-hi' : '--um-org-hi';
  const lo = ramp === 'seq' ? '--um-seq-lo' : '--um-org-lo';
  return { fill: mix(hi, lo, t), ink: t > 0.55 ? `var(${ramp === 'seq' ? '--um-seq-ink' : '--um-org-ink'})` : 'var(--text)' };
}

export function rampGradient(ramp: Ramp): string {
  if (ramp === 'div') return 'linear-gradient(90deg, var(--um-div-neg), var(--um-div-mid), var(--um-div-pos))';
  return ramp === 'seq' ? 'linear-gradient(90deg, var(--um-seq-lo), var(--um-seq-hi))' : 'linear-gradient(90deg, var(--um-org-lo), var(--um-org-hi))';
}

// ------------------------------------------------------------------ helpers

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Common detector suffix ("-A") dropped from axis labels when every detector has it. */
export function shortDetectorNames(dets: string[]): string[] {
  if (dets.length && dets.every((d) => /-A$/.test(d))) return dets.map((d) => d.slice(0, -2));
  return dets;
}

const fmt3 = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3)) : '–');

function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 160, h: 60 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  const left = x + 14 + size.w > w ? Math.max(0, x - 14 - size.w) : x + 14;
  return (
    <div ref={ref} className="um-tip" style={{ left, top: Math.max(0, y - size.h / 2) }}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ spectra

export interface SpectrumSeries {
  key: string;
  name: string;
  values: number[];
  slot: number | 'af';
  afIndex?: number;
  note?: string;
}

/** Normalised spectra across the detector axis (lines with markers, laser bands, hover readout, legend). */
/** Detector display order: laser groups in order, file order within a group (indices into `detectors`). */
export function groupOrder(detectors: string[], groups: DetectorGroup[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const g of groups)
    for (const d of g.detectors) {
      const i = detectors.indexOf(d);
      if (i >= 0 && !seen.has(i)) {
        seen.add(i);
        out.push(i);
      }
    }
  detectors.forEach((_, i) => !seen.has(i) && out.push(i));
  return out;
}

export function SpectraPlot({ detectors: detIn, groups, series: seriesIn, mode }: { detectors: string[]; groups: DetectorGroup[]; series: SpectrumSeries[]; mode: 'lines' | 'heatmap' }) {
  const order = useMemo(() => groupOrder(detIn, groups), [detIn, groups]);
  const detectors = useMemo(() => order.map((i) => detIn[i]), [order, detIn]);
  const series = useMemo(() => seriesIn.map((s) => ({ ...s, values: order.map((i) => s.values[i]) })), [seriesIn, order]);
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState<{ i: number; px: number; py: number; s: string | null } | null>(null);
  const short = useMemo(() => shortDetectorNames(detectors), [detectors]);
  const D = detectors.length;
  const vis = series.filter((s) => !hidden.has(s.key));
  const maxLab = Math.max(3, ...short.map((s) => s.length));
  const fs = 10;
  const ml = mode === 'heatmap' ? Math.min(150, 14 + 6.6 * Math.max(4, ...series.map((s) => s.name.length))) : 40;
  const mr = 10;
  const mt = 22;
  const pw = Math.max(50, W - ml - mr);
  const step = pw / Math.max(1, D);
  const rotate = step < maxLab * 6.2 + 4;
  const mb = rotate ? Math.min(96, maxLab * 5.4 + 14) : 22;
  const every = Math.max(1, Math.ceil((rotate ? 11.5 : maxLab * 6.4 + 6) / step));
  const rowH = mode === 'heatmap' ? Math.max(12, Math.min(22, 240 / Math.max(1, series.length))) : 0;
  const ph = mode === 'heatmap' ? rowH * series.length : 230;
  const H = mt + ph + mb;
  let ymin = 0;
  for (const s of vis) for (const v of s.values) if (v < ymin) ymin = v;
  ymin = Math.max(-0.5, Math.floor(ymin * 10) / 10);
  const ymax = 1.05;
  const X = (i: number) => ml + (i + 0.5) * step;
  const Y = (v: number) => mt + ph - ((v - ymin) / (ymax - ymin)) * ph;
  const groupSpans = useMemo(() => {
    const out: { label: string; id: string; a: number; b: number }[] = [];
    for (const g of groups) {
      const idx = g.detectors.map((d) => detectors.indexOf(d)).filter((i) => i >= 0);
      if (!idx.length) continue;
      out.push({ label: g.label, id: g.id, a: Math.min(...idx), b: Math.max(...idx) });
    }
    return out.sort((p, q) => p.a - q.a);
  }, [groups, detectors]);
  const active = hover?.s ?? focus;
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const i = Math.max(0, Math.min(D - 1, Math.floor((px - ml) / step)));
    let s: string | null = null;
    if (mode === 'heatmap') {
      const row = Math.floor((py - mt) / rowH);
      s = series[row]?.key ?? null;
    } else {
      let best = 12;
      for (const ser of vis) {
        const d = Math.abs(Y(ser.values[i]) - py);
        if (d < best) {
          best = d;
          s = ser.key;
        }
      }
    }
    setHover({ i, px, py, s });
  };
  const yTicks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t >= ymin);
  if (ymin < 0) yTicks.unshift(ymin);
  const markers = step >= 7;
  const tipRows = hover
    ? (mode === 'heatmap' ? series.filter((s) => s.key === hover.s) : vis)
        .map((s) => ({ s, v: s.values[hover.i] }))
        .sort((a, b) => b.v - a.v)
    : [];
  return (
    <div className="um-chart" ref={ref}>
      {W > 0 && D > 0 && (
        <svg width={W} height={H} role="img" aria-label={`Normalised reference spectra of ${series.length} endmembers over ${D} detectors`}>
          {/* laser bands */}
          {groupSpans.map((g, k) => (
            <g key={g.id}>
              {k % 2 === 0 && <rect x={ml + g.a * step} y={mt - 18} width={(g.b - g.a + 1) * step} height={ph + 18} style={{ fill: 'var(--um-band)' }} />}
              {k > 0 && <line x1={ml + g.a * step} x2={ml + g.a * step} y1={mt - 18} y2={mt + ph} style={{ stroke: 'var(--um-axis)' }} strokeWidth={1} />}
              <text x={ml + ((g.a + g.b + 1) / 2) * step} y={mt - 7} textAnchor="middle" style={{ fill: 'var(--text-3)', fontSize: 10.5, fontWeight: 600 }}>
                {(g.b - g.a + 1) * step > g.label.length * 6.4 + 6 ? g.label : g.id === 'other' ? '' : g.id}
              </text>
            </g>
          ))}
          {mode === 'lines' ? (
            <>
              <g className="ax">
                {yTicks.map((t) => (
                  <g key={t}>
                    <line x1={ml} x2={ml + pw} y1={Y(t)} y2={Y(t)} style={{ stroke: t === 0 ? 'var(--um-axis)' : 'var(--um-grid)' }} strokeWidth={1} />
                    <text x={ml - 6} y={Y(t) + 3.5} textAnchor="end">
                      {t.toFixed(t === 0 || t === 1 ? 0 : 2)}
                    </text>
                  </g>
                ))}
              </g>
              {vis.map((s) => {
                const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
                const dim = active && active !== s.key;
                const on = active === s.key;
                return (
                  <g key={s.key} style={{ opacity: dim ? 0.18 : 1, transition: 'opacity 120ms' }}>
                    <path d={d} fill="none" style={{ stroke: slotColor(s.slot) }} strokeWidth={on ? 2.6 : 1.8} strokeDasharray={slotDash(s.slot, s.afIndex)} strokeLinejoin="round" />
                    {markers &&
                      s.values.map((v, i) => <circle key={i} cx={X(i)} cy={Y(v)} r={on ? 3 : 2.2} style={{ fill: slotColor(s.slot), stroke: 'var(--panel)' }} strokeWidth={1} />)}
                  </g>
                );
              })}
              {hover && (
                <g pointerEvents="none">
                  <line x1={X(hover.i)} x2={X(hover.i)} y1={mt} y2={mt + ph} style={{ stroke: 'var(--text-3)' }} strokeWidth={1} />
                  {vis.map((s) => (
                    <circle key={s.key} cx={X(hover.i)} cy={Y(s.values[hover.i])} r={active === s.key ? 4.5 : 3.2} style={{ fill: slotColor(s.slot), stroke: 'var(--panel)' }} strokeWidth={2} />
                  ))}
                </g>
              )}
            </>
          ) : (
            <g>
              {series.map((s, r) => (
                <g key={s.key}>
                  <text x={ml - 8} y={mt + r * rowH + rowH / 2 + 3.5} textAnchor="end" style={{ fill: active === s.key ? 'var(--text)' : 'var(--text-2)', fontWeight: active === s.key ? 600 : 400 }}>
                    {s.name}
                  </text>
                  <rect x={ml - 6} y={mt + r * rowH + rowH / 2 - 1} width={4} height={2} style={{ fill: slotColor(s.slot) }} />
                  {s.values.map((v, i) => (
                    <rect key={i} x={ml + i * step} y={mt + r * rowH} width={Math.max(0.5, step - (step > 4 ? 1 : 0))} height={rowH - 1} style={{ fill: rampColor('seq', v).fill }} />
                  ))}
                </g>
              ))}
              {hover && hover.s && (
                <rect
                  x={ml + hover.i * step - 0.5}
                  y={mt + series.findIndex((s) => s.key === hover.s) * rowH - 0.5}
                  width={step}
                  height={rowH}
                  fill="none"
                  style={{ stroke: 'var(--text)' }}
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
              )}
            </g>
          )}
          {/* detector axis */}
          <g className="ax">
            {short.map((n, i) =>
              i % every === 0 || (hover && hover.i === i) ? (
                <text
                  key={i}
                  x={rotate ? 0 : X(i)}
                  y={rotate ? 0 : mt + ph + 14}
                  textAnchor={rotate ? 'end' : 'middle'}
                  transform={rotate ? `translate(${X(i) + 3},${mt + ph + 8}) rotate(-60)` : undefined}
                  style={hover && hover.i === i ? { fill: 'var(--text)', fontWeight: 600 } : undefined}
                >
                  {n}
                </text>
              ) : null,
            )}
          </g>
          <rect x={ml} y={mt - 18} width={pw} height={ph + 18} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hover && W > 0 && tipRows.length > 0 && (
        <Tip x={hover.px} y={hover.py} w={W}>
          <div className="t">{detectors[hover.i]}</div>
          {tipRows.slice(0, 10).map(({ s, v }) => (
            <div key={s.key} className={`r${active === s.key ? ' on' : ''}`}>
              <svg width="14" height="8">
                <line x1="0" x2="14" y1="4" y2="4" style={{ stroke: slotColor(s.slot) }} strokeWidth={2.5} strokeDasharray={slotDash(s.slot, s.afIndex)} />
              </svg>
              <span>{s.name}</span>
              <span className="v">{v.toFixed(3)}</span>
            </div>
          ))}
          {tipRows.length > 10 && <div className="um-sub">{tipRows.length - 10} more below 10th</div>}
        </Tip>
      )}
      {mode === 'lines' && series.length > 0 && (
        <div className="um-legend" role="list" aria-label="Endmembers">
          {series.map((s) => (
            <button
              key={s.key}
              role="listitem"
              className={`${hidden.has(s.key) ? 'off' : ''}${focus === s.key ? ' focus' : ''}`}
              title={`${s.note ? s.note + '. ' : ''}Click to ${hidden.has(s.key) ? 'show' : 'hide'}`}
              onMouseEnter={() => setFocus(s.key)}
              onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus(s.key)}
              onBlur={() => setFocus(null)}
              onClick={() =>
                setHidden((h) => {
                  const n = new Set(h);
                  if (n.has(s.key)) n.delete(s.key);
                  else n.add(s.key);
                  return n;
                })
              }
            >
              <svg viewBox="0 0 20 8">
                <line x1="0" x2="20" y1="4" y2="4" style={{ stroke: slotColor(s.slot) }} strokeWidth={2.5} strokeDasharray={slotDash(s.slot, s.afIndex)} />
                <circle cx="10" cy="4" r="2.6" style={{ fill: slotColor(s.slot), stroke: 'var(--panel)' }} strokeWidth={1} />
              </svg>
              {s.name}
              {s.note && <span className="um-sub">({s.note})</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ matrix heatmap

export interface MatrixCell {
  v: number | null;
  /** text in the cell; null = value hidden */
  text?: string;
  /** 0..1 (seq) or -1..1 (div) position on the ramp */
  t?: number;
  flag?: boolean;
}

export function MatrixHeatmap({
  rows,
  cols,
  cells,
  ramp,
  rowSlots,
  tip,
  label,
  maxCell = 40,
}: {
  rows: string[];
  cols: string[];
  cells: MatrixCell[][];
  ramp: Ramp;
  rowSlots?: (number | 'af')[];
  tip: (i: number, j: number) => string;
  label: string;
  maxCell?: number;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; j: number; px: number; py: number } | null>(null);
  const lw = Math.min(120, 16 + 6.4 * Math.max(3, ...rows.map((r) => r.length)));
  const colLen = Math.max(3, ...cols.map((c) => c.length));
  const cell = Math.max(12, Math.min(maxCell, Math.floor((Math.max(80, W) - lw - 14) / Math.max(1, cols.length))));
  const rotate = cell < colLen * 6.2 + 6;
  const th = rotate ? Math.min(90, colLen * 4.6 + 12) : 18;
  const w = lw + cols.length * cell + 4;
  const h = th + rows.length * cell + 2;
  const showText = cell >= 27;
  return (
    <div className="um-chart" ref={ref}>
      {W > 0 && (
        <svg width={w} height={h} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
          {cols.map((c, j) => (
            <text
              key={j}
              x={rotate ? 0 : lw + j * cell + cell / 2}
              y={rotate ? 0 : th - 6}
              textAnchor={rotate ? 'start' : 'middle'}
              transform={rotate ? `translate(${lw + j * cell + cell / 2 + 3},${th - 4}) rotate(-50)` : undefined}
              style={{ fontWeight: hover?.j === j ? 600 : 400, fill: hover?.j === j ? 'var(--text)' : 'var(--text-2)' }}
            >
              {c}
            </text>
          ))}
          {rows.map((r, i) => (
            <g key={i}>
              {rowSlots && <rect x={2} y={th + i * cell + cell / 2 - 4} width={8} height={8} rx={4} style={{ fill: slotColor(rowSlots[i]) }} />}
              <text x={lw - 6} y={th + i * cell + cell / 2 + 3.5} textAnchor="end" style={{ fontWeight: hover?.i === i ? 600 : 400, fill: hover?.i === i ? 'var(--text)' : 'var(--text-2)' }}>
                {r}
              </text>
              {cells[i].map((c, j) => {
                const col = c.v === null || c.t === undefined ? null : rampColor(ramp, c.t);
                return (
                  <g key={j} onPointerEnter={(e) => {
                    const rr = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setHover({ i, j, px: e.clientX - rr.left, py: e.clientY - rr.top });
                  }}>
                    <rect x={lw + j * cell + 1} y={th + i * cell + 1} width={cell - 2} height={cell - 2} rx={2} style={{ fill: col ? col.fill : 'var(--panel-sunk)' }} />
                    {c.v === null && <line x1={lw + j * cell + 5} y1={th + (i + 1) * cell - 5} x2={lw + (j + 1) * cell - 5} y2={th + i * cell + 5} style={{ stroke: 'var(--line-strong)' }} strokeWidth={1} />}
                    {c.flag && <rect x={lw + j * cell + 2} y={th + i * cell + 2} width={cell - 4} height={cell - 4} rx={2} fill="none" style={{ stroke: 'var(--um-crit)' }} strokeWidth={2} />}
                    {showText && (c.text ?? null) !== null && (
                      <text x={lw + j * cell + cell / 2} y={th + i * cell + cell / 2 + 3.5} textAnchor="middle" style={{ fill: col ? col.ink : 'var(--text-3)', fontSize: cell >= 34 ? 10.5 : 9.5, fontWeight: c.flag ? 700 : 400, fontVariantNumeric: 'tabular-nums' }}>
                        {c.text}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          ))}
          {hover && <rect x={lw + hover.j * cell + 0.5} y={th + hover.i * cell + 0.5} width={cell - 1} height={cell - 1} rx={2} fill="none" style={{ stroke: 'var(--text)' }} strokeWidth={1.5} pointerEvents="none" />}
        </svg>
      )}
      {hover && W > 0 && (
        <Tip x={hover.px} y={hover.py} w={W}>
          <div>{tip(hover.i, hover.j)}</div>
        </Tip>
      )}
    </div>
  );
}

/** Color ramp with its end values; `mid` (e.g. "0" of a diverging ramp) sits under the middle of the bar. */
export function RampLegend({ ramp, lo, hi, mid, extra }: { ramp: Ramp; lo: string; hi: string; mid?: string; extra?: ReactNode }) {
  return (
    <div className="um-scale" style={mid ? { paddingBottom: 12 } : undefined}>
      <span>{lo}</span>
      <span className="bar" style={{ background: rampGradient(ramp), position: 'relative' }}>
        {mid && (
          <>
            <span aria-hidden="true" style={{ position: 'absolute', left: '50%', top: '100%', width: 1, height: 3, background: 'currentColor', transform: 'translateX(-0.5px)' }} />
            <span style={{ position: 'absolute', left: '50%', top: 'calc(100% + 2px)', transform: 'translateX(-50%)', lineHeight: 1.1, whiteSpace: 'nowrap' }}>{mid}</span>
          </>
        )}
      </span>
      <span>{hi}</span>
      {extra}
    </div>
  );
}

// ------------------------------------------------------------------ sparkline

export function Sparkline({ values: vIn, slot, peak: pIn, order, w = 92, h = 26, groupsAt = [] }: { values: number[] | null | undefined; slot: number | 'af'; peak?: number; order?: number[]; w?: number; h?: number; groupsAt?: number[] }) {
  const values = vIn && order && order.length === vIn.length ? order.map((i) => vIn[i]) : vIn;
  const peak = pIn !== undefined && order && vIn && order.length === vIn.length ? order.indexOf(pIn) : pIn;
  if (!values || !values.length)
    return (
      <svg width={w} height={h} aria-hidden="true">
        <line x1={2} x2={w - 2} y1={h - 3} y2={h - 3} style={{ stroke: 'var(--line-strong)' }} strokeDasharray="2 3" />
      </svg>
    );
  const n = values.length;
  const lo = Math.min(0, ...values);
  const X = (i: number) => 2 + (i / Math.max(1, n - 1)) * (w - 4);
  const Y = (v: number) => h - 3 - ((v - lo) / (1 - lo || 1)) * (h - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  return (
    <svg width={w} height={h} role="img" aria-label="Spectrum">
      {groupsAt.map((g) => (
        <line key={g} x1={X(g - 0.5)} x2={X(g - 0.5)} y1={2} y2={h - 2} style={{ stroke: 'var(--line)' }} strokeWidth={1} />
      ))}
      <line x1={2} x2={w - 2} y1={Y(0)} y2={Y(0)} style={{ stroke: 'var(--line)' }} strokeWidth={1} />
      <path d={d} fill="none" style={{ stroke: slotColor(slot) }} strokeWidth={1.5} strokeLinejoin="round" />
      {peak !== undefined && peak >= 0 && peak < n && <circle cx={X(peak)} cy={Y(values[peak])} r={2.5} style={{ fill: slotColor(slot), stroke: 'var(--panel)' }} strokeWidth={1} />}
    </svg>
  );
}

export { fmt3 };
