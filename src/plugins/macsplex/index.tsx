// MACSPlex Exosome plugin: bead gating in checked steps from a CytExpert template, blank subtraction, tetraspanin
// normalization, replicate summaries and QC flags, following the method specification v1.1 (see README.md). The
// calculations are in compute.ts; this file is the page.
import { useMemo, useState, type ReactNode } from 'react';
import { PLUGIN_API_VERSION, type FlowStatePlugin, type PluginContext, type PluginPageProps } from '../api';
import { ISOTYPES, SINGLES_NAME, TETRASPANINS, unknownBeadNames } from './beads';
import {
  analyse,
  BEAD_COLS,
  BLANK_COLS,
  createGates,
  DEFAULT_LIMITS,
  DEFAULT_STATE,
  GATE_COLS,
  gateCheck,
  gateSignature,
  METHOD_VERSION,
  parseLayout,
  parseState,
  parseTemplateText,
  SUMMARY_COLS,
  tableRows,
  templateFromPopulations,
  WELL_COLS,
  type Limits,
  type MacsplexState,
} from './compute';

type Fs = PluginContext<MacsplexState>;

function fmt(v: unknown): string {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '–';
  if (typeof v !== 'number') return String(v);
  const a = Math.abs(v);
  return a >= 100 ? Math.round(v).toLocaleString('en-US') : a >= 1 ? v.toFixed(2) : v === 0 ? '0' : v.toPrecision(3);
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title}</h3>
        <span style={{ flex: 1 }} />
        {right}
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function Table({ rows, maxHeight = 360 }: { rows: (string | number | null)[][]; maxHeight?: number }) {
  if (rows.length < 2) return null;
  return (
    <div className="tbl-wrap" style={{ maxHeight, overflow: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            {rows[0].map((h, i) => (
              <th key={i} className={i ? undefined : 'left'}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((r, i) => (
            <tr key={i}>
              {r.map((v, k) => (
                <td
                  key={k}
                  className={k ? undefined : 'left'}
                  style={typeof v === 'string' && /_|;/.test(v) && k === r.length - 1 ? { color: 'var(--warn, #b45309)' } : undefined}
                >
                  {fmt(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Setup({ fs, s, update }: { fs: Fs; s: MacsplexState; update: (p: Partial<MacsplexState>) => void }) {
  const [tplText, setTplText] = useState('');
  const [tplPop, setTplPop] = useState('');
  const pops = fs.populations();
  const chans = fs.channels();
  const layout = useMemo(() => parseLayout(s.layoutText), [s.layoutText]);
  const beadNamesInTemplate = s.template?.gates.filter((g) => g.parent === SINGLES_NAME).map((g) => g.name) ?? [];
  const unknown = unknownBeadNames(beadNamesInTemplate);
  const rectPops = pops.filter((p) => p.gate.type === 'rect' && !Object.values(s.beads).includes(p.id) && p.id !== s.singles);
  const setLimit = (k: keyof Limits, v: string) => {
    const n = Number(v);
    if (Number.isFinite(n)) update({ limits: { ...s.limits, [k]: n } });
  };
  return (
    <Card title="1. Setup">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <b>Reporter</b>
        <select
          className="inp"
          style={{ width: 'auto', maxWidth: 260 }}
          aria-label="Reporter channel"
          value={fs.findChannel(s.reporter) ?? ''}
          onChange={(e) => update({ reporter: e.target.value })}
        >
          <option value="">Reporter channel</option>
          {chans.map((c) => (
            <option key={c.name} value={c.name}>
              {c.label ? `${c.label} (${c.name})` : c.name}
            </option>
          ))}
        </select>
        <span className="hint">median per bead population (D3)</span>
      </div>
      <b>Template (bead positions from CytExpert)</b>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          className="inp"
          style={{ width: 'auto', maxWidth: 280 }}
          aria-label="Template singles gate"
          value={tplPop}
          onChange={(e) => setTplPop(e.target.value)}
        >
          <option value="">Gates under a singles rectangle…</option>
          {rectPops.map((p) => (
            <option key={p.id} value={p.id}>
              {p.path}
            </option>
          ))}
        </select>
        <button
          className="btn sm"
          onClick={() => {
            const t = tplPop ? templateFromPopulations(fs, tplPop) : { error: 'choose the singles rectangle of the imported .xit gates' };
            if ('error' in t) return fs.notify(`Template: ${t.error}.`, 'error');
            update({ template: t });
            fs.notify(`Template: ${t.gates.length - 1} bead gates.`, 'success');
          }}
        >
          Use these gates
        </button>
      </div>
      <details>
        <summary className="hint">or paste a template (JSON from the Python reference: python -m macsplex_ref template --xit …)</summary>
        <textarea
          className="inp"
          rows={4}
          style={{ width: '100%', fontFamily: 'monospace' }}
          aria-label="Template JSON"
          value={tplText}
          onChange={(e) => setTplText(e.target.value)}
        />
        <button
          className="btn sm"
          onClick={() => {
            const t = parseTemplateText(tplText);
            if ('error' in t) return fs.notify(`Template: ${t.error}.`, 'error');
            update({ template: t });
          }}
        >
          Use pasted template
        </button>
      </details>
      <p className="hint">
        {s.template ? `Template: ${beadNamesInTemplate.length} beads from ${s.template.source}.` : 'No template yet.'}
        {unknown.length ? ` Not kit bead names (kept as they are): ${unknown.join(', ')}.` : ''}
      </p>
      <b>Plate layout (CSV: well, role, sample_id, condition, dose, replicate_group, blank_group, planned_volume_uL, failed)</b>
      <textarea
        className="inp"
        rows={5}
        style={{ width: '100%', fontFamily: 'monospace' }}
        aria-label="Layout CSV"
        value={s.layoutText}
        onChange={(e) => update({ layoutText: e.target.value })}
      />
      <p className="hint">{layout.errors.length ? layout.errors.join(' ') : `${layout.rows.length} wells in the layout.`}</p>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          <input type="radio" checked={s.mode === 'auto'} onChange={() => update({ mode: 'auto' })} /> Auto-gate from the template (default)
        </label>
        <label>
          <input type="radio" checked={s.mode === 'template'} onChange={() => update({ mode: 'template' })} /> Template gates as they are (validation mode)
        </label>
        <label>
          <input type="checkbox" checked={s.modelB} onChange={(e) => update({ modelB: e.target.checked })} /> Model B (isotype-referenced, for PS/PE probes)
        </label>
      </div>
      <details>
        <summary className="hint">Limits (highlight only; they never remove a value)</summary>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {(Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]).map((k) => (
            <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {k}
              <input className="inp" style={{ width: 80 }} defaultValue={s.limits[k]} onBlur={(e) => setLimit(k, e.target.value)} />
            </label>
          ))}
        </div>
      </details>
    </Card>
  );
}

function Gating({ fs, s, revision }: { fs: Fs; s: MacsplexState; revision: number }) {
  const samples = useMemo(() => fs.samples().filter((x) => x.loaded), [fs, revision]);
  const [ref, setRef] = useState('');
  const defaultRef = useMemo(() => [...samples].sort((a, b) => b.eventCount - a.eventCount)[0]?.id ?? '', [samples]);
  const refId = ref || s.reference || defaultRef;
  const check = useMemo(() => gateCheck(fs, s), [fs, s, revision]);
  const sig = useMemo(() => gateSignature(fs, s), [fs, s, revision]);
  const confirmed = s.confirmed && s.confirmed.signature === sig;
  return (
    <Card
      title="2. Gating"
      right={
        <button className="btn sm" disabled={!check.length} onClick={() => void fs.saveCsv('macsplex-gates', tableRows(check, GATE_COLS))}>
          gates.csv
        </button>
      }
    >
      <p className="hint">
        Steps: 1 template, 2 {s.mode === 'auto' ? 'auto-gating on the reference well' : 'template gates as they are (validation mode)'}, 3 check against the
        template, 4 correct a gate by hand in the gating view where needed (the shared gate: it applies to every well), 5 confirm. One gate set for the whole
        plate.
      </p>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <b>Reference well</b>
        <select className="inp" style={{ width: 'auto', maxWidth: 260 }} aria-label="Reference well" value={refId} onChange={(e) => setRef(e.target.value)}>
          {samples.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <button
          className="btn sm primary"
          disabled={!s.template || !refId}
          onClick={() => {
            const notes = createGates(fs, s, refId);
            fs.notify(notes.length ? notes.join(' ') : 'Gates created (one undo removes them).', notes.length ? 'info' : 'success');
          }}
        >
          {s.singles ? 'Re-create gates' : 'Create gates'}
        </button>
        <span style={{ flex: 1 }} />
        <span className="hint">
          {confirmed ? `Gate set confirmed ${s.confirmed!.at}.` : s.confirmed ? 'Gates changed since the confirmation.' : 'Not confirmed yet.'}
        </span>
        <button
          className="btn sm"
          disabled={!check.length || !!confirmed}
          onClick={() =>
            fs.setState((o) => ({ ...(o ?? DEFAULT_STATE), confirmed: { at: new Date().toISOString().slice(0, 16).replace('T', ' '), signature: sig } }))
          }
        >
          Confirm gate set
        </button>
      </div>
      {check.length > 0 && (
        <>
          <p className="hint">
            Template vs current gate in the reference well (events, median) and over all wells (events). Highlighted: a difference above{' '}
            {Math.round(s.limits.gateCheck * 100)}% (<code>gate_check</code>) or a gate corrected by hand (<code>gate_corrected</code>).
          </p>
          <Table rows={tableRows(check, GATE_COLS)} maxHeight={300} />
        </>
      )}
    </Card>
  );
}

function Page({ fs, revision }: PluginPageProps<MacsplexState>) {
  const s = fs.getState() ?? DEFAULT_STATE;
  const update = (p: Partial<MacsplexState>) => fs.setState((o) => ({ ...(o ?? DEFAULT_STATE), ...p }));
  // everything read from fs depends on `revision`
  const res = useMemo(() => analyse(fs, s), [fs, s, revision]);
  const ok = !('error' in res);
  const sheets = ok
    ? [
        { name: 'summary', rows: tableRows(res.summary, SUMMARY_COLS) },
        { name: 'beads', rows: tableRows(res.beads, BEAD_COLS) },
        { name: 'wells', rows: tableRows(res.wells, WELL_COLS) },
        { name: 'blanks', rows: tableRows(res.blanks, BLANK_COLS) },
        { name: 'gates', rows: tableRows(gateCheck(fs, s), GATE_COLS) },
        { name: 'run', rows: Object.entries(res.run).map(([k, v]) => [k, v]) },
      ]
    : [];
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 1200 }}>
      <p className="hint">
        MACSPlex Exosome, method v{METHOD_VERSION}. Value per bead and well: median of the reporter in the bead gate, minus the mean of that bead's medians in
        the well's blank group (beads-only wells). Normalized: divided by the mean of {TETRASPANINS.join(', ')} in the same well.
        {s.modelB ? ` Model B: offsets from unstained wells, minus the mean of ${ISOTYPES.join(' and ')} in the same well.` : ''} No detection call; low event
        counts and other issues are highlighted, never removed.
      </p>
      <Setup fs={fs} s={s} update={update} />
      <Gating fs={fs} s={s} revision={revision} />
      <Card
        title="3. Results"
        right={
          ok && (
            <>
              <button className="btn sm" onClick={() => void fs.saveXlsx('macsplex', sheets)}>
                Excel
              </button>
              {sheets.map((x) => (
                <button key={x.name} className="btn sm" onClick={() => void fs.saveCsv(`macsplex-${x.name}`, x.rows)}>
                  {x.name}.csv
                </button>
              ))}
            </>
          )
        }
      >
        {!ok ? (
          <p className="hint">{res.error}</p>
        ) : (
          <>
            {res.notes.map((n) => (
              <p key={n} className="hint">
                {n}
              </p>
            ))}
            <b>Replicate groups (mean of blank-subtracted values)</b>
            <Table rows={tableRows(res.summary, SUMMARY_COLS)} />
            <b>Wells</b>
            <Table rows={tableRows(res.wells, WELL_COLS)} maxHeight={260} />
            <p className="hint">
              Plate: {res.run.plate_flags || 'no plate flags'}; acquisition-order trend ρ = {fmt(res.run.order_rho)}.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}

const plugin: FlowStatePlugin<MacsplexState> = {
  apiVersion: PLUGIN_API_VERSION,
  id: 'macsplex',
  name: 'MACSPlex Exosome',
  version: '0.1.0',
  description:
    'MACSPlex Exosome Kit (human): bead gating from a CytExpert template in checked steps, blank subtraction, tetraspanin normalization, replicate summaries, QC flags.',
  author: 'Faeze',
  Page,
  parseState,
};

export default plugin;
