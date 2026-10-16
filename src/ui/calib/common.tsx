// Shared pieces of the calibration pages.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DerivedDef } from '../../core/derived';
import { derivedSummary } from '../../core/derived';
import { engine } from '../../core/engine';
import { popPath, sampleHasChannel, type Workspace } from '../../core/model';
import { saveFile, safeName } from '../../io/files';
import { derivedDependents, removeDerived } from '../../state/derivedOps';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { Check, Modal, Sel } from '../widgets';
import { mesfReportCsv, mesfReportText, sizeReportCsv, sizeReportText } from './report';
import type { MesfDef, SizeDef } from './util';

/** Replace dashes used as separators in core messages (house style: no dashes as punctuation). */
export function clean(msg: string): string {
  const t = msg.replace(/\s[–—]\s/g, ': ').replace(/[–—]/g, '-');
  // capitalize a sentence start, but not names such as "nanoViS" or "rCV"
  return /^[a-z]+\b/.test(t) && !/^[a-z]+[A-Z]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

export function StepCard({ n, title, right, children, id }: { n: number | string; title: string; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="card cal-step" id={id} aria-label={title}>
      <div className="card-head">
        <span className="cal-num" aria-hidden="true">
          {n}
        </span>
        <h3>{title}</h3>
        <span style={{ flex: 1 }} />
        {right}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Notes({ items, tone = 'warn' }: { items: (string | ReactNode)[]; tone?: 'warn' | 'error' | 'info' | 'ok' }) {
  if (!items.length) return null;
  return (
    <ul className={`cal-notes ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {items.map((t, i) => (
        <li key={i}>{typeof t === 'string' ? clean(t) : t}</li>
      ))}
    </ul>
  );
}

export function Stat({ label, value, sub, title }: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="cal-stat" title={title}>
      <div className="lbl">{label}</div>
      <div className="val">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

const memoStore = new WeakMap<object, Map<string, unknown>>();

/** Memoize a computation on an object (e.g. an event array) and a string key. */
export function memoOn<T>(obj: object, key: string, f: () => T): T {
  let m = memoStore.get(obj);
  if (!m) {
    m = new Map();
    memoStore.set(obj, m);
  }
  if (m.has(key)) return m.get(key) as T;
  const v = f();
  if (m.size > 40) m.clear();
  m.set(key, v);
  return v;
}

const subsetCache = new WeakMap<Float32Array, WeakMap<Uint32Array, Float32Array>>();

/** Values of one channel for the events of a population in a sample. */
export function popValues(ws: Workspace, sampleId: string | null, pop: string, ch: string): { values: Float32Array | null; error?: string } {
  if (!sampleId) return { values: null, error: 'Choose a bead sample.' };
  const s = ws.samples.find((x) => x.id === sampleId);
  if (!s) return { values: null, error: 'The bead sample is no longer in the workspace.' };
  if (!engine.has(sampleId)) return { values: null, error: `The data file of "${s.name}" is not loaded (re-open ${s.fileName}).` };
  if (!ch) return { values: null, error: 'Choose a channel.' };
  const raw = engine.raw(ws, sampleId, ch);
  if (!raw) return { values: null, error: `"${s.name}" has no channel ${ch}.` };
  if (!pop || pop === 'root') return { values: raw };
  if (!ws.populations.some((p) => p.id === pop)) return { values: raw, error: 'The selected population no longer exists; all events are used.' };
  const idx = engine.population(ws, sampleId, pop);
  let m = subsetCache.get(raw);
  if (!m) subsetCache.set(raw, (m = new WeakMap()));
  let out = m.get(idx);
  if (!out) {
    out = new Float32Array(idx.length);
    for (let i = 0; i < idx.length; i++) out[i] = raw[idx[i]];
    m.set(idx, out);
  }
  return { values: out };
}

export function SamplePicker({ value, onChange, ariaLabel, filter }: { value: string | null; onChange: (id: string) => void; ariaLabel: string; filter?: (id: string) => boolean }) {
  const ws = useStore((s) => s.ws);
  const opts = ws.samples
    .filter((s) => !filter || filter(s.id))
    .map((s) => ({ value: s.id, label: engine.has(s.id) ? s.name : `${s.name} (file not loaded)` }));
  return <Sel value={value ?? ''} ariaLabel={ariaLabel} options={[...(value ? [] : [{ value: '', label: 'Choose a sample' }]), ...opts]} onChange={(v) => v && onChange(v)} />;
}

export function PopulationPicker({ value, onChange, sampleId, ariaLabel }: { value: string; onChange: (id: string) => void; sampleId: string | null; ariaLabel: string }) {
  const ws = useStore((s) => s.ws);
  useStore((s) => s.ui.dataVersion);
  // populations that do not apply to the sample (other group's gates, missing channels) say so instead of "(0)"
  const count = (id: string) => (sampleId && engine.has(sampleId) ? engine.countOrNA(ws, sampleId, id) : NaN);
  const fmt = (n: number | null) => (n === null ? ' (n/a)' : Number.isFinite(n) ? ` (${n.toLocaleString('en-US')})` : '');
  return (
    <Sel
      value={ws.populations.some((p) => p.id === value) ? value : 'root'}
      ariaLabel={ariaLabel}
      options={[{ value: 'root', label: `All events${fmt(count('root'))}` }, ...ws.populations.map((p) => ({ value: p.id, label: `${popPath(ws, p.id)}${fmt(count(p.id))}` }))]}
      onChange={onChange}
    />
  );
}

/** "All samples" or a chosen subset. */
export function ApplyTargets({ all, ids, onChange, channel }: { all: boolean; ids: string[]; onChange: (all: boolean, ids: string[]) => void; channel: string }) {
  const ws = useStore((s) => s.ws);
  const has = (sid: string) => sampleHasChannel(ws, sid, channel);
  const withCh = ws.samples.filter((s) => has(s.id));
  return (
    <div className="cal-apply">
      <div className="row" role="radiogroup" aria-label="Apply to">
        <label className="check">
          <input type="radio" checked={all} onChange={() => onChange(true, ids)} /> All samples with {channel || 'the channel'} ({withCh.length})
        </label>
        <label className="check">
          <input type="radio" checked={!all} onChange={() => onChange(false, ids.length ? ids : withCh.map((s) => s.id))} /> Selected samples
        </label>
      </div>
      {!all && (
        <div className="cal-samples">
          {ws.samples.map((s) => (
            <label key={s.id} className="check" title={has(s.id) ? s.name : `${s.name} has no ${channel}`} style={has(s.id) ? undefined : { opacity: 0.5 }}>
              <input type="checkbox" disabled={!has(s.id)} checked={ids.includes(s.id)} onChange={(e) => onChange(false, e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))} />
              <span className="nm">{s.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reports

export async function exportReport(def: DerivedDef, format: 'csv' | 'txt') {
  if (def.kind === 'unmix') return;
  const base = safeName(`${def.name} calibration`);
  const text = def.kind === 'mesf' ? (format === 'csv' ? mesfReportCsv(def as MesfDef) : mesfReportText(def as MesfDef)) : format === 'csv' ? sizeReportCsv(def as SizeDef) : sizeReportText(def as SizeDef);
  await saveFile(`${base}.${format}`, text);
}

export function reportText(def: DerivedDef): string {
  if (def.kind === 'mesf') return mesfReportText(def as MesfDef);
  if (def.kind === 'size') return sizeReportText(def as SizeDef);
  return '';
}

/** List of applied calibrations of one kind, with edit / report / delete. */
export function CalibList({ kind, onEdit, editingId }: { kind: 'mesf' | 'size'; onEdit: (def: DerivedDef) => void; editingId?: string }) {
  const ws = useStore((s) => s.ws);
  const defs = (ws.derived ?? []).filter((d) => d.kind === kind);
  const [open, setOpen] = useState<string | null>(null);
  const [askRemove, removeDialog] = useRemoveDerived();
  if (!defs.length)
    return (
      <p className="hint" style={{ margin: 0 }}>
        No {kind === 'mesf' ? 'fluorescence' : 'scatter'} calibration in this workspace yet. Calibrated channels you create below appear here and in every channel list.
      </p>
    );
  return (
    <div className="cal-list">
      {defs.map((d) => {
        const nS = d.samples ? d.samples.length : ws.samples.filter((s) => sampleHasChannel(ws, s.id, d.outputs[0]?.name ?? '')).length;
        return (
          <div key={d.id} className={`cal-li${editingId === d.id ? ' on' : ''}`}>
            <div className="cal-li-main">
              <div className="nm">{d.outputs.map((o) => o.name).join(', ')}</div>
              <div className="meta">
                {clean(derivedSummary(d))} · {d.samples ? `${nS} selected samples` : `all samples (${nS})`}
                {kind === 'mesf' && (d as MesfDef).beads?.valuesSource === 'kit-example' && <span className="badge warn" style={{ marginLeft: 6 }}>example values</span>}
                {kind === 'size' && (d as SizeDef).fit?.endsAtFlat && !(d as SizeDef).lowSlopeBands && (
                  <span
                    className="badge warn"
                    style={{ marginLeft: 6 }}
                    title="Made with an earlier version: the valid range ends where σ(d) turns flat although it still rises, so larger events get no diameter. Edit and update the calibration to size them (the flat part is then reported as low size resolution)."
                  >
                    range ends early
                  </span>
                )}
              </div>
            </div>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="btn sm" onClick={() => onEdit(d)} aria-label={`Edit ${d.name}`}>
                Edit
              </button>
              <button className="btn sm" onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id}>
                Report
              </button>
              <button className="icon-btn danger" title="Delete calibration" aria-label={`Delete ${d.name}`} onClick={() => askRemove(d.id)}>
                <Icon.trash />
              </button>
            </div>
            {open === d.id && <ReportBox def={d} />}
          </div>
        );
      })}
      {removeDialog}
    </div>
  );
}

/**
 * Removal of a derived definition that asks first when other definitions are built on its outputs (e.g. an MESF
 * calibration of an unmixed channel). Returns the request function and the dialog element to render.
 */
export function useRemoveDerived(after?: (id: string) => void): [(id: string) => void, ReactNode] {
  const [ask, setAsk] = useState<{ id: string; name: string; deps: DerivedDef[] } | null>(null);
  const request = (id: string) => {
    const ws = useStore.getState().ws;
    const def = ws.derived?.find((d) => d.id === id);
    if (!def) return;
    const deps = derivedDependents(ws, id);
    if (!deps.length) {
      removeDerived(id);
      after?.(id);
      return;
    }
    setAsk({ id, name: def.name, deps });
  };
  const done = (withDependents: boolean) => {
    if (!ask) return;
    removeDerived(ask.id, { withDependents });
    after?.(ask.id);
    setAsk(null);
  };
  const dialog = ask ? (
    <Modal
      title={`Remove "${ask.name}"?`}
      onClose={() => setAsk(null)}
      footer={
        <>
          <button className="btn" onClick={() => setAsk(null)}>
            Cancel
          </button>
          <button className="btn" onClick={() => done(false)} title="The dependent calibrations stay in the workspace but have no input values">
            Remove only "{ask.name}"
          </button>
          <button className="btn primary" onClick={() => done(true)}>
            Remove all {ask.deps.length + 1}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        {ask.deps.length === 1 ? 'This calibration is' : `These ${ask.deps.length} calibrations are`} built on the channels of &quot;{ask.name}&quot;:
      </p>
      <ul>
        {ask.deps.map((d) => (
          <li key={d.id}>
            <b>{d.name}</b>
            {d.outputs.some((o) => o.name !== d.name) ? ` (${d.outputs.map((o) => o.name).join(', ')})` : ''}
          </li>
        ))}
      </ul>
      <p className="hint">
        Remove {ask.deps.length === 1 ? 'it' : 'them'} too, or keep {ask.deps.length === 1 ? 'it' : 'them'}: kept calibrations have no values until a channel with the same name exists again. Undo with Ctrl+Z.
      </p>
    </Modal>
  ) : null;
  return [request, dialog];
}

export function ReportBox({ def }: { def: DerivedDef }) {
  const text = reportText(def);
  const [copied, setCopied] = useState(false);
  const t = useRef<number>();
  useEffect(() => () => window.clearTimeout(t.current), []);
  return (
    <div className="cal-report">
      <pre aria-label="Calibration report text">{text}</pre>
      <div className="row">
        <button className="btn sm" onClick={() => exportReport(def, 'csv')}>
          <Icon.export /> CSV
        </button>
        <button className="btn sm" onClick={() => exportReport(def, 'txt')}>
          <Icon.export /> Text
        </button>
        <button
          className="btn sm"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true);
                t.current = window.setTimeout(() => setCopied(false), 1500);
              },
              () => useStore.getState().toast('Copy failed: select the text and copy it manually', 'error'),
            );
          }}
        >
          <Icon.copy /> {copied ? 'Copied' : 'Copy text'}
        </button>
        <span className="hint">MIFlowCyt-EV style summary; check it against your records before publishing.</span>
      </div>
    </div>
  );
}

export function YesNo({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <Check checked={value} onChange={onChange} label={label} />;
}

/** Compute something expensive after the current paint (keeps typing / dragging responsive). */
export function useDeferredCompute<T>(compute: () => T, deps: unknown[]): { value: T | undefined; pending: boolean } {
  const [state, setState] = useState<{ value: T | undefined; key: number }>({ value: undefined, key: -1 });
  const [pending, setPending] = useState(true);
  const seq = useRef(0);
  useEffect(() => {
    const k = ++seq.current;
    setPending(true);
    const h = window.setTimeout(() => {
      if (k !== seq.current) return;
      const v = compute();
      if (k !== seq.current) return;
      setState({ value: v, key: k });
      setPending(false);
    }, 30);
    return () => window.clearTimeout(h);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { value: state.value, pending };
}
