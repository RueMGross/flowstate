import { calibratedRangeNote } from '../core/derived';
import { engine } from '../core/engine';
import { allChannels, channelDisplayName, isAncestorPop, sampleHasChannel, popAncestors, popDescendants, popPath, STAT_LABELS, STAT_NEEDS_CHANNEL, uid, type ChartItem, type StatColumn, type StatKind, type TableDef, type Workspace } from '../core/model';
import { applies, resolvePopFor, statNotApplicableReason } from '../core/scope';
import { isScatterOrTime } from '../core/transforms';
import { excludedNote, formatStat } from '../core/stats';
import { csvCell, safeName, saveFile } from '../io/files';
import { writeXlsx } from '../io/xlsx';
import { newChartItem, pickMfiChannel, useStore } from '../state/store';
import { ChannelPicker } from './ChannelPicker';
import { Icon } from './icons';
import { addItems, findFreeSlot } from './layoutOps';
import { Num, Sel, Txt } from './widgets';

export function colHeader(ws: Workspace, c: StatColumn): { main: string; sub: string } {
  const pop = c.population === 'root' ? 'All Events' : popPath(ws, c.population);
  const ofName = c.ofPopulation && c.ofPopulation !== 'root' ? ws.populations.find((p) => p.id === c.ofPopulation)?.name ?? '?' : 'All Events';
  const badRef = c.stat === 'freqOf' && !isAncestorPop(ws, c.ofPopulation || 'root', c.population || 'root');
  const stat = c.stat === 'percentile' ? `P${c.percentile ?? 50}` : c.stat === 'freqOf' ? `% of ${ofName}${badRef ? ' (not an ancestor)' : ''}` : STAT_LABELS[c.stat];
  const ch = STAT_NEEDS_CHANNEL[c.stat] && c.channel ? ` ${channelDisplayName(ws, c.channel, 'both')}` : '';
  return { main: c.header || `${pop.split(' / ').pop()}`, sub: `${stat}${ch}` };
}

/** Loaded samples of a table's sample set, including those hidden from its rows. */
export function tableSetSamples(ws: Workspace, t: TableDef) {
  return ws.samples.filter((s) => engine.has(s.id) && (t.sampleSet === 'all' || ws.groups.find((g) => g.id === t.sampleSet)?.sampleIds.includes(s.id)));
}

/** Loaded samples in a table's rows (the sample set without the samples hidden from the table). */
export function tableSamples(ws: Workspace, t: TableDef) {
  return tableSetSamples(ws, t).filter((s) => !t.hiddenSamples?.includes(s.id));
}

/**
 * Header and rows of a table: the sample name, then one value per column. null: the statistic does not apply to the
 * sample (population of another group's gating tree, gate or statistic on a channel it lacks); shown as "n/a",
 * exported as an empty cell. NaN: applies but has no value (e.g. no events).
 */
export function tableMatrix(ws: Workspace, t: TableDef, opts: { deferred?: boolean } = {}): { header: string[]; rows: (string | number | null)[][]; pending: boolean } {
  const samples = tableSamples(ws, t);
  const header = ['Sample', ...t.columns.map((c) => {
    const h = colHeader(ws, c);
    return `${c.header || (c.population === 'root' ? 'All Events' : popPath(ws, c.population))} | ${h.sub}`;
  })];
  // on screen (deferred): a value on a channel computed in the background shows as "…" until it is in; exports
  // compute every value
  let pending = false;
  const value = (sid: string, c: StatColumn): string | number | null => {
    if (engine.statNotApplicable(ws, sid, c)) return null;
    if (!opts.deferred) return engine.stat(ws, sid, c);
    const v = engine.statForDisplay(ws, sid, c);
    if (v === null) pending = true;
    return v === null ? PENDING_CELL : v;
  };
  const rows = samples.map((s) => [s.name, ...t.columns.map((c) => value(s.id, c))]);
  return { header, rows, pending };
}

/** Text of a table cell whose value is still being computed in the background. */
export const PENDING_CELL = '…';

/** Cell value for CSV / TSV: numbers in full precision, empty for n/a and undefined values. */
function exportCell(v: string | number | null): string {
  return v === null ? '' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v;
}

/** Fluorescence channels for "MFI of all channels": measured area channels of the samples, then unmixed / MESF outputs. */
export function mfiChannels(ws: Workspace, sampleIds: string[]): string[] {
  const out: string[] = [];
  for (const s of ws.samples) {
    if (!sampleIds.includes(s.id)) continue;
    const names = s.channels.map((c) => c.name).filter((c) => !isScatterOrTime(c) && !/width|-W$|^W$/i.test(c));
    const area = names.filter((c) => /-A$|INT|AREA/i.test(c));
    for (const c of area.length ? area : names.filter((c) => !/-H$|height/i.test(c))) if (!out.includes(c)) out.push(c);
  }
  for (const d of ws.derived ?? []) if (d.kind !== 'size') for (const o of d.outputs) if (!out.includes(o.name)) out.push(o.name);
  return out;
}

// label parts that name a detector, a filter or a fluorochrome, not a marker ("V447-A", "B525/40", "PE-Cy7", "BV421")
const NOT_MARKER = new Set(
  (
    'a h w area height width int log lin comp fitc pe apc percp cy cy3 cy5 cy5.5 cy7 ecd pc5 pc5.5 pc7 texas red dazzle efluor alexa fluor af pb pacific ' +
    'blue orange green yellow violet aqua po bv buv bb sb nfb nf spark ko krome kro dapi pi aad sytox hoechst gfp egfp yfp rfp mcherry tdtomato qdot ' +
    'vio vioblue viogreen fl bl rl vl yl ssc fsc vssc bssc yssc rssc vfsc'
  ).split(' '),
);

/**
 * Whether a channel label ($PnS) names a marker ("CD4", "CD4 FITC", "Live/Dead"), not just the detector, the filter or
 * the fluorochrome (CytoFLEX "V447-A", "B525-FITC-A", "PE-Cy7"): what is left after removing such parts.
 */
export function isMarkerLabel(label: string | undefined, channel: string): boolean {
  const l = (label ?? '').trim();
  if (!l || l.toLowerCase() === channel.trim().toLowerCase()) return false;
  return l
    .split(/[\s_\-/:()]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
    .some((t) => !NOT_MARKER.has(t) && !NOT_MARKER.has(t.replace(/\d+$/, '')) && !/^\d+(\.\d+)?$/.test(t) && !DETECTOR.test(t));
}

// a laser / filter or dye name with its wavelength (V447, B525, BV421, BUV395, AF488, KO525) or a numbered detector (BL1, FL3)
const DETECTOR = /^(?:(?:v|b|r|y|g|uv|bv|buv|bb|af|a|ko|sb|nfb|nf|cf|dy|pe|apc|percp|spark|vio|ry|rb|ef|bl|rl|vl|yl|fl)?[3-8]\d\d[a-z]?|(?:fl|bl|rl|vl|yl|uv)\d{1,2})$/;

/**
 * Channels the MFI table dialog chooses at first: the ones gated on or with a marker label (set in the workspace, or a
 * $PnS naming a marker, see isMarkerLabel); all channels when there are at most 24 and none of them is such a channel,
 * none when there are more (e.g. 92 detectors of a CytoFLEX mosaic: the user picks, with the search field).
 */
export function mfiPreselect(ws: Workspace, channels: string[]): string[] {
  const gated = new Set(ws.populations.flatMap((p) => [p.gate, ...Object.values(p.overrides ?? {})]).flatMap((g) => (g.type === 'bool' ? [] : 'y' in g ? [g.x, g.y] : [g.x])));
  const marked = channels.filter((ch) => gated.has(ch) || !!ws.channelLabels[ch]?.trim() || ws.samples.some((s) => s.channels.some((c) => c.name === ch && isMarkerLabel(c.label, ch))));
  if (marked.length) return marked;
  return channels.length <= 24 ? channels : [];
}

/** What "MFI of all channels" would make: populations, sample set and, per population, the channels it has values for. */
export interface MfiPlan {
  /** selected population (the table covers it and those below it), or null: all populations */
  sel: string | null;
  pops: string[];
  /** sample set of the table: 'all' or the group filtering the sample list */
  filter: string;
  samples: string[];
  /** channels with values for at least one population, in channel order */
  channels: string[];
  /** population -> channels of the table's samples that the population applies to */
  perPop: Map<string, string[]>;
}

export function mfiTablePlan(ws: Workspace = useStore.getState().ws, ui = useStore.getState().ui): MfiPlan {
  const sel = ui.selectedPopId && ws.populations.some((p) => p.id === ui.selectedPopId) ? ui.selectedPopId : null;
  const pops = sel ? [sel, ...popDescendants(ws, sel)] : ws.populations.length ? ws.populations.map((p) => p.id) : ['root'];
  const filter = ui.sampleFilter !== 'all' && ws.groups.some((g) => g.id === ui.sampleFilter) ? ui.sampleFilter : 'all';
  const inSet = (id: string) => filter === 'all' || !!ws.groups.find((g) => g.id === filter)?.sampleIds.includes(id);
  const loaded = ws.samples.filter((s) => engine.has(s.id) && inSet(s.id)).map((s) => s.id);
  const samples = loaded.length ? loaded : ws.samples.filter((s) => inSet(s.id)).map((s) => s.id);
  const perPop = new Map<string, string[]>();
  for (const p of pops) {
    // only the samples the population applies to (a group-specific gate on another instrument adds no n/a columns)
    const where = samples.filter((sid) => applies(ws, sid, p));
    perPop.set(p, mfiChannels(ws, where).filter((ch) => where.some((sid) => sampleHasChannel(ws, sid, ch))));
  }
  const all = mfiChannels(ws, samples);
  const used = new Set([...perPop.values()].flat());
  return { sel, pops, filter, samples, channels: all.filter((c) => used.has(c)), perPop };
}

/**
 * A new table with, for each population (the selected one and those below it, else all), its count, % parent and the
 * median of the fluorescence channels of the samples it applies to (`chosen`: only these channels). Returns the table id.
 */
export function createMfiTable(chosen?: string[]): string | null {
  const st = useStore.getState();
  const ws = st.ws;
  const plan = mfiTablePlan(ws, st.ui);
  const pick = chosen ? new Set(chosen) : null;
  const chans = plan.channels.filter((c) => !pick || pick.has(c));
  if (!chans.length) {
    st.toast(plan.channels.length ? 'No channels chosen for the table.' : 'No fluorescence channels in the samples.', 'info');
    return null;
  }
  const id = uid('tbl');
  const columns: StatColumn[] = [];
  for (const p of plan.pops) {
    columns.push({ id: uid('col'), population: p, stat: 'count' });
    if (p !== 'root') columns.push({ id: uid('col'), population: p, stat: 'freqParent' });
    const own = new Set(plan.perPop.get(p) ?? []);
    for (const ch of chans) if (own.has(ch)) columns.push({ id: uid('col'), population: p, stat: 'median', channel: ch });
  }
  const sel = plan.sel;
  const name = `MFI ${sel ? ws.populations.find((p) => p.id === sel)!.name : 'all populations'}`;
  st.update((w) => {
    w.tables.push({ id, name, sampleSet: plan.filter, columns });
  });
  st.setUI({ activeTableId: id, view: 'tables' });
  st.toast(`Table "${name}": count, % parent and median of ${chans.length} channel${chans.length === 1 ? '' : 's'} for ${plan.pops.length} population${plan.pops.length > 1 ? 's' : ''}`, 'success');
  return id;
}

/** "MFI of all channels" from the interface: choose the channels first (dialog 'mfiTable'). */
export function openMfiTableDialog() {
  const st = useStore.getState();
  const plan = mfiTablePlan(st.ws, st.ui);
  if (!plan.channels.length) {
    st.toast('No fluorescence channels in the samples.', 'info');
    return;
  }
  st.setUI({ dialog: { kind: 'mfiTable' } });
}

/** Notes for cells whose statistic is based on fewer events than the population has (events without a value). */
export function tableNotes(ws: Workspace, t: TableDef): (string | null)[][] {
  // populations resolved per sample like the values (group-specific copies of a gating tree); not waiting for channels
  // computed in the background (no note meanwhile)
  return tableSamples(ws, t).map((s) =>
    t.columns.map((c) => {
      if (!(STAT_NEEDS_CHANNEL[c.stat] && c.channel)) return null;
      const r = engine.deferredValue(() => excludedNote(engine.channelStats(ws, s.id, resolvePopFor(ws, s.id, c.population || 'root'), c.channel!)));
      return r.pending ? null : r.value;
    }),
  );
}

/**
 * Notes for statistics of calibrated fluorescence (MESF ...) channels whose value lies outside the bead range of the
 * calibration (extrapolated), per cell of `rows` (tableMatrix rows: sample name first); null = none.
 */
export function tableRangeNotes(ws: Workspace, t: TableDef, rows: (string | number | null)[][]): (string | null)[][] {
  return rows.map((r) => t.columns.map((c, j) => (typeof r[j + 1] === 'number' ? calibratedRangeNote(ws.derived, c.channel, c.stat, r[j + 1] as number) : null)));
}

/** The reference population of a "% of" statistic if it is still an ancestor of `popId`, else 'root' (All Events). */
export function validOfPopulation(ws: Workspace, popId: string, ofPopulation: string | undefined): string {
  return ofPopulation && isAncestorPop(ws, ofPopulation, popId) ? ofPopulation : 'root';
}

export function ancestorOptions(ws: Workspace, popId: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [{ value: 'root', label: 'All Events' }];
  const anc = popAncestors(ws, popId).map((par) => ({ value: par.id, label: par.name }));
  return [...out, ...anc.reverse()];
}

/** A chart of a table column on the active worksheet; its samples are those of the table now (fixed). */
function chartFromColumn(c: StatColumn, t: TableDef) {
  const st = useStore.getState();
  const ws = st.ws;
  const sheet = ws.worksheets.find((s) => s.id === st.ui.activeSheetId) ?? ws.worksheets[0];
  const g = sheet.grid;
  const { x, y } = findFreeSlot(sheet, g * 14, g * 12);
  const it: ChartItem = newChartItem(x, y, g * 14, g * 12, c);
  if (it.mode === 'samples') {
    it.samples = tableSamples(ws, t).map((s) => s.id);
    it.sampleSet = t.sampleSet;
  }
  addItems(sheet.id, [it]);
}

export function TablesView() {
  const ws = useStore((s) => s.ws);
  const activeId = useStore((s) => s.ui.activeTableId);
  useStore((s) => s.ui.dataVersion);
  const st = useStore.getState();
  const table = ws.tables.find((t) => t.id === activeId) ?? ws.tables[0];
  const chans = allChannels(ws).map((c) => ({ value: c.name, label: channelDisplayName(ws, c.name) }));
  const pops = [{ value: 'root', label: 'All Events' }, ...ws.populations.map((p) => ({ value: p.id, label: popPath(ws, p.id) }))];
  const upT = (f: (t: TableDef) => void) => st.update((w) => {
    const t = w.tables.find((x) => x.id === table!.id);
    if (t) f(t as TableDef);
  });

  if (!table) {
    return (
      <div className="doc-view">
        <div className="card" style={{ maxWidth: 640 }}>
          <div className="card-head">
            <h3>Statistics tables</h3>
          </div>
          <div className="card-body">
            <p style={{ marginTop: 0 }}>Tables list statistics (counts, frequencies, MFI, CV …) for every sample in rows, ready for Excel or Prism.</p>
            <button
              className="btn primary"
              onClick={() => {
                const id = uid('tbl');
                st.update((w) => {
                  w.tables.push({ id, name: 'Table 1', sampleSet: 'all', columns: w.populations.map((p) => ({ id: uid('col'), population: p.id, stat: 'freqParent' as const })) });
                });
                st.setUI({ activeTableId: id });
              }}
            >
              <Icon.plus /> Create table with % parent of all populations
            </button>{' '}
            <button className="btn" title="Count, % parent and median of every fluorescence channel for the selected population and those below it (else all populations)" onClick={() => openMfiTableDialog()}>
              <Icon.plus /> MFI of all channels for all populations
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { header, rows } = tableMatrix(ws, table, { deferred: true });
  // exports compute every value (also those still computed in the background for the screen)
  const exact = () => tableMatrix(ws, table).rows;
  const rowIds = tableSamples(ws, table).map((s) => s.id);
  const notes = tableNotes(ws, table);
  const anyNote = notes.some((r) => r.some((n) => !!n));
  const rangeNotes = tableRangeNotes(ws, table, rows);
  const anyRange = rangeNotes.some((r) => r.some((n) => !!n));
  // n/a (null) and undefined values are empty cells, never 0
  const exportCsv = () => {
    const lines = [header.map(csvCell).join(','), ...exact().map((r) => r.map((v) => (typeof v === 'string' ? csvCell(v) : exportCell(v))).join(','))];
    saveFile(`${safeName(table.name)}.csv`, lines.join('\n'));
  };
  const exportXlsx = () => saveFile(`${safeName(table.name)}.xlsx`, writeXlsx(table.name, [header, ...exact().map((r) => r.map((v) => (v === null || (typeof v === 'number' && !Number.isFinite(v)) ? null : v)))]));
  const copyTsv = async () => {
    const txt = [header.join('\t'), ...exact().map((r) => r.map(exportCell).join('\t'))].join('\n');
    try {
      await navigator.clipboard.writeText(txt);
      st.toast('Table copied. Paste it into Excel or Prism.', 'success');
    } catch {
      st.toast('Clipboard is not available here. Use the CSV or Excel export.', 'error');
    }
  };
  const tblSampleIds = tableSamples(ws, table).map((s) => s.id);
  // samples of the set hidden from the rows (only in this table; the samples stay in the workspace)
  const hidden = tableSetSamples(ws, table).filter((s) => table.hiddenSamples?.includes(s.id));
  const hideSample = (id: string) => upT((t) => {
    t.hiddenSamples = [...(t.hiddenSamples ?? []).filter((x) => x !== id), id];
  });
  const showSamples = (ids: string[] | null) => upT((t) => {
    const keep = ids ? (t.hiddenSamples ?? []).filter((x) => !ids.includes(x)) : [];
    if (keep.length) t.hiddenSamples = keep;
    else delete t.hiddenSamples;
  });
  // channel statistics: per population, the marker it is gated on, else a fluorescence channel the table's samples have
  const addCols = (stat: StatKind, mfi = false) =>
    upT((t) => {
      const targets = st.ui.selectedPopId ? [st.ui.selectedPopId] : ws.populations.length ? ws.populations.map((p) => p.id) : ['root'];
      for (const p of targets) t.columns.push({ id: uid('col'), population: p, stat, channel: mfi ? pickMfiChannel(ws, tblSampleIds, p) : undefined });
    });

  return (
    <div className="doc-view">
      <div className="row" style={{ marginBottom: 10 }}>
        {ws.tables.map((t) => (
          <button key={t.id} className={`btn sm${t.id === table.id ? ' primary' : ''}`} onClick={() => st.setUI({ activeTableId: t.id })}>
            {t.name}
          </button>
        ))}
        <button
          className="btn sm"
          onClick={() => {
            const id = uid('tbl');
            st.update((w) => {
              w.tables.push({ id, name: `Table ${w.tables.length + 1}`, sampleSet: 'all', columns: [] });
            });
            st.setUI({ activeTableId: id });
          }}
        >
          <Icon.plus /> New table
        </button>
        <button className="btn sm" title="New table: count, % parent and median of every fluorescence channel for the selected population and those below it (else all populations)" onClick={() => openMfiTableDialog()}>
          <Icon.plus /> MFI of all channels
        </button>
      </div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <div style={{ width: 220 }}>
            <Txt value={table.name} ariaLabel="Table name" onChange={(v) => upT((t) => {
              t.name = v || t.name;
            })} />
          </div>
          <div style={{ width: 170 }}>
            <Sel value={table.sampleSet} ariaLabel="Rows" options={[{ value: 'all', label: 'All samples' }, ...ws.groups.map((g) => ({ value: g.id, label: `Group: ${g.name}` }))]} onChange={(v) => upT((t) => {
              t.sampleSet = v;
            })} />
          </div>
          <span className="hint">
            {rows.length} samples × {table.columns.length} statistics{hidden.length ? ` (${hidden.length} hidden)` : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={copyTsv}>
            <Icon.copy /> Copy
          </button>
          <button className="btn sm" onClick={exportCsv}>
            CSV
          </button>
          <button className="btn sm primary" onClick={exportXlsx}>
            <Icon.export /> Excel
          </button>
          <button
            className="btn sm"
            style={{ color: 'var(--danger)' }}
            onClick={() => {
              st.update((w) => {
                w.tables = w.tables.filter((t) => t.id !== table.id);
              });
              st.setUI({ activeTableId: null });
            }}
          >
            Delete table
          </button>
        </div>
        <div className="card-body tbl-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="left">Sample</th>
                {table.columns.map((c) => {
                  const h = colHeader(ws, c);
                  return (
                    <th key={c.id} className="tbl-col">
                      {h.main}
                      <span className="sub">{h.sub}</span>
                      <button className="icon-btn danger tbl-x" aria-label="Remove column" title="Remove this statistic from the table" onClick={() => upT((t) => {
                        t.columns = t.columns.filter((x) => x.id !== c.id);
                      })}>
                        <Icon.close />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={rowIds[i]} className="tbl-row">
                  {r.map((v, j) => {
                    const note = j > 0 && v !== null ? notes[i]?.[j - 1] : null;
                    const rnote = j > 0 ? rangeNotes[i]?.[j - 1] : null;
                    const na = j > 0 && v === null ? statNotApplicableReason(ws, rowIds[i], table.columns[j - 1]) : null;
                    const tip = [note, rnote].filter(Boolean).join('\n');
                    return (
                      <td key={j} className={j === 0 ? 'left' : ''} title={na ? `Not applicable: ${na}` : tip || undefined} style={na ? { color: 'var(--text-3)', fontStyle: 'italic' } : undefined}>
                        {j === 0 && (
                          <button className="icon-btn tbl-x" aria-label="Hide sample" title="Hide this sample from the table (it stays in the workspace; show it again below the table)" onClick={() => hideSample(rowIds[i])}>
                            <Icon.close />
                          </button>
                        )}
                        {v === null ? 'n/a' : typeof v === 'number' ? formatStat(v, table.columns[j - 1].stat) : v}
                        {note && (
                          <sup className="tbl-note" aria-label="based on fewer events" style={{ color: 'var(--text-3)', marginLeft: 1 }}>
                            *
                          </sup>
                        )}
                        {rnote && (
                          <sup className="tbl-note" aria-label="outside the calibrated bead range" style={{ color: 'var(--warn-text)', marginLeft: 1 }}>
                            †
                          </sup>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td className="left" colSpan={table.columns.length + 1} style={{ color: 'var(--text-3)' }}>
                    {hidden.length ? 'All samples are hidden.' : 'No loaded samples.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {hidden.length > 0 && (
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <span className="hint">Hidden from this table:</span>
              {hidden.map((s) => (
                <button key={s.id} className="btn sm" title="Show this sample in the table again" onClick={() => showSamples([s.id])}>
                  {s.name} <Icon.plus />
                </button>
              ))}
              {hidden.length > 1 && (
                <button className="btn sm" onClick={() => showSamples(null)}>
                  Show all
                </button>
              )}
            </div>
          )}
          {anyNote && (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              * Based on fewer events than the population has: some events have no value in this channel (e.g. outside a calibrated range). Hover the value for the counts.
            </p>
          )}
          {anyRange && (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              † Outside the calibrated bead range: the value lies below the dimmest or above the brightest bead used in the fluorescence calibration and is extrapolated from the regression. Hover the value for the range.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Columns</h3>
          <span style={{ flex: 1 }} />
          <span className="hint">Quick add{st.ui.selectedPopId ? ' for the selected population' : ' for all populations'}:</span>
          <button className="btn sm" onClick={() => addCols('freqParent')}>
            % Parent
          </button>
          <button className="btn sm" onClick={() => addCols('count')}>
            Count
          </button>
          <button className="btn sm" title="Median of the marker each population is gated on (else of a fluorescence channel the samples have)" onClick={() => addCols('median', true)}>
            Median (MFI)
          </button>
        </div>
        <div className="card-body tbl-wrap">
          <table className="data" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th className="left">Population</th>
                <th className="left">Statistic</th>
                <th className="left">Parameter</th>
                <th className="left">Header (optional)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {table.columns.map((c, i) => (
                <tr key={c.id}>
                  <td className="left" style={{ minWidth: 200 }}>
                    <Sel value={c.population} options={pops} ariaLabel="Population" onChange={(v) => upT((t) => {
                      t.columns[i].population = v;
                      // a "% of" reference that is no longer an ancestor would give meaningless values (> 100 %)
                      if (t.columns[i].ofPopulation && !isAncestorPop(ws, t.columns[i].ofPopulation!, v)) t.columns[i].ofPopulation = 'root';
                    })} />
                  </td>
                  <td className="left">
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <Sel value={c.stat} ariaLabel="Statistic" options={(Object.keys(STAT_LABELS) as StatKind[]).map((k) => ({ value: k, label: STAT_LABELS[k] }))} onChange={(v) => upT((t) => {
                        t.columns[i].stat = v;
                        if (STAT_NEEDS_CHANNEL[v] && !t.columns[i].channel) t.columns[i].channel = pickMfiChannel(ws, tblSampleIds, t.columns[i].population) ?? chans[0]?.value;
                      })} />
                      {c.stat === 'percentile' && (
                        <div style={{ width: 64 }}>
                          <Num value={c.percentile ?? 50} min={0} max={100} ariaLabel="Percentile" onChange={(v) => upT((t) => {
                            t.columns[i].percentile = v;
                          })} />
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="left" style={{ minWidth: 160 }}>
                    {STAT_NEEDS_CHANNEL[c.stat] ? (
                      <ChannelPicker value={c.channel ?? chans[0]?.value ?? ''} samples={tblSampleIds} ariaLabel="Parameter" onChange={(v) => upT((t) => {
                        t.columns[i].channel = v;
                      })} />
                    ) : c.stat === 'freqOf' ? (
                      <>
                        <Sel value={validOfPopulation(ws, c.population, c.ofPopulation)} options={ancestorOptions(ws, c.population)} ariaLabel="Reference population" onChange={(v) => upT((t) => {
                          t.columns[i].ofPopulation = v;
                        })} />
                        {c.ofPopulation && c.ofPopulation !== validOfPopulation(ws, c.population, c.ofPopulation) && (
                          <span className="hint" style={{ color: 'var(--danger)' }}>
                            The reference is not an ancestor of this population: choose one.
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="hint">–</span>
                    )}
                  </td>
                  <td className="left">
                    <Txt value={c.header ?? ''} placeholder="auto" ariaLabel="Header" onChange={(v) => upT((t) => {
                      t.columns[i].header = v || undefined;
                    })} />
                  </td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <button className="icon-btn" title="Add a chart of this column to the worksheet (samples of this table)" aria-label="Chart" onClick={() => chartFromColumn(c, table)}>
                        <Icon.barchart />
                      </button>
                      <button className="icon-btn" aria-label="Move up" title="Move this column up" disabled={i === 0} onClick={() => upT((t) => {
                        const [x] = t.columns.splice(i, 1);
                        t.columns.splice(i - 1, 0, x);
                      })}>
                        ↑
                      </button>
                      <button className="icon-btn danger" aria-label="Remove column" title="Remove this column" onClick={() => upT((t) => {
                        t.columns.splice(i, 1);
                      })}>
                        <Icon.close />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => upT((t) => {
              t.columns.push({ id: uid('col'), population: st.ui.selectedPopId ?? 'root', stat: 'count' });
            })}>
              <Icon.plus /> Add column
            </button>
          </div>
          <p className="hint">Statistics are computed on compensated linear values. Geometric mean uses positive events only; robust CV = 100 × ½(P84.13 − P15.87) / median.</p>
        </div>
      </div>
    </div>
  );
}
