// "How do I …" (manual, show-me targets) and "Analyze new files" (which files, plan request and parsing, revision with
// the user's notes, the whole run on the demo data with a mock provider: groups, AI gates, figures, tables, results
// text, disclaimer, one undo step). No network: the mock hook answers.
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { PROTOCOL_MAX_CHARS, readProtocol } from '../src/io/protocol';
import { writeXlsxBook } from '../src/io/xlsx';
import { analyzedSampleIds, DISCLAIMER, newSampleIds, parsePlan, planRequest, runAnalysis } from '../src/ai/analysis';
import { findPlot } from '../src/ai/gate';
import { helpPrompt, parseHelp, parseTarget, RIBBON_DOC } from '../src/ai/manual';
import { getProvider, type MockFn } from '../src/ai/provider';
import { useAiSettings } from '../src/ai/settings';
import { engine } from '../src/core/engine';
import { newWorksheet, type PlotItem } from '../src/core/model';
import { resolveLayers } from '../src/render/plot';
import { loadDemo } from '../src/state/demo';
import { useStore } from '../src/state/store';
import { autoGateAt, autoSession, createPolygon, createRange, onAutoPreview, type PlotAxes } from '../src/ui/gateOps';

const g = globalThis as { __flowstateAiMock?: MockFn };
let answer: MockFn = () => '{}';
g.__flowstateAiMock = (r) => answer(r);
const st = () => useStore.getState();
const signal = () => new AbortController().signal;

describe('How do I …: manual and targets', () => {
  it('every button the manual names exists in the ribbon with that label', () => {
    const src = readFileSync('src/ui/Ribbon.tsx', 'utf8') + readFileSync('src/ui/ai/AiPanel.tsx', 'utf8');
    const missing: string[] = [];
    for (const t of RIBBON_DOC)
      for (const grp of t.groups) {
        expect(src).toContain(`label="${grp.name.replace('&', '&')}"`);
        for (const b of grp.buttons) {
          const q = b.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (!new RegExp(`label="${q}"|'${q}'`).test(src)) missing.push(`${t.id}:${b.label}`);
        }
      }
    expect(missing).toEqual([]);
  });

  it('targets: known buttons and areas only, case-insensitive, brackets tolerated', () => {
    expect(parseTarget('gate:Polygon')).toEqual({ tab: 'gate', label: 'Polygon' });
    expect(parseTarget('[home:auto gate]')).toEqual({ tab: 'home', label: 'Auto gate' });
    expect(parseTarget('Statistics:MFI table')).toEqual({ tab: 'tables', label: 'MFI table' });
    expect(parseTarget('area:populations')).toEqual({ area: 'populations' });
    expect(parseTarget('gate:Magic wand')).toBeNull();
    expect(parseTarget('area:kitchen')).toBeNull();
    expect(parseTarget(42)).toBeNull();
    const a = parseHelp({ answer: 'Use the auto gate.', steps: [{ text: 'Open Home', show: 'home:Auto gate' }, { text: 'Click the cluster', show: 'plot:Nope' }, 'Press Enter', { text: '' }], tip: 'W is the shortcut' });
    expect(a.steps).toEqual([
      { text: 'Open Home', show: { tab: 'home', label: 'Auto gate' } },
      { text: 'Click the cluster', show: null },
      { text: 'Press Enter', show: null },
    ]);
    const p = helpPrompt('how do I gate lymphocytes?', 'the sheet view');
    expect(p).toContain('[home:Auto gate]');
    expect(p).toContain('[area:inspector]');
    expect(p).toContain('how do I gate lymphocytes?');
  });
});

describe('Analyze new files (mock provider, demo data without its analysis)', () => {
  loadDemo();
  useAiSettings.getState().set({ provider: 'auto', anonymize: true });
  // the demo's files, as if just loaded: no gates, groups, tables or figures
  st().update((w) => {
    w.populations = [];
    w.groups = [];
    w.tables = [];
    w.worksheets = [newWorksheet('Sheet 1')];
  });
  st().setUI({ activeSheetId: st().ws.worksheets[0].id });
  const ids = () => st().ws.samples.map((s) => s.id);

  it('new files: not on a sheet, chart or group yet', () => {
    expect(newSampleIds(st().ws)).toEqual(ids());
    expect(analyzedSampleIds(st().ws).size).toBe(0);
  });

  it('plan request: file facts, panel, existing gates, goal, the user review on revision', () => {
    useAiSettings.getState().set({ anonymize: false });
    const r = planRequest(st().ws, ids(), { names: true, goal: 'CD69 on CD4 T cells, stim vs unstim' });
    expect(r.refs).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(r.prompt).toContain('Donor A stim');
    expect(r.prompt).toContain('APC-A: CD69');
    expect(r.prompt).toContain('(no gates yet)');
    expect(r.prompt).toContain('CD69 on CD4 T cells, stim vs unstim');
    const plan = parsePlan(st().ws, r, {
      groups: [{ name: 'stim', role: 'sample', samples: ['S3', 'S5'] }],
      gating: [{ name: 'Cells', parent: 'All events', plot: '2d', x: 'FSC-A', y: 'SSC-A', target: 'cells' }],
      outputs: [{ kind: 'chart', title: 'Live', population: 'Cells', stat: 'freqParent' }],
    });
    plan.groups[0].on = false;
    plan.gating[0].remark = 'use SSC-H instead';
    const rev = planRequest(st().ws, ids(), { names: true, feedback: { plan, notes: 'S2 and S4 are unstimulated' } });
    expect(rev.prompt).toContain('- [removed] stim (sample): S3, S5');
    expect(rev.prompt).toContain('NOTE: use SSC-H instead');
    expect(rev.prompt).toContain('S2 and S4 are unstimulated');
    // hidden names: tube names are not sent
    useAiSettings.getState().set({ anonymize: true });
    expect(planRequest(st().ws, ids(), { names: false }).prompt).not.toContain('Donor A');
    // tube names ticked on purpose: sent although names are hidden elsewhere
    expect(planRequest(st().ws, ids(), { names: true }).prompt).toContain('Donor A stim');
  });

  it('plan parsing: refs to samples, channels by marker, unknown kinds and stats dropped or switched off', () => {
    const r = planRequest(st().ws, ids(), { names: false });
    const plan = parsePlan(st().ws, r, {
      summary: 'T-cell activation.',
      gatingSample: 's3',
      groups: [
        { name: 'unstim', role: 'sample', samples: ['S2', 'S4', 'S99'] },
        { name: 'again', role: 'weird', samples: ['S2', 'S1'] },
      ],
      gating: [{ name: 'Live', parent: 'All events', plot: 'histogram', x: 'Viability', target: 'live' }],
      outputs: [
        { kind: 'pie', title: 'nope' },
        { kind: 'overlay', title: 'CD69', population: 'Live', x: 'CD69', samples: ['S3', 'S2'] },
        { kind: 'chart', title: 'MFI', population: 'Live', stat: 'median', channel: 'BV999' },
        { kind: 'chart', title: 'pct', population: 'Live', stat: 'percentile' },
        { kind: 'table', title: 't', columns: [{ population: 'Live', stat: 'median', channel: 'CD4' }, { population: 'Live', stat: 'bogus' }] },
      ],
    });
    expect(plan.gatingSample).toBe(ids()[2]);
    expect(plan.groups.map((x) => [x.name, x.role, x.sampleIds.length])).toEqual([
      ['unstim', 'sample', 2],
      ['again', 'other', 1], // S2 is in "unstim" already
    ]);
    expect(plan.gating[0].x).toBe('KO525-A');
    expect(plan.outputs.map((o) => o.kind)).toEqual(['overlay', 'chart', 'chart', 'table']);
    expect(plan.outputs[0].x).toBe('APC-A');
    expect(plan.outputs[0].sampleIds).toEqual([ids()[2], ids()[1]]);
    expect(plan.outputs[1].on).toBe(false);
    expect(plan.outputs[1].note).toMatch(/BV999/);
    expect(plan.outputs[2].stat).toBe('freqParent');
    expect(plan.outputs[3].columns).toEqual([{ population: 'Live', stat: 'median', channel: 'PC7-A' }]);
  });

  it('run: groups, AI gates, strategy / grid sheets, report with charts, overlay, results and disclaimer; one undo step', async () => {
    const r = planRequest(st().ws, ids(), { names: false });
    const plan = parsePlan(st().ws, r, {
      summary: 'Two donors, stimulated and unstimulated, CD69 activation.',
      gatingSample: 'S3',
      groups: [
        { name: 'Unstained', role: 'unstained', samples: ['S1'] },
        { name: 'unstim', role: 'sample', samples: ['S2', 'S4'] },
        { name: 'stim', role: 'sample', samples: ['S3', 'S5'] },
      ],
      gating: [
        { name: 'Cells', parent: 'All events', plot: '2d', x: 'FSC-A', y: 'SSC-A', target: 'cells' },
        { name: 'Singlets', parent: 'Cells', plot: '2d', x: 'FSC-A', y: 'FSC-H', target: 'singlets' },
        { name: 'Live', parent: 'Singlets', plot: 'histogram', x: 'Viability', target: 'viability dye negative' },
      ],
      outputs: [
        { kind: 'strategy', title: 'Gating strategy' },
        { kind: 'grid', title: 'Scatter per sample', population: 'All events', x: 'FSC-A', y: 'SSC-A' },
        { kind: 'overlay', title: 'CD69 on live cells', population: 'Live', x: 'CD69' },
        { kind: 'chart', title: '% live', population: 'Live', stat: 'freqParent' },
        { kind: 'chart', title: 'CD69 median', population: 'Live', stat: 'median', channel: 'CD69' },
        { kind: 'chart', title: 'Martians', population: 'Martians', stat: 'count' },
        { kind: 'table', title: 'Summary', columns: [{ population: 'Cells', stat: 'count' }, { population: 'Live', stat: 'freqParent' }, { population: 'Live', stat: 'median', channel: 'CD69' }] },
      ],
      assumptions: ['S1 is the unstained control'],
    });
    let resultsPrompt = '';
    answer = (q) => {
      if (q.prompt.includes('Write the results section')) {
        resultsPrompt = q.prompt;
        return '{"headline": "Stimulation raised CD69.", "findings": ["Live cells were about 90 % of singlets."], "caveats": ["n = 2 per group"], "next": []}';
      }
      return '{"found": true, "peak": "P1", "confidence": 0.7, "rationale": "largest population"}';
    };
    // a stand-in for the plot view accepts every preview (as in the strategy runner test)
    const axesOf = (it: PlotItem): PlotAxes => ({ xScale: engine.scaleOf(st().ws, it.xParam), yScale: it.plotType === 'histogram' ? null : engine.scaleOf(st().ws, it.yParam) });
    const off = onAutoPreview((q) => {
      const it = findPlot(q.itemId)!;
      const prim = resolveLayers(it, st().ws, st().ui.activeSampleId, engine)[0];
      const s = autoSession(st().ws, it, axesOf(it), prim.sampleId, prim.popId)!;
      const res = autoGateAt(s, axesOf(it), q.seed, q.alpha);
      if (!res) return 'none';
      const p = res.kind === '2d' ? createPolygon(it, res.raw, q.meta.extra) : createRange(it, res.min, res.max, undefined, q.meta.extra);
      setTimeout(() => q.onDone?.(p?.id ?? null), 0);
      return { ok() {}, cancel() {} };
    });
    const before = st().ws;
    const pastLen = st().past.length;
    const status: string[] = [];
    const res = await runAnalysis(plan, r.ids, { provider: (await getProvider())!, images: false, signal: signal(), setHandle: () => {}, setPrep: () => {}, status: (t) => status.push(t), step: () => {}, names: false });
    off();
    const ws = st().ws;
    expect(res.gates).toBe(3);
    expect(ws.populations.map((p) => p.name)).toEqual(['Cells', 'Singlets', 'Live']);
    expect(ws.populations.every((p) => p.provenance?.method === 'ai-autogate')).toBe(true);
    expect(ws.groups.map((x) => [x.name, x.sampleIds.length])).toEqual([
      ['Unstained', 1],
      ['unstim', 2],
      ['stim', 2],
    ]);
    expect(st().ui.activeSampleId).toBe(ids()[2]);
    expect(res.sheets).toEqual(['AI analysis', 'AI gating', 'Gating strategy', 'AI: Scatter per sample']);
    const report = ws.worksheets.find((w) => w.name === 'AI analysis')!;
    const charts = report.items.filter((i) => i.kind === 'chart');
    expect(charts.length).toBe(2);
    // per condition group, not the unstained control
    expect(charts.every((c) => c.kind === 'chart' && c.mode === 'groups' && c.groups!.length === 2)).toBe(true);
    const overlay = report.items.find((i) => i.kind === 'plot') as PlotItem;
    expect(overlay.plotType).toBe('histogram');
    expect(overlay.xParam).toBe('APC-A');
    expect(overlay.layers.map((l) => l.sample)).toEqual([ids()[1], ids()[2]]); // one sample per condition
    const texts = report.items.filter((i) => i.kind === 'text').map((i) => (i.kind === 'text' ? i.text : ''));
    expect(texts).toContain(DISCLAIMER);
    expect(texts.some((t) => t.startsWith('Results (AI draft') && t.includes('Stimulation raised CD69.'))).toBe(true);
    const grid = ws.worksheets.find((w) => w.name === 'AI: Scatter per sample')!;
    expect(grid.items.filter((i) => i.kind === 'plot').length).toBe(5);
    expect(grid.items.some((i) => i.kind === 'text' && i.text.includes(DISCLAIMER))).toBe(true);
    expect(ws.worksheets.find((w) => w.name === 'Gating strategy')!.items.some((i) => i.kind === 'text' && i.text === DISCLAIMER)).toBe(true);
    expect(ws.tables.map((t) => [t.name, t.columns.length])).toEqual([['AI: Summary', 3]]);
    expect(res.skipped.some((x) => x.includes('Martians'))).toBe(true);
    expect(res.results?.findings).toEqual(['Live cells were about 90 % of singlets.']);
    // the results were written from the computed numbers, names hidden
    expect(resultsPrompt).toMatch(/Live, % Parent \(% live\):\n {2}per sample: Sample 1 [\d.]+; Sample 2/);
    expect(resultsPrompt).toMatch(/group G\d \(stim\): mean [\d.]+, SD [\d.]+, n 2/);
    expect(resultsPrompt).not.toContain('Donor');
    expect(status[0]).toMatch(/groups/);
    // every file is analyzed now
    expect(newSampleIds(ws)).toEqual([]);
    // one undo step for all of it
    expect(st().past.length).toBe(pastLen + 1);
    st().undo();
    expect(st().ws).toBe(before);
  });
});

describe('protocol attached for the AI', () => {
  it('xlsx written by FlowState: grid with column letters and row numbers', () => {
    const bytes = writeXlsxBook([
      { name: 'Layout', rows: [['', 1, 2, 3], ['A', 'PBS', 'EV 1:10', 'EV 1:100'], ['B', 'unstained', 'EV + Triton', null]] },
      { name: 'Notes', rows: [['Question: do EVs carry CD63?'], ['Expect CD63+ > 20 % in EV wells']] },
    ]);
    const p = readProtocol('plate.xlsx', bytes);
    expect(p.text).toContain('Sheet "Layout"');
    expect(p.text).toContain('\tA\tB\tC\tD');
    expect(p.text).toContain('2\tA\tPBS\tEV 1:10\tEV 1:100');
    expect(p.text).toContain('3\tB\tunstained\tEV + Triton');
    expect(p.text).toContain('Expect CD63+ > 20 % in EV wells');
    expect(p.truncated).toBe(false);
  });

  it('xlsx as Excel writes it: shared strings, gaps between cells, numbers', () => {
    const files = {
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Plate 1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Well</t></si><si><r><t>Drug </t></r><r><t>A</t></r></si><si><t>µM</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>B07</t></is></c><c r="D4"><v>2.5</v></c></row></sheetData></worksheet>'),
    };
    const p = readProtocol('layout.xlsx', zipSync(files));
    expect(p.text).toContain('Sheet "Plate 1"');
    expect(p.text).toContain('1\tWell\t\tDrug A\tµM');
    expect(p.text).toContain('4\tB07\t\t\t2.5');
  });

  it('docx paragraphs, csv as is; other types and empty files are refused', () => {
    const docx = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Stain: CD9 </w:t></w:r><w:r><w:t>FITC</w:t></w:r></w:p><w:p><w:r><w:t>Gate on live cells</w:t></w:r></w:p></w:body></w:document>') });
    expect(readProtocol('protocol.docx', docx).text).toBe('Stain: CD9 FITC\nGate on live cells');
    expect(readProtocol('samples.csv', strToU8('tube,condition\r\n1,stim\r\n')).text).toBe('tube,condition\n1,stim');
    expect(() => readProtocol('old.xls', new Uint8Array(4))).toThrow(/xlsx/);
    expect(() => readProtocol('empty.txt', new Uint8Array(0))).toThrow(/no text/);
    expect(() => readProtocol('broken.xlsx', new Uint8Array([1, 2, 3]))).toThrow(/could not be opened/);
    const long = readProtocol('long.txt', strToU8('x'.repeat(PROTOCOL_MAX_CHARS + 10)));
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(PROTOCOL_MAX_CHARS);
  });

  it('goes into the plan request', () => {
    const ids = st().ws.samples.map((s) => s.id);
    const r = planRequest(st().ws, ids, { names: false, protocol: { name: 'plate.xlsx', text: 'A1\tPBS buffer control', truncated: false } });
    expect(r.prompt).toContain('protocol (file "plate.xlsx")');
    expect(r.prompt).toContain('A1\tPBS buffer control');
  });
});
