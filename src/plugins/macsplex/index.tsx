// MACSPlex plugin: bead gating from a CytExpert template in checked steps (with a well-by-well bead plot as in
// CytExpert), blank subtraction, tetraspanin normalization, replicate summaries and QC flags, following the method
// specification v1.1 (see README.md). The calculations are in compute.ts; this file is the page.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PLUGIN_API_VERSION, type FlowStatePlugin, type GateGeom, type PluginContext, type PluginPageProps } from '../api';
import { ISOTYPES, TETRASPANINS, unknownBeadNames } from './beads';
import {
  analyse,
  BEAD_COLS,
  BLANK_COLS,
  alignPolygon,
  createGates,
  DEFAULT_LIMITS,
  DEFAULT_STATE,
  draftLayout,
  GATE_COLS,
  gateCheck,
  gateSignature,
  layoutToCsv,
  METHOD_VERSION,
  normalizeWell,
  pairBlanks,
  parseLayout,
  parseState,
  parseTemplateText,
  SUMMARY_COLS,
  tableRows,
  templateFromPopulations,
  templateFromXit,
  templateParts,
  usePlateGates,
  WELL_COLS,
  type LayoutRow,
  type Limits,
  type MacsplexState,
  type Role,
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
                  style={k === r.length - 1 && typeof v === 'string' && v ? { color: 'var(--warn, #b45309)' } : undefined}
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

/** A file button (a plain file input; the plugin API has no file dialog yet). */
const MAX_FILE_MB = 50;

/** A file button (a plain file input; the plugin API has no file dialog yet). Errors and oversized files are reported. */
function OpenFile({ fs, label, accept, onFile }: { fs: Fs; label: string; accept: string; onFile: (name: string, bytes: Uint8Array) => void }) {
  return (
    <label className="btn sm" style={{ cursor: 'pointer' }}>
      {label}
      <input
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > MAX_FILE_MB * 1024 * 1024) return fs.notify(`${f.name}: larger than ${MAX_FILE_MB} MB, not opened.`, 'error');
          try {
            onFile(f.name, new Uint8Array(await f.arrayBuffer()));
          } catch (err) {
            fs.notify(`${f.name}: could not be read (${err instanceof Error ? err.message : String(err)}).`, 'error');
          }
        }}
      />
    </label>
  );
}

/** A text input that keeps what is typed and saves it on blur or Enter (so "12." or a trailing space survive typing). */
function DraftInput({ value, onSave, width, label }: { value: string; onSave: (v: string) => void; width: number; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft !== null && draft !== value) onSave(draft);
    setDraft(null);
  };
  return (
    <input
      className="inp"
      style={{ width }}
      aria-label={label}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

// ------------------------------------------------------------------ 1. template

function TemplateCard({ fs, s, update }: { fs: Fs; s: MacsplexState; update: (p: Partial<MacsplexState>) => void }) {
  const [tplText, setTplText] = useState('');
  const [tplPop, setTplPop] = useState('');
  const pops = fs.populations();
  const chans = fs.channels();
  const names = templateParts(s.template).beads.map((g) => g.name);
  const unknown = unknownBeadNames(names);
  const rectPops = pops.filter((p) => p.gate.type === 'rect' && !Object.values(s.beads).includes(p.id) && p.id !== s.singles);
  const use = (t: ReturnType<typeof templateFromXit>) => {
    if ('error' in t) return fs.notify(`Template: ${t.error}.`, 'error');
    update({ template: t });
    fs.notify(`Template: ${t.gates.length - 1} bead gates from ${t.source}.`, 'success');
  };
  return (
    <Card title="1. Template and reporter">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <OpenFile fs={fs} label="Open CytExpert .xit…" accept=".xit" onFile={(name, bytes) => use(templateFromXit(bytes, name))} />
        <span className="hint">the experiment file with the bead gates (positions are read from it; nothing is uploaded)</span>
      </div>
      <p className="hint">
        {s.template ? `Template: ${names.length} beads from ${s.template.source}.` : 'No template yet.'}
        {unknown.length ? ` Not kit bead names (kept as they are): ${unknown.join(', ')}.` : ''}
      </p>
      <details>
        <summary className="hint">other sources: gates already in this analysis, or a template pasted as JSON</summary>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
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
          <button className="btn sm" disabled={!tplPop} onClick={() => use(templateFromPopulations(fs, tplPop))}>
            Use these gates
          </button>
        </div>
        <textarea
          className="inp"
          rows={3}
          style={{ width: '100%', fontFamily: 'monospace', marginTop: 6 }}
          aria-label="Template JSON"
          value={tplText}
          onChange={(e) => setTplText(e.target.value)}
        />
        <button className="btn sm" onClick={() => use(parseTemplateText(tplText))}>
          Use pasted template
        </button>
      </details>
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
    </Card>
  );
}

// ------------------------------------------------------------------ 2. layout

const ROLE_OPTIONS: Role[] = ['sample', 'blank', 'unstained', 'sa_control', 'isotype_only', 'empty'];

function LayoutCard({ fs, s, update }: { fs: Fs; s: MacsplexState; update: (p: Partial<MacsplexState>) => void }) {
  const parsed = useMemo(() => parseLayout(s.layoutText), [s.layoutText]);
  const rows = s.layoutText.trim() ? parsed.rows : [];
  const [vol, setVol] = useState('120');
  const set = (next: LayoutRow[]) => update({ layoutText: layoutToCsv(next) });
  const edit = (i: number, p: Partial<LayoutRow>) => set(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const cell = (i: number, key: 'sample_id' | 'condition' | 'dose' | 'replicate_group' | 'blank_group', w = 110) => (
    <DraftInput width={w} label={`${rows[i].well} ${key}`} value={rows[i][key]} onSave={(v) => edit(i, { [key]: v.trim() })} />
  );
  return (
    <Card
      title="2. Plate layout"
      right={
        <>
          <OpenFile fs={fs} label="Open layout CSV…" accept=".csv,.txt,.tsv" onFile={(_n, bytes) => update({ layoutText: new TextDecoder().decode(bytes) })} />
          <button
            className="btn sm"
            disabled={!rows.length}
            onClick={() =>
              void fs.saveCsv('macsplex-layout', [
                ['well', 'role', 'sample_id', 'condition', 'dose', 'replicate_group', 'blank_group', 'planned_volume_uL', 'failed'],
                ...rows.map((r) => [
                  r.well,
                  r.role,
                  r.sample_id,
                  r.condition,
                  r.dose,
                  r.replicate_group,
                  r.blank_group,
                  r.planned_volume_uL,
                  r.failed ? 'yes' : '',
                ]),
              ])
            }
          >
            Save layout CSV
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn sm" onClick={() => set(draftLayout(fs, Number(vol) || null))}>
          Start from the loaded wells
        </button>
        <label className="hint" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          planned volume (µL)
          <input className="inp" style={{ width: 60 }} value={vol} onChange={(e) => setVol(e.target.value)} />
        </label>
        <button className="btn sm" disabled={!rows.length} onClick={() => set(pairBlanks(rows, 'column'))}>
          Pair with blanks in the same column
        </button>
        <button className="btn sm" disabled={!rows.length} onClick={() => set(pairBlanks(rows, 'row'))}>
          … in the same row
        </button>
        {rows.length > 0 && (
          <button className="btn sm" onClick={() => update({ layoutText: '' })}>
            Clear
          </button>
        )}
      </div>
      <p className="hint">
        {parsed.errors.length && s.layoutText.trim()
          ? parsed.errors.join(' ')
          : rows.length
            ? `${rows.length} wells. Check roles (blank = beads + buffer + detection reagent; unstained = sample without detection reagent), replicate groups and blank groups.`
            : 'No layout: results show medians only. "Start from the loaded wells" makes a first version from the tube names to check and complete.'}
      </p>
      {rows.length > 0 && (
        <div className="tbl-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                {['well', 'role', 'condition', 'dose', 'replicate_group', 'blank_group', 'sample_id', 'µL', 'failed'].map((h) => (
                  <th key={h} className={h === 'well' ? 'left' : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="left">{r.well}</td>
                  <td>
                    <select
                      className="inp"
                      style={{ width: 'auto' }}
                      value={r.role}
                      aria-label={`${r.well} role`}
                      onChange={(e) => edit(i, { role: e.target.value as Role })}
                    >
                      {ROLE_OPTIONS.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </td>
                  <td>{cell(i, 'condition', 140)}</td>
                  <td>{cell(i, 'dose', 60)}</td>
                  <td>{cell(i, 'replicate_group', 150)}</td>
                  <td>{cell(i, 'blank_group', 110)}</td>
                  <td>{cell(i, 'sample_id', 80)}</td>
                  <td>
                    <DraftInput
                      width={50}
                      label={`${r.well} volume`}
                      value={r.planned_volume_uL === null ? '' : String(r.planned_volume_uL)}
                      onSave={(v) => {
                        const n = Number(v.replace(',', '.'));
                        if (v.trim() === '' || Number.isFinite(n)) edit(i, { planned_volume_uL: v.trim() === '' ? null : n });
                        else fs.notify(`${r.well}: "${v}" is not a number.`, 'error');
                      }}
                    />
                  </td>
                  <td>
                    <input type="checkbox" checked={r.failed} aria-label={`${r.well} failed`} onChange={(e) => edit(i, { failed: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ 3. gating

function GatingCard({ fs, s, revision, update }: { fs: Fs; s: MacsplexState; revision: number; update: (p: Partial<MacsplexState>) => void }) {
  const samples = useMemo(() => fs.samples().filter((x) => x.loaded), [fs, revision]);
  const [ref, setRef] = useState('');
  const defaultRef = useMemo(() => [...samples].sort((a, b) => b.eventCount - a.eventCount)[0]?.id ?? '', [samples]);
  const isLoaded = (id: string | null | undefined) => !!id && samples.some((x) => x.id === id);
  const refId = isLoaded(ref) ? ref : isLoaded(s.reference) ? s.reference! : defaultRef;
  const [shown, setShown] = useState('');
  const shownId = shown && samples.some((x) => x.id === shown) ? shown : refId;
  const [bead, setBead] = useState('');
  const check = useMemo(() => gateCheck(fs, s), [fs, s, revision]);
  const sig = useMemo(() => gateSignature(fs, s), [fs, s, revision]);
  const wells = useMemo(() => wellInfo(fs, s), [fs, s, revision]);
  const confirmed = s.confirmed && s.confirmed.signature === sig;
  const realign = () => {
    const id = s.beads[bead];
    const g = fs.populations().find((p) => p.id === id)?.gate as GateGeom | undefined;
    if (!id || !g || g.type !== 'polygon' || !s.singles) return;
    const ex = fs.events(shownId, g.x, s.singles);
    const ey = fs.events(shownId, g.y, s.singles);
    if (!ex || !ey) return;
    const a = alignPolygon(g.points as [number, number][], ex, ey);
    if (a.refused) return fs.notify(`${bead}: not aligned (${a.refused}).`, 'error');
    if (a.n < 3) return fs.notify(`${bead}: too few events near the gate in this well.`, 'error');
    fs.setGate(id, { ...g, points: a.points }); // the shared gate: every well
    fs.notify(`${bead} aligned to its beads in this well (moved ${a.dx.toFixed(3)}, ${a.dy.toFixed(3)} decades); applied to all wells.`, 'success');
  };
  const shownName = samples.find((x) => x.id === shownId);
  return (
    <Card
      title="3. Gating"
      right={
        <button className="btn sm" disabled={!check.length} onClick={() => void fs.saveCsv('macsplex-gates', tableRows(check, GATE_COLS))}>
          gates.csv
        </button>
      }
    >
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>
          <input type="radio" checked={s.mode === 'auto'} onChange={() => update({ mode: 'auto' })} /> Align the template to the beads of the reference well
          (default)
        </label>
        <label>
          <input type="radio" checked={s.mode === 'template'} onChange={() => update({ mode: 'template' })} /> Template gates as they are (validation mode)
        </label>
      </div>
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
            const r = createGates(fs, s, refId);
            if ('error' in r) fs.notify(r.error, 'error');
            else
              fs.notify(
                r.notes.length ? r.notes.join(' ') : 'Gates created (one undo removes them). Now check the wells.',
                r.notes.length ? 'info' : 'success',
              );
          }}
        >
          {s.singles ? 'Re-create gates' : 'Create gates'}
        </button>
      </div>
      {s.singles && (
        <>
          <p className="hint">
            Check every well: click a well in the plate map to show its beads. If a gate has shifted, drag it onto its bead, or select it and align it in this
            well (alignment corrects shifts up to about a third of a gate's width). Both change the shared gate, so every well gets the same gate (as "apply to
            all tubes" in CytExpert).
          </p>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 520px', minWidth: 320 }}>
              <div className="hint" style={{ marginBottom: 4 }}>
                {shownName ? `${normalizeWell(shownName.keywords['$SMNO'] ?? '') || ''} ${shownName.name}: Single beads` : ''}
              </div>
              <GatePlot fs={fs} s={s} sampleId={shownId} revision={revision} selected={bead} onSelect={setBead} />
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <PlateMap wells={wells} selected={shownId} onSelect={setShown} lowLimit={s.limits.lowAssignment} />
              <select
                className="inp"
                style={{ width: 'auto', maxWidth: 300 }}
                aria-label="Shown sample"
                value={shownId}
                onChange={(e) => setShown(e.target.value)}
              >
                {wells.map((w) => (
                  <option key={w.sampleId} value={w.sampleId}>
                    {w.label}
                    {w.own ? ' (own gate)' : ''}
                  </option>
                ))}
              </select>
              {wells.find((w) => w.sampleId === shownId)?.own && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="hint" style={{ color: 'var(--warn, #b45309)' }}>
                    This well has its own gate (against one gate set per plate).
                  </span>
                  <button
                    className="btn sm"
                    onClick={() => {
                      const k = usePlateGates(fs, s, shownId);
                      fs.notify(`${k} own gate(s) removed; the plate gates apply again.`, 'success');
                    }}
                  >
                    Use the plate gate again
                  </button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="hint">{bead ? `Selected: ${bead}` : 'Click a gate to select it.'}</span>
                <button className="btn sm" disabled={!bead} onClick={realign}>
                  Align selected bead in this well
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="hint">
                  {confirmed ? `Gate set confirmed ${s.confirmed!.at}.` : s.confirmed ? 'Gates changed since the confirmation.' : 'Not confirmed yet.'}
                </span>
                <button
                  className="btn sm"
                  disabled={!check.length || !!confirmed}
                  onClick={() => update({ confirmed: { at: new Date().toISOString().slice(0, 16).replace('T', ' '), signature: sig } })}
                >
                  Confirm gate set
                </button>
              </div>
            </div>
          </div>
          <details>
            <summary className="hint">
              Check against the template: {check.filter((x) => x.flags.includes('gate_check')).length} beads differ by more than{' '}
              {Math.round(s.limits.gateCheck * 100)}% or could not be checked, {check.filter((x) => x.corrected).length} corrected by hand,{' '}
              {check.filter((x) => x.own_gate_wells > 0).length} with wells that have their own gate
            </summary>
            <Table rows={tableRows(check, GATE_COLS)} maxHeight={300} />
          </details>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ 4. results

function Page({ fs, revision }: PluginPageProps<MacsplexState>) {
  const s = fs.getState() ?? DEFAULT_STATE;
  const update = (p: Partial<MacsplexState>) => fs.setState((o) => ({ ...(o ?? DEFAULT_STATE), ...p }));
  // everything read from fs depends on `revision`
  const res = useMemo(() => analyse(fs, s), [fs, s, revision]);
  const ok = !('error' in res);
  const hasLayout = !!s.layoutText.trim();
  // the export tables are built only when exporting (the gate check reads events of every well)
  const SHEETS = ['summary', 'beads', 'wells', 'blanks', 'gates', 'run'] as const;
  const sheet = (name: (typeof SHEETS)[number]) => {
    if ('error' in res) return [];
    if (name === 'summary') return tableRows(res.summary, SUMMARY_COLS);
    if (name === 'beads') return tableRows(res.beads, BEAD_COLS);
    if (name === 'wells') return tableRows(res.wells, WELL_COLS);
    if (name === 'blanks') return tableRows(res.blanks, BLANK_COLS);
    if (name === 'gates') return tableRows(gateCheck(fs, s), GATE_COLS);
    return Object.entries(res.run).map(([k, v]) => [k, v]);
  };
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 1200 }}>
      <p className="hint">
        MACSPlex, method v{METHOD_VERSION}. Value per bead and well: median of the reporter in the bead gate, minus the mean of that bead's medians in the
        well's blank group (beads-only wells). Normalized: divided by the mean of {TETRASPANINS.join(', ')} in the same well.
        {s.modelB ? ` Model B: offsets from unstained wells, minus the mean of ${ISOTYPES.join(' and ')} in the same well.` : ''} No detection call; low event
        counts and other issues are highlighted, never removed.
      </p>
      <TemplateCard fs={fs} s={s} update={update} />
      <LayoutCard fs={fs} s={s} update={update} />
      <GatingCard fs={fs} s={s} revision={revision} update={update} />
      <Card
        title="4. Results"
        right={
          ok && (
            <>
              <button
                className="btn sm"
                onClick={() =>
                  void fs.saveXlsx(
                    'macsplex',
                    SHEETS.map((name) => ({ name, rows: sheet(name) })),
                  )
                }
              >
                Excel (all tables)
              </button>
              {SHEETS.map((name) => (
                <button key={name} className="btn sm" onClick={() => void fs.saveCsv(`macsplex-${name}`, sheet(name))}>
                  {name}.csv
                </button>
              ))}
            </>
          )
        }
      >
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <label>
            <input type="checkbox" checked={s.modelB} onChange={(e) => update({ modelB: e.target.checked })} /> Model B (isotype-referenced, for PS/PE probes)
          </label>
          <details>
            <summary className="hint">Limits (highlight only; they never remove a value)</summary>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {(Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]).map((k) => (
                <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {k}
                  <DraftInput
                    width={80}
                    label={k}
                    value={String(s.limits[k])}
                    onSave={(v) => {
                      const n = Number(v.replace(',', '.'));
                      if (v.trim() === '' || !Number.isFinite(n)) return fs.notify(`${k}: "${v}" is not a number; the limit is unchanged.`, 'error');
                      update({ limits: { ...s.limits, [k]: n } });
                    }}
                  />
                </label>
              ))}
            </div>
          </details>
        </div>
        {!ok ? (
          <p className="hint">{res.error}</p>
        ) : (
          <>
            {res.notes.map((n) => (
              <p key={n} className="hint">
                {n}
              </p>
            ))}
            {hasLayout && (
              <>
                <b>Replicate groups: mean of blank-subtracted values (mean_A), SD, CV, n; normalized mean</b>
                <Table rows={tableRows(res.summary, SUMMARY_COLS)} />
              </>
            )}
            <b>Per well and bead: events, median, 95% CI{hasLayout ? ', blank-subtracted and normalized values' : ''}</b>
            <Table rows={tableRows(res.beads, BEAD_COLS)} maxHeight={300} />
            <b>Wells: volume, single beads, % assigned, acquisition order, flags</b>
            <Table rows={tableRows(res.wells, WELL_COLS)} maxHeight={260} />
            <p className="hint">
              Plate: {res.run.plate_flags || 'no plate flags'}; acquisition-order trend ρ = {fmt(res.run.order_rho)}. Tables only (no graphs yet); the export is
              unrounded.
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
  name: 'MACSPlex',
  version: '0.2.0',
  description:
    'MACSPlex bead assays: gating from a CytExpert template in checked steps, blank subtraction, tetraspanin normalization, replicate summaries, QC flags.',
  author: 'Faeze',
  Page,
  parseState,
};

export default plugin;

// ------------------------------------------------------------------ bead plot and plate map
//
// The bead plot of one well with every bead gate and its share of single beads (as CytExpert shows it), and the plate
// map to pick the well. A gate can be dragged to a new place: that changes the shared gate, i.e. every well of the plate
// (one gate set per plate, method D2).

export interface WellInfo {
  sampleId: string;
  well: string;
  label: string;
  pctAssigned: number;
  /** the sample has its own gate for the singles population or a bead population */
  own: boolean;
}

/** % of single beads inside any bead gate, per loaded sample (the drift indicator of the plate map). */
export function wellInfo(fs: Fs, s: MacsplexState): WellInfo[] {
  const beads = Object.values(s.beads);
  const pops = fs.populations();
  const ownIds = new Set(pops.filter((p) => p.id === s.singles || beads.includes(p.id)).flatMap((p) => p.sampleGates));
  return fs
    .samples()
    .filter((x) => x.loaded)
    .map((x) => {
      const singles = s.singles ? (fs.count(x.id, s.singles) ?? 0) : 0;
      const assigned = beads.reduce((a, b) => a + (fs.count(x.id, b) ?? 0), 0);
      const well = normalizeWell(x.keywords['$SMNO'] ?? '') || x.name;
      return {
        sampleId: x.id,
        well,
        label: well === x.name ? x.name : `${well}: ${x.name}`,
        pctAssigned: singles ? (100 * assigned) / singles : NaN,
        own: ownIds.has(x.id),
      };
    });
}

/** The plate map: one cell per well (A1 to P24); samples without such a well are in the sample list next to it. */
export function PlateMap({ wells, selected, onSelect, lowLimit }: { wells: WellInfo[]; selected: string; onSelect: (id: string) => void; lowLimit: number }) {
  const parsed = wells.map((w) => ({ ...w, m: w.well.match(/^([A-P])(\d{1,2})$/) })).filter((w) => w.m && Number(w.m[2]) >= 1 && Number(w.m[2]) <= 24);
  const rows = [...new Set(parsed.map((w) => w.m![1]))].sort();
  const cols = [...new Set(parsed.map((w) => Number(w.m![2])))].sort((a, b) => a - b);
  if (!rows.length) return null;
  const at = (r: string, c: number) => parsed.filter((w) => w.m![1] === r && Number(w.m![2]) === c);
  return (
    <div>
      <table className="data" style={{ width: 'auto' }}>
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th>{r}</th>
              {cols.map((c) => {
                const here = at(r, c);
                if (!here.length) return <td key={c} />;
                const w = here.find((x) => x.sampleId === selected) ?? here[0];
                const low = w.pctAssigned < lowLimit * 100;
                return (
                  <td
                    key={c}
                    title={`${w.label}: ${Number.isFinite(w.pctAssigned) ? w.pctAssigned.toFixed(1) : '–'}% of single beads in a bead gate${w.own ? '; own gate' : ''}${here.length > 1 ? `; ${here.length} samples in this well (see the list)` : ''}`}
                    onClick={() => onSelect(w.sampleId)}
                    style={{
                      cursor: 'pointer',
                      textAlign: 'center',
                      padding: '2px 4px',
                      outline: w.sampleId === selected ? '2px solid #2563eb' : undefined,
                      background: low ? 'rgba(220,38,38,0.18)' : 'transparent',
                    }}
                  >
                    {Number.isFinite(w.pctAssigned) ? Math.round(w.pctAssigned) : '–'}
                    {w.own || here.length > 1 ? '*' : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        % of single beads inside a bead gate; red: below {Math.round(lowLimit * 100)}% (low_assignment); *: own gate or several samples in the well. Click a
        well to show it.
      </p>
    </div>
  );
}

const W = 560;
const H = 500;
const PAD = { l: 52, r: 12, t: 12, b: 40 };
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#4d7c0f', '#b45309', '#4338ca'];
const lg = (v: number) => Math.log10(Math.max(v, 1));
type Poly = Extract<GateGeom, { type: 'polygon' }>;
interface Frame {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
const sxOf = (f: Frame) => (u: number) => PAD.l + ((u - f.x0) / (f.x1 - f.x0)) * (W - PAD.l - PAD.r);
const syOf = (f: Frame) => (v: number) => H - PAD.b - ((v - f.y0) / (f.y1 - f.y0)) * (H - PAD.t - PAD.b);

/** The dots: drawn once per sample and frame, not on every mouse move while a gate is dragged. */
const Dots = memo(function Dots({ pts, frame }: { pts: [number, number][]; frame: Frame }) {
  const sx = sxOf(frame);
  const sy = syOf(frame);
  const d = pts.map(([u, v]) => `M${sx(u).toFixed(1)},${sy(v).toFixed(1)}h1.4v1.4h-1.4z`).join('');
  return <path d={d} fill="#1d4ed8" opacity={0.45} />;
});

export function GatePlot({
  fs,
  s,
  sampleId,
  revision,
  selected,
  onSelect,
}: {
  fs: Fs;
  s: MacsplexState;
  sampleId: string;
  revision: number;
  selected: string;
  onSelect: (bead: string) => void;
}) {
  // the gates as they apply to this sample (its own gate if it has one, else the plate gate)
  const beadPops = useMemo(
    () =>
      Object.entries(s.beads)
        .map(([name, id]) => ({
          name,
          id,
          gate: fs.gateFor(id, sampleId) as Poly | null,
          own: !!fs
            .populations()
            .find((p) => p.id === id)
            ?.sampleGates.includes(sampleId),
        }))
        .filter((b): b is { name: string; id: string; gate: Poly; own: boolean } => !!b.gate && b.gate.type === 'polygon'),
    [fs, s.beads, sampleId, revision],
  );
  const first = beadPops[0]?.gate;
  const xCh = first?.x ?? '';
  const yCh = first?.y ?? '';
  const pts = useMemo(() => {
    if (!xCh || !s.singles) return null;
    const x = fs.events(sampleId, xCh, s.singles);
    const y = fs.events(sampleId, yCh, s.singles);
    if (!x || !y) return null;
    const step = Math.max(1, Math.floor(x.length / 6000));
    const out: [number, number][] = [];
    for (let i = 0; i < x.length; i += step) out.push([lg(x[i]), lg(y[i])]);
    return out;
  }, [fs, sampleId, xCh, yCh, s.singles, revision]);
  // axis range (log10) from the events and gates, computed once per sample and gate set
  const frame = useMemo<Frame | null>(() => {
    if (!pts) return null;
    const xs = [...pts.map((p) => p[0]), ...beadPops.flatMap((b) => b.gate.points.map((p) => lg(p[0])))].sort((a, b) => a - b);
    const ys = [...pts.map((p) => p[1]), ...beadPops.flatMap((b) => b.gate.points.map((p) => lg(p[1])))].sort((a, b) => a - b);
    const q = (v: number[], f: number) => v[Math.floor(f * (v.length - 1))];
    const f = {
      x0: Math.floor(q(xs, 0.005) * 2) / 2,
      x1: Math.ceil(q(xs, 0.995) * 2) / 2,
      y0: Math.floor(q(ys, 0.005) * 2) / 2,
      y1: Math.ceil(q(ys, 0.995) * 2) / 2,
    };
    if (f.x1 <= f.x0) f.x1 = f.x0 + 1;
    if (f.y1 <= f.y0) f.y1 = f.y0 + 1;
    return f;
  }, [pts, beadPops]);
  const singles = s.singles ? (fs.count(sampleId, s.singles) ?? 0) : 0;
  const counts = useMemo(() => new Map(beadPops.map((b) => [b.id, fs.count(sampleId, b.id) ?? 0])), [fs, beadPops, sampleId, revision]);
  const [drag, setDrag] = useState<{ bead: string; x0: number; y0: number; dx: number; dy: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => setDrag(null), [sampleId]);
  if (!first || !pts || !frame) return <p className="hint">Create the gates to see the bead plot.</p>;
  const sx = sxOf(frame);
  const sy = syOf(frame);
  const toLog = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    return [
      frame.x0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (frame.x1 - frame.x0),
      frame.y0 + ((H - PAD.b - py) / (H - PAD.t - PAD.b)) * (frame.y1 - frame.y0),
    ];
  };
  const finish = () => {
    if (!drag) return;
    const b = beadPops.find((x) => x.name === drag.bead);
    setDrag(null);
    if (!b || (Math.abs(drag.dx) < 1e-4 && Math.abs(drag.dy) < 1e-4)) return;
    const fx = 10 ** drag.dx;
    const fy = 10 ** drag.dy;
    // the shared gate: applies to every well of the plate (a well's own gate is not changed here)
    const shared = fs.populations().find((p) => p.id === b.id)?.gate as Poly | undefined;
    if (!shared || shared.type !== 'polygon') return;
    fs.setGate(b.id, { ...shared, points: shared.points.map((p) => [p[0] * fx, p[1] * fy]) });
    fs.notify(`${b.name} moved; applied to all wells${b.own ? ' (this well has its own gate, which stays as it is)' : ''}.`, 'success');
  };
  const ticks = (a: number, b: number) => Array.from({ length: Math.floor(b) - Math.ceil(a) + 1 }, (_, i) => Math.ceil(a) + i);
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', maxWidth: W, background: 'var(--surface, #fff)', touchAction: 'none' }}
      onPointerMove={(e) => {
        if (!drag) return;
        const [u, v] = toLog(e);
        setDrag({ ...drag, dx: u - drag.x0, dy: v - drag.y0 });
      }}
      onPointerUp={finish}
      onPointerLeave={finish}
    >
      <Dots pts={pts} frame={frame} />
      {beadPops.map((b, k) => {
        const d = drag && drag.bead === b.name ? drag : null;
        const p = b.gate.points.map(([x, y]) => [sx(lg(x) + (d?.dx ?? 0)), sy(lg(y) + (d?.dy ?? 0))]);
        const cx = p.reduce((a, q2) => a + q2[0], 0) / p.length;
        const cy = Math.min(...p.map((q2) => q2[1]));
        const n = counts.get(b.id) ?? 0;
        const c = COLORS[k % COLORS.length];
        const sel = b.name === selected;
        const movable = b.gate.points.every(([x, y]) => x > 1 && y > 1);
        return (
          <g
            key={b.id}
            style={{ cursor: movable ? 'move' : 'not-allowed' }}
            onPointerDown={(e) => {
              onSelect(b.name);
              if (!movable) return fs.notify(`${b.name}: a vertex at or below 1; this gate cannot be moved on log axes.`, 'error');
              (e.target as Element).setPointerCapture?.(e.pointerId);
              const [u, v] = toLog(e);
              setDrag({ bead: b.name, x0: u, y0: v, dx: 0, dy: 0 });
            }}
          >
            <polygon
              points={p.map((q2) => q2.join(',')).join(' ')}
              fill={sel ? 'rgba(37,99,235,0.12)' : 'rgba(0,0,0,0.01)'}
              stroke={c}
              strokeWidth={sel ? 2.2 : 1.2}
              strokeDasharray={b.own ? '4 2' : undefined}
            />
            <text x={cx} y={cy - 3} fontSize={10} fill={c} textAnchor="middle">
              {b.name} ({singles ? ((100 * n) / singles).toFixed(2) : '–'} %){b.own ? ' own' : ''}
            </text>
          </g>
        );
      })}
      {ticks(frame.x0, frame.x1).map((t) => (
        <g key={`x${t}`}>
          <line x1={sx(t)} x2={sx(t)} y1={H - PAD.b} y2={H - PAD.b + 4} stroke="currentColor" />
          <text x={sx(t)} y={H - PAD.b + 16} fontSize={10} textAnchor="middle" fill="currentColor">
            1e{t}
          </text>
        </g>
      ))}
      {ticks(frame.y0, frame.y1).map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l - 4} x2={PAD.l} y1={sy(t)} y2={sy(t)} stroke="currentColor" />
          <text x={PAD.l - 6} y={sy(t) + 3} fontSize={10} textAnchor="end" fill="currentColor">
            1e{t}
          </text>
        </g>
      ))}
      <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill="none" stroke="currentColor" opacity={0.4} />
      <text x={(W + PAD.l) / 2} y={H - 6} fontSize={11} textAnchor="middle" fill="currentColor">
        {xCh} (log)
      </text>
      <text x={12} y={(H - PAD.b) / 2} fontSize={11} textAnchor="middle" fill="currentColor" transform={`rotate(-90 12 ${(H - PAD.b) / 2})`}>
        {yCh} (log)
      </text>
    </svg>
  );
}
