// Small SVG charts for the calibration view (themed through CSS classes in calib.css).
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { computeTicks, formatLinear, makeScale, windowScale, type ScaleDef } from '../../core/transforms';

export function useWidth<T extends HTMLElement>(fallback = 480): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = () => setW(Math.max(160, el.clientWidth));
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------------------------------------------------------------- ticks

interface AxisTick {
  v: number;
  major: boolean;
  label?: ReactNode;
}

function supLabel(e: number): ReactNode {
  return (
    <>
      10<tspan dy="-0.45em" fontSize="0.78em">{e}</tspan>
    </>
  );
}

function plainLog(v: number): string {
  if (v >= 1e4) return formatLinear(v, v);
  if (v >= 1) return String(Math.round(v));
  return String(Number(v.toPrecision(1)));
}

export function logTicks(min: number, max: number): AxisTick[] {
  const out: AxisTick[] = [];
  if (!(min > 0) || !(max > min)) return out;
  const e0 = Math.floor(Math.log10(min));
  const e1 = Math.ceil(Math.log10(max));
  const plain = e1 - e0 <= 4 && min >= 0.01 && max <= 1e6;
  const step = e1 - e0 > 10 ? 2 : 1;
  for (let e = e0; e <= e1; e++) {
    for (let m = 1; m <= 9; m++) {
      const v = m * Math.pow(10, e);
      if (v < min * (1 - 1e-9) || v > max * (1 + 1e-9)) continue;
      if (m === 1) out.push({ v, major: true, label: (e - e0) % step === 0 ? (plain ? plainLog(v) : supLabel(e)) : undefined });
      else if (e1 - e0 <= 7) out.push({ v, major: false, label: plain && Math.log10(max / min) <= 2.5 && (m === 2 || m === 5) ? plainLog(v) : undefined });
    }
  }
  return out;
}

export function linTicks(min: number, max: number, target = 6): AxisTick[] {
  const span = max - min;
  if (!(span > 0)) return [];
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  const out: AxisTick[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    const vv = Math.abs(v) < step * 1e-9 ? 0 : v;
    out.push({ v: vv, major: true, label: formatLinear(vv, step) });
  }
  return out;
}

// ---------------------------------------------------------------- generic XY chart

export interface AxisSpec {
  type: 'lin' | 'log';
  min: number;
  max: number;
  title: string;
}

export interface XYSeries {
  kind: 'line' | 'points';
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** CSS color (var(--accent) ...) */
  color: string;
  dash?: string;
  width?: number;
  r?: number;
  /** per point: hollow marker (e.g. excluded) */
  hollow?: ArrayLike<boolean>;
  /** per point tooltip */
  tips?: string[];
  /** per point short label drawn next to the marker */
  labels?: string[];
}

export interface ChartAnno {
  bands?: { x0: number; x1: number; className?: string; label?: string }[];
  vlines?: { x: number; color: string; dash?: string; label?: string }[];
  hlines?: { y: number; color: string; dash?: string; label?: string }[];
}

export interface LegendEntry {
  name: string;
  color: string;
  dash?: string;
  marker?: 'dot' | 'ring' | 'line';
}

export function XYChart({ x, y, series, anno, legend, height = 240, ariaLabel, children }: { x: AxisSpec; y: AxisSpec; series: XYSeries[]; anno?: ChartAnno; legend?: LegendEntry[]; height?: number; ariaLabel: string; children?: ReactNode }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const m = { l: 54, r: 12, t: 10, b: 36 };
  const pw = Math.max(40, W - m.l - m.r);
  const ph = Math.max(40, height - m.t - m.b);
  const fx = mapper(x, m.l, m.l + pw);
  const fy = mapper(y, m.t + ph, m.t);
  const xt = x.type === 'log' ? logTicks(x.min, x.max) : linTicks(x.min, x.max, Math.max(3, Math.round(pw / 70)));
  const yt = y.type === 'log' ? logTicks(y.min, y.max) : linTicks(y.min, y.max, Math.max(3, Math.round(ph / 40)));
  const clipId = useRef(`cc${Math.random().toString(36).slice(2, 8)}`).current;
  return (
    <div ref={ref} className="cc-chart">
      <svg width={W} height={height} role="img" aria-label={ariaLabel}>
        <defs>
          <clipPath id={clipId}>
            <rect x={m.l} y={m.t} width={pw} height={ph} />
          </clipPath>
        </defs>
        {yt.filter((t) => t.major).map((t, i) => (
          <line key={`gy${i}`} className="cc-grid" x1={m.l} x2={m.l + pw} y1={fy(t.v)} y2={fy(t.v)} />
        ))}
        {xt.filter((t) => t.major).map((t, i) => (
          <line key={`gx${i}`} className="cc-grid" y1={m.t} y2={m.t + ph} x1={fx(t.v)} x2={fx(t.v)} />
        ))}
        <g clipPath={`url(#${clipId})`}>
          {anno?.bands?.map((b, i) => {
            const a = fx(Math.max(b.x0, x.min));
            const c = fx(Math.min(b.x1, x.max));
            return (
              <g key={`b${i}`}>
                <rect className={b.className ?? 'cc-band'} x={Math.min(a, c)} y={m.t} width={Math.abs(c - a)} height={ph} />
                {b.label && (
                  <text className="cc-band-label" x={Math.min(a, c) + 4} y={m.t + 12}>
                    {b.label}
                  </text>
                )}
              </g>
            );
          })}
          {anno?.hlines?.map((l, i) => (
            <g key={`h${i}`}>
              <line x1={m.l} x2={m.l + pw} y1={fy(l.y)} y2={fy(l.y)} style={{ stroke: l.color, strokeDasharray: l.dash ?? '4 3' }} strokeWidth={1.2} />
              {l.label && (
                <text className="cc-anno" x={m.l + pw - 4} y={fy(l.y) - 4} textAnchor="end">
                  {l.label}
                </text>
              )}
            </g>
          ))}
          {anno?.vlines?.map((l, i) => (
            <g key={`v${i}`}>
              <line y1={m.t} y2={m.t + ph} x1={fx(l.x)} x2={fx(l.x)} style={{ stroke: l.color, strokeDasharray: l.dash ?? '4 3' }} strokeWidth={1.2} />
              {l.label && (
                <text className="cc-anno" x={fx(l.x) + 4} y={m.t + 12 + (i % 3) * 13}>
                  {l.label}
                </text>
              )}
            </g>
          ))}
          {series.map((s, si) =>
            s.kind === 'line' ? (
              <path key={si} d={linePath(s, fx, fy)} fill="none" style={{ stroke: s.color, strokeDasharray: s.dash }} strokeWidth={s.width ?? 2} strokeLinejoin="round" strokeLinecap="round" />
            ) : (
              <g key={si}>
                {Array.from({ length: s.x.length }, (_, i) => {
                  const px = fx(s.x[i]);
                  const py = fy(s.y[i]);
                  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
                  const hollow = s.hollow?.[i];
                  return (
                    <g key={i}>
                      <circle cx={px} cy={py} r={s.r ?? 4.5} className="cc-pt" style={hollow ? { fill: 'var(--panel)', stroke: s.color } : { fill: s.color }} strokeWidth={hollow ? 1.6 : 1.5}>
                        {s.tips?.[i] && <title>{s.tips[i]}</title>}
                      </circle>
                      {s.labels?.[i] && (
                        <text className="cc-pt-label" x={px > m.l + pw - 36 ? px - 7 : px + 7} y={py + 4} textAnchor={px > m.l + pw - 36 ? 'end' : 'start'}>
                          {s.labels[i]}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ),
          )}
        </g>
        {children && <g>{children}</g>}
        <rect className="cc-frame" x={m.l} y={m.t} width={pw} height={ph} />
        {xt.map((t, i) => (
          <g key={`xt${i}`}>
            <line className="cc-tick" x1={fx(t.v)} x2={fx(t.v)} y1={m.t + ph} y2={m.t + ph + (t.major ? 5 : 3)} />
            {t.label !== undefined && (
              <text className="cc-ticklabel" x={fx(t.v)} y={m.t + ph + 16} textAnchor="middle">
                {t.label}
              </text>
            )}
          </g>
        ))}
        {yt.map((t, i) => (
          <g key={`yt${i}`}>
            <line className="cc-tick" x1={m.l - (t.major ? 5 : 3)} x2={m.l} y1={fy(t.v)} y2={fy(t.v)} />
            {t.label !== undefined && (
              <text className="cc-ticklabel" x={m.l - 7} y={fy(t.v) + 3.5} textAnchor="end">
                {t.label}
              </text>
            )}
          </g>
        ))}
        <text className="cc-axtitle" x={m.l + pw / 2} y={height - 4} textAnchor="middle">
          {x.title}
        </text>
        <text className="cc-axtitle" transform={`translate(12 ${m.t + ph / 2}) rotate(-90)`} textAnchor="middle">
          {y.title}
        </text>
      </svg>
      {legend && legend.length > 0 && <Legend entries={legend} />}
    </div>
  );
}

export function Legend({ entries }: { entries: LegendEntry[] }) {
  return (
    <div className="cc-legend">
      {entries.map((e) => (
        <span key={e.name}>
          <svg width={18} height={10} aria-hidden="true">
            {e.marker === 'dot' ? (
              <circle cx={9} cy={5} r={4} style={{ fill: e.color }} />
            ) : e.marker === 'ring' ? (
              <circle cx={9} cy={5} r={3.5} style={{ fill: 'var(--panel)', stroke: e.color }} strokeWidth={1.5} />
            ) : (
              <line x1={1} x2={17} y1={5} y2={5} style={{ stroke: e.color, strokeDasharray: e.dash }} strokeWidth={2} />
            )}
          </svg>
          {e.name}
        </span>
      ))}
    </div>
  );
}

function mapper(a: AxisSpec, p0: number, p1: number): (v: number) => number {
  if (a.type === 'log') {
    const l0 = Math.log10(a.min);
    const l1 = Math.log10(a.max);
    return (v) => (v > 0 ? p0 + ((Math.log10(v) - l0) / (l1 - l0)) * (p1 - p0) : NaN);
  }
  return (v) => p0 + ((v - a.min) / (a.max - a.min)) * (p1 - p0);
}

function linePath(s: XYSeries, fx: (v: number) => number, fy: (v: number) => number): string {
  let d = '';
  let pen = false;
  for (let i = 0; i < s.x.length; i++) {
    const px = fx(s.x[i]);
    const py = fy(s.y[i]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Axis range [min, max] covering positive values with some padding (log axes). */
export function logRange(values: number[], pad = 1.6, minSpan = 10): [number, number] {
  const v = values.filter((x) => x > 0 && Number.isFinite(x));
  if (!v.length) return [1, 10];
  let lo = Math.min(...v) / pad;
  let hi = Math.max(...v) * pad;
  if (hi / lo < minSpan) {
    const c = Math.sqrt(lo * hi);
    lo = c / Math.sqrt(minSpan);
    hi = c * Math.sqrt(minSpan);
  }
  return [lo, hi];
}

// ---------------------------------------------------------------- histogram with draggable windows

export interface HistWindow {
  lo: number;
  hi: number;
  label: string;
  /** 'bead' (default), 'blank', 'noise', 'excluded', 'unassigned' */
  tone?: 'bead' | 'blank' | 'noise' | 'excluded' | 'unassigned';
  /** median (raw) for a marker line */
  median?: number;
  tip?: string;
}

export function HistChart({
  counts,
  u0,
  u1,
  scale,
  windows,
  onWindowsChange,
  height = 210,
  xTitle,
  ariaLabel,
}: {
  counts: ArrayLike<number>;
  u0: number;
  u1: number;
  scale: ScaleDef;
  windows: HistWindow[];
  /** called when an edge drag ends (raw units, same order as `windows`) */
  onWindowsChange?: (w: [number, number][]) => void;
  height?: number;
  xTitle: string;
  ariaLabel: string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const m = { l: 14, r: 14, t: 22, b: 36 };
  const pw = Math.max(40, W - m.l - m.r);
  const ph = Math.max(40, height - m.t - m.b);
  const sc = makeScale(scale);
  const toPx = (u: number) => m.l + ((u - u0) / (u1 - u0)) * pw;
  const toU = (px: number) => u0 + ((px - m.l) / pw) * (u1 - u0);
  const rawToPx = (v: number) => (v === -Infinity ? m.l : v === Infinity ? m.l + pw : Math.max(m.l, Math.min(m.l + pw, toPx(sc.fwd(v)))));
  // drag state: live windows (u units) while dragging
  const [drag, setDrag] = useState<{ wins: [number, number][]; i: number; side: 0 | 1; pair: number } | null>(null);
  const shown: [number, number][] = drag ? drag.wins : windows.map((w) => [w.lo, w.hi]);
  let max = 0;
  for (let i = 0; i < counts.length; i++) max = Math.max(max, counts[i]);
  const nb = counts.length;
  let d = '';
  if (nb && max > 0) {
    d = `M${toPx(u0).toFixed(1)},${(m.t + ph).toFixed(1)}`;
    for (let i = 0; i < nb; i++) {
      const xa = toPx(u0 + (i / nb) * (u1 - u0));
      const xb = toPx(u0 + ((i + 1) / nb) * (u1 - u0));
      const y = m.t + ph - (counts[i] / max) * ph;
      d += `L${xa.toFixed(1)},${y.toFixed(1)}L${xb.toFixed(1)},${y.toFixed(1)}`;
    }
    d += `L${toPx(u1).toFixed(1)},${(m.t + ph).toFixed(1)}Z`;
  }
  const ticks = computeTicks(windowScale(scale, u0, u1), { target: Math.max(3, Math.round(pw / 80)) });
  const editable = !!onWindowsChange;

  const begin = (e: React.PointerEvent, i: number, side: 0 | 1) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const wins = windows.map((w): [number, number] => [w.lo, w.hi]);
    // an edge shared with the neighbour moves with it
    let pair = -1;
    const j = side === 1 ? i + 1 : i - 1;
    if (j >= 0 && j < wins.length) {
      const a = wins[i][side];
      const b = wins[j][side === 1 ? 0 : 1];
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(sc.fwd(a) - sc.fwd(b)) < 1e-4) pair = j;
    }
    setDrag({ wins, i, side, pair });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    let u = toU(e.clientX - r.left);
    u = Math.max(u0, Math.min(u1, u));
    const wins = drag.wins.map((w) => [...w] as [number, number]);
    const { i, side, pair } = drag;
    // keep the edge inside its own window and outside the neighbours
    const otherOwn = wins[i][side === 1 ? 0 : 1];
    const ou = Number.isFinite(otherOwn) ? sc.fwd(otherOwn) : side === 1 ? -Infinity : Infinity;
    const gap = (u1 - u0) * 0.004;
    if (side === 1) u = Math.max(u, ou + gap);
    else u = Math.min(u, ou - gap);
    if (pair < 0) {
      const nb2 = side === 1 ? wins[i + 1] : wins[i - 1];
      if (nb2) {
        const lim = nb2[side === 1 ? 0 : 1];
        if (Number.isFinite(lim)) u = side === 1 ? Math.min(u, sc.fwd(lim)) : Math.max(u, sc.fwd(lim));
      }
    } else {
      const far = wins[pair][side === 1 ? 1 : 0];
      if (Number.isFinite(far)) u = side === 1 ? Math.min(u, sc.fwd(far) - gap) : Math.max(u, sc.fwd(far) + gap);
    }
    const v = sc.inv(u);
    wins[i][side] = v;
    if (pair >= 0) wins[pair][side === 1 ? 0 : 1] = v;
    setDrag({ ...drag, wins });
  };
  const end = () => {
    if (!drag) return;
    const w = drag.wins;
    setDrag(null);
    onWindowsChange?.(w);
  };
  const nudge = (i: number, side: 0 | 1, dir: number) => {
    const wins = windows.map((w): [number, number] => [w.lo, w.hi]);
    const cur = wins[i][side];
    const u = (Number.isFinite(cur) ? sc.fwd(cur) : side === 0 ? u0 : u1) + dir * (u1 - u0) * 0.005;
    const v = sc.inv(Math.max(u0, Math.min(u1, u)));
    if (side === 1 ? v <= wins[i][0] : v >= wins[i][1]) return;
    wins[i][side] = v;
    onWindowsChange?.(wins);
  };

  return (
    <div ref={ref} className="cc-chart">
      <svg ref={svgRef} width={W} height={height} role="img" aria-label={ariaLabel} onPointerMove={move} onPointerUp={end} onPointerCancel={end} style={{ touchAction: 'none' }}>
        {windows.map((w, i) => {
          const [lo, hi] = shown[i];
          const a = rawToPx(lo);
          const b = rawToPx(hi);
          return <rect key={`w${i}`} className={`cc-win ${w.tone ?? 'bead'}`} x={Math.min(a, b)} y={m.t} width={Math.max(1, Math.abs(b - a))} height={ph} />;
        })}
        {d && <path className="cc-hist" d={d} />}
        {windows.map((w, i) => {
          const [lo, hi] = shown[i];
          const a = rawToPx(lo);
          const b = rawToPx(hi);
          const mx = w.median !== undefined && Number.isFinite(w.median) ? rawToPx(w.median) : (a + b) / 2;
          return (
            <g key={`l${i}`}>
              {w.median !== undefined && Number.isFinite(w.median) && <line className={`cc-med ${w.tone ?? 'bead'}`} x1={mx} x2={mx} y1={m.t} y2={m.t + ph} />}
              <text className={`cc-win-label ${w.tone ?? 'bead'}`} x={mx} y={m.t - 7} textAnchor="middle">
                {w.label}
                {w.tip && <title>{w.tip}</title>}
              </text>
            </g>
          );
        })}
        {editable &&
          windows.map((w, i) =>
            ([0, 1] as const).map((side) => {
              const v = shown[i][side];
              const px = rawToPx(v);
              return (
                <g key={`e${i}${side}`} className="cc-edge" onPointerDown={(e) => begin(e, i, side)}>
                  <line className="cc-edge-line" x1={px} x2={px} y1={m.t} y2={m.t + ph} />
                  <rect
                    className="cc-edge-hit"
                    x={px - 5}
                    y={m.t}
                    width={10}
                    height={ph}
                    tabIndex={0}
                    role="slider"
                    aria-label={`${w.label} window ${side === 0 ? 'lower' : 'upper'} edge`}
                    aria-valuenow={Number.isFinite(v) ? Number(v.toPrecision(5)) : undefined}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                        e.preventDefault();
                        e.stopPropagation();
                        nudge(i, side, (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1));
                      }
                    }}
                  >
                    <title>Drag to adjust the window (arrow keys when focused)</title>
                  </rect>
                </g>
              );
            }),
          )}
        <line className="cc-tick" x1={m.l} x2={m.l + pw} y1={m.t + ph} y2={m.t + ph} />
        {ticks.map((t, i) => {
          const px = m.l + t.u * pw;
          return (
            <g key={`t${i}`}>
              <line className="cc-tick" x1={px} x2={px} y1={m.t + ph} y2={m.t + ph + (t.major ? 5 : 3)} />
              {t.label && (
                <text className="cc-ticklabel" x={px} y={m.t + ph + 16} textAnchor="middle">
                  {t.label.base}
                  {t.label.exp !== undefined && (
                    <tspan dy="-0.45em" fontSize="0.78em">
                      {t.label.exp}
                    </tspan>
                  )}
                </text>
              )}
            </g>
          );
        })}
        <text className="cc-axtitle" x={m.l + pw / 2} y={height - 4} textAnchor="middle">
          {xTitle}
        </text>
      </svg>
    </div>
  );
}
