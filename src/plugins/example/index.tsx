// Example plugin: a template for assay plugins (copy this folder to start one; see docs/PLUGINS.md). It shows the
// typical steps of a bead-based multiplex assay: find the bead populations (auto gate around a seed), read the reporter
// per bead population and sample, subtract the blanks, normalize, export. Everything goes through `fs`.
import { useMemo, useState } from 'react';
import { PLUGIN_API_VERSION, type FlowStatePlugin, type PluginContext, type PluginPageProps } from '../api';
import { beadMfi, DEFAULT_SETTINGS, parseSettings, resultRows, type BeadMfiSettings } from './compute';

function fmt(v: number | null): string {
  if (v === null) return '–';
  const a = Math.abs(v);
  return a >= 100 ? Math.round(v).toLocaleString('en-US') : a >= 1 ? v.toFixed(2) : v.toPrecision(3);
}

/** A list of checkboxes (ids in `all` order). */
function Pick({ all, value, onChange }: { all: { id: string; label: string }[]; value: string[]; onChange: (ids: string[]) => void }) {
  if (!all.length) return <p className="hint">None yet.</p>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
      {all.map((o) => (
        <label key={o.id} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={value.includes(o.id)}
            onChange={(e) => onChange(e.target.checked ? all.filter((x) => x.id === o.id || value.includes(x.id)).map((x) => x.id) : value.filter((x) => x !== o.id))}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** Find a bead population with the auto gate and add it (one undo step). */
function FindBeads({ fs }: { fs: PluginContext<BeadMfiSettings> }) {
  const samples = fs.samples().filter((s) => s.loaded);
  const chans = fs.channels();
  const [f, setF] = useState({ sample: '', x: '', y: '', sx: '', sy: '', name: 'Bead 1' });
  const set = (p: Partial<typeof f>) => setF((o) => ({ ...o, ...p }));
  const add = () => {
    const sampleId = f.sample || samples[0]?.id;
    const x = fs.findChannel(f.x);
    const y = fs.findChannel(f.y);
    if (!sampleId || !x || !y) return fs.notify('Choose a sample and the two bead channels.', 'error');
    const gate = fs.autoGate({ sampleId, x, y, seed: [Number(f.sx), Number(f.sy)] });
    if (!gate) return fs.notify('No bead population found at that point.', 'error');
    // the gate and its place in the settings are one undo step
    const id = fs.transaction(() => {
      const pop = fs.addGate({ name: f.name, gate });
      fs.setState((s) => ({ ...(s ?? DEFAULT_SETTINGS), beads: [...(s?.beads ?? []), pop] }));
      return pop;
    });
    fs.notify(`Added "${f.name}" with ${fs.count(sampleId, id)?.toLocaleString('en-US')} events in that sample.`, 'success');
  };
  const chanSel = (v: string, on: (v: string) => void, label: string) => (
    <select className="inp" style={{ width: 'auto', maxWidth: 220 }} aria-label={label} value={v} onChange={(e) => on(e.target.value)}>
      <option value="">{label}</option>
      {chans.map((c) => (
        <option key={c.name} value={c.name}>
          {c.label ? `${c.label} (${c.name})` : c.name}
        </option>
      ))}
    </select>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <select className="inp" style={{ width: 'auto', maxWidth: 220 }} aria-label="Sample" value={f.sample} onChange={(e) => set({ sample: e.target.value })}>
        {samples.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {chanSel(f.x, (v) => set({ x: v }), 'x channel')}
      {chanSel(f.y, (v) => set({ y: v }), 'y channel')}
      <input className="inp" style={{ width: 90 }} aria-label="Seed x" placeholder="seed x" value={f.sx} onChange={(e) => set({ sx: e.target.value })} />
      <input className="inp" style={{ width: 90 }} aria-label="Seed y" placeholder="seed y" value={f.sy} onChange={(e) => set({ sy: e.target.value })} />
      <input className="inp" style={{ width: 110 }} aria-label="Name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
      <button className="btn sm" onClick={add}>
        Add bead gate
      </button>
    </div>
  );
}

function Page({ fs, revision }: PluginPageProps<BeadMfiSettings>) {
  const s = fs.getState() ?? DEFAULT_SETTINGS;
  const update = (p: Partial<BeadMfiSettings>) => fs.setState((o) => ({ ...(o ?? DEFAULT_SETTINGS), ...p }));
  // everything read from fs depends on `revision`
  const result = useMemo(() => beadMfi(fs, s), [fs, s, revision]);
  const pops = useMemo(() => fs.populations().map((p) => ({ id: p.id, label: p.path })), [fs, revision]);
  const samples = useMemo(() => fs.samples().map((x) => ({ id: x.id, label: x.name })), [fs, revision]);
  const chans = useMemo(() => fs.channels(), [fs, revision]);
  const rows = resultRows(result, s);
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 1100 }}>
      <p className="hint">
        Example plugin: a template for assay plugins (bead-based multiplex assays and similar). Copy <code>src/plugins/example</code> to start your own; see
        docs/PLUGINS.md.
      </p>
      <div className="card">
        <div className="card-head">
          <h3>1. Bead populations</h3>
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 8 }}>
          <FindBeads fs={fs} />
          <Pick all={pops} value={s.beads} onChange={(beads) => update({ beads, normalizeTo: s.normalizeTo.filter((id) => beads.includes(id)) })} />
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>2. Reporter, blanks, normalization</h3>
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <select className="inp" style={{ width: 'auto', maxWidth: 260 }} aria-label="Reporter channel" value={s.reporter} onChange={(e) => update({ reporter: e.target.value })}>
              <option value="">Reporter channel</option>
              {chans.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label ? `${c.label} (${c.name})` : c.name}
                </option>
              ))}
            </select>
            <select className="inp" style={{ width: 'auto' }} aria-label="Statistic" value={s.stat} onChange={(e) => update({ stat: e.target.value as BeadMfiSettings['stat'] })}>
              <option value="median">Median</option>
              <option value="mean">Mean</option>
              <option value="geomean">Geometric mean</option>
            </select>
          </div>
          <b>Blank samples</b>
          <Pick all={samples} value={s.blanks} onChange={(blanks) => update({ blanks })} />
          <b>Normalize to the mean of</b>
          <Pick all={pops.filter((p) => s.beads.includes(p.id))} value={s.normalizeTo} onChange={(normalizeTo) => update({ normalizeTo })} />
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>3. Results{result.normalized ? ' (normalized)' : ''}</h3>
          <span style={{ flex: 1 }} />
          <button className="btn sm" disabled={!result.rows.length} onClick={() => void fs.saveCsv('bead-assay', rows)}>
            CSV
          </button>
          <button className="btn sm" disabled={!result.rows.length} onClick={() => void fs.saveXlsx('bead-assay', [{ name: 'Results', rows }])}>
            Excel
          </button>
        </div>
        <div className="card-body">
          {result.notes.map((n) => (
            <p key={n} className="hint">
              {n}
            </p>
          ))}
          {result.rows.length > 0 && (
            <div className="tbl-wrap">
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
                        <td key={k} className={k ? undefined : 'left'}>
                          {typeof v === 'number' || v === null ? fmt(v) : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const plugin: FlowStatePlugin<BeadMfiSettings> = {
  apiVersion: PLUGIN_API_VERSION,
  id: 'example',
  name: 'Example: bead assay',
  version: '1.0.0',
  description: 'Template for assay plugins: bead populations, reporter per bead and sample, blank subtraction, normalization, export.',
  author: 'FlowState',
  Page,
  parseState: parseSettings,
};

export default plugin;
