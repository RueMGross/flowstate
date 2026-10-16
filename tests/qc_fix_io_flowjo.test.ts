// QC fixes (import): FlowJo workspaces whose samples share a file name are linked by path, event count and keywords
// (each file to one sample, unclear cases left unlinked and reported); the large-load question for files opened with a
// FlowJo workspace and for bundles; no second copy of the bytes when a workspace is opened.
import { strToU8, zipSync } from 'fflate';
import { writeFcs } from '../src/core/fcs';
import { engine } from '../src/core/engine';
import { newBlankWorkspace, openFiles, openWorkspace, serializeWorkspace } from '../src/io/files';
import { setRelativePath } from '../src/io/folders';
import { loadFcsFiles, setLargeLoadPrompt, useStore, type LargeLoad, type LargeLoadChoice } from '../src/state/store';

const G = globalThis as unknown as Record<string, unknown>;
const NS =
  'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';

interface WspSample {
  id: number;
  uri: string;
  tot: number;
  kw?: Record<string, string>;
}
function wsp(samples: WspSample[]): string {
  const one = (s: WspSample) => {
    const name = s.uri.split('/').pop()!;
    const kw = { $PAR: '2', $TOT: String(s.tot), $P1N: 'FSC-A', $P1R: '262144', $P2N: 'SSC-A', $P2R: '262144', ...(s.kw ?? {}) };
    return `<Sample><DataSet uri="${s.uri}" sampleID="${s.id}"/><Keywords>${Object.entries(kw)
      .map(([k, v]) => `<Keyword name="${k}" value="${v}"/>`)
      .join('')}</Keywords>
  <SampleNode name="${name}" count="${s.tot}" sampleID="${s.id}"><Subpopulations>
  <Population name="Hi" count="-1"><Gate><gating:RectangleGate eventsInside="1"><gating:dimension gating:min="1000"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension></gating:RectangleGate></Gate></Population>
  </Subpopulations></SampleNode></Sample>`;
  };
  return `<?xml version="1.0"?><Workspace version="20.0" flowJoVersion="10.8.1" ${NS}><SampleList>${samples.map(one).join('')}</SampleList></Workspace>`;
}

/** An FCS file of `n` events: FSC-A = base, base + 1, ...; SSC-A = 0, 1, ... */
function fcsBytes(n: number, base: number, kw: Record<string, string> = {}): Uint8Array {
  const a = new Float32Array(n).map((_, i) => base + i);
  const b = new Float32Array(n).map((_, i) => i);
  return writeFcs({ channels: [{ name: 'FSC-A', range: 262144 }, { name: 'SSC-A', range: 262144 }], data: [a, b], keywords: kw });
}
const fcsFile = (name: string, n: number, base: number, kw: Record<string, string> = {}, path?: string) => {
  const f = new File([fcsBytes(n, base, kw) as BlobPart], name);
  if (path) setRelativePath(f, path);
  return f;
};

const st = () => useStore.getState();
const toasts = () => st().ui.toasts.map((t) => t.text);
/** First FSC-A value of the data loaded for the sample whose FlowJo uri has `folder` (null: not loaded). */
const firstFsc = (sampleIndex: number) => {
  const s = st().ws.samples[sampleIndex];
  const sd = engine.samples.get(s.id);
  return sd ? sd.ds.data[0][0] : null;
};

beforeEach(() => {
  newBlankWorkspace();
  st().setUI({ toasts: [] } as never);
});

describe('FlowJo import: samples whose files share a base name (plate1/A1.fcs, plate2/A1.fcs)', () => {
  const two = (tot1: number, tot2: number, kw1?: Record<string, string>, kw2?: Record<string, string>) =>
    wsp([
      { id: 1, uri: 'file:/C:/data/plate1/A1.fcs', tot: tot1, kw: kw1 },
      { id: 2, uri: 'file:/C:/data/plate2/A1.fcs', tot: tot2, kw: kw2 },
    ]);

  it('a dropped folder: each sample gets the file of its own folder (same event counts)', async () => {
    // (plate2's file first: the order of the files does not matter)
    await openFiles([new File([two(300, 300)], 'plates.wsp'), fcsFile('A1.fcs', 300, 5000, {}, 'data/plate2/A1.fcs'), fcsFile('A1.fcs', 300, 0, {}, 'data/plate1/A1.fcs')]);
    expect(st().ws.samples).toHaveLength(2);
    expect(firstFsc(0)).toBe(0);
    expect(firstFsc(1)).toBe(5000);
    expect(st().ui.missingFiles).toEqual([]);
    // the gate counts its own sample's data
    const ws = st().ws;
    const pop = ws.populations.find((p) => p.name === 'Hi')!;
    expect(engine.count(ws, ws.samples[0].id, pop.id)).toBe(0);
    expect(engine.count(ws, ws.samples[1].id, pop.id)).toBe(300);
  });

  it('a zip with the folders', async () => {
    const zip = zipSync({ 'exp/plates.wsp': strToU8(two(300, 300)), 'exp/plate2/A1.fcs': fcsBytes(300, 5000), 'exp/plate1/A1.fcs': fcsBytes(300, 0) });
    await openFiles([new File([zip as BlobPart], 'exp.zip')]);
    expect(st().ws.samples).toHaveLength(2);
    expect(firstFsc(0)).toBe(0);
    expect(firstFsc(1)).toBe(5000);
  });

  it('files without folders: told apart by event count ($TOT)', async () => {
    await openFiles([new File([two(300, 500)], 'plates.wsp'), fcsFile('A1.fcs', 500, 5000), fcsFile('A1.fcs', 300, 0)]);
    expect(st().ws.samples.map((s) => engine.samples.get(s.id)?.ds.eventCount)).toEqual([300, 500]);
    expect(firstFsc(0)).toBe(0);
    expect(firstFsc(1)).toBe(5000);
  });

  it('same event count: told apart by $DATE', async () => {
    const d1 = { $DATE: '01-JAN-2026' };
    const d2 = { $DATE: '02-JAN-2026' };
    await openFiles([new File([two(300, 300, d1, d2)], 'plates.wsp'), fcsFile('A1.fcs', 300, 5000, d2), fcsFile('A1.fcs', 300, 0, d1)]);
    expect(firstFsc(0)).toBe(0);
    expect(firstFsc(1)).toBe(5000);
  });

  it('files that cannot be told apart: both samples stay unlinked, no extra samples, and the toast says so', async () => {
    await openFiles([new File([two(300, 300)], 'plates.wsp'), fcsFile('A1.fcs', 300, 5000), fcsFile('A1.fcs', 300, 0)]);
    expect(st().ws.samples).toHaveLength(2);
    expect(st().ws.samples.every((s) => !engine.has(s.id))).toBe(true);
    expect(st().ui.missingFiles).toHaveLength(2);
    const t = toasts().find((x) => x.startsWith('FlowJo workspace opened'))!;
    expect(t).toMatch(/0 of 2 samples loaded/);
    expect(t).toMatch(/could not be told apart/);
    expect(st().ui.toasts.find((x) => x.text === t)!.kind).toBe('info');
  });

  it('one file for two samples of that name: linked to the one with its event count only', async () => {
    await openFiles([new File([two(300, 500)], 'plates.wsp'), fcsFile('A1.fcs', 500, 5000)]);
    expect(firstFsc(0)).toBeNull();
    expect(firstFsc(1)).toBe(5000);
  });

  it('a linked file with another event count than the workspace has: warned', async () => {
    await openFiles([new File([wsp([{ id: 1, uri: 'file:/C:/data/B2.fcs', tot: 300 }])], 'one.wsp'), fcsFile('B2.fcs', 250, 0)]);
    expect(engine.samples.get(st().ws.samples[0].id)?.ds.eventCount).toBe(250);
    const t = toasts().find((x) => x.startsWith('FlowJo workspace opened'))!;
    expect(t).toMatch(/another event count than the workspace/);
    expect(t).toMatch(/250 events, the workspace has 300/);
  });

  it('extra files of a name all samples have a file for are loaded as new samples (not dropped silently)', async () => {
    await openFiles([new File([wsp([{ id: 1, uri: 'file:/C:/data/plate1/A1.fcs', tot: 300 }])], 'one.wsp'), fcsFile('A1.fcs', 300, 0, {}, 'data/plate1/A1.fcs'), fcsFile('A1.fcs', 400, 9000, {}, 'data/plate2/A1.fcs')]);
    const ws = st().ws;
    expect(ws.samples).toHaveLength(2);
    expect(engine.samples.get(ws.samples[0].id)?.ds.data[0][0]).toBe(0);
    expect(engine.samples.get(ws.samples[1].id)?.ds.eventCount).toBe(400);
  });
});

describe('opening a workspace: files given by name serve one sample each, and their bytes are not copied', () => {
  it('two samples with one file name and one file: only the sample with its event count gets it', async () => {
    const base = { fileSize: 0, channels: [{ name: 'FSC-A', label: '', range: 262144 }, { name: 'SSC-A', label: '', range: 262144 }], compId: null };
    const ws = { ...JSON.parse(serializeWorkspace(st().ws)), samples: [{ id: 's1', name: 'A1', fileName: 'A1.fcs', eventCount: 300, ...base }, { id: 's2', name: 'A1', fileName: 'A1.fcs', eventCount: 500, ...base }] };
    const bytes = fcsBytes(500, 7);
    await openWorkspace(ws, [{ name: 'A1.fcs', bytes }], { quiet: true });
    expect(engine.has('s1')).toBe(false);
    expect(engine.samples.get('s2')?.ds.eventCount).toBe(500);
    // the file's own buffer is kept (no second copy of the event data)
    expect(engine.samples.get('s2')?.bytes).toBe(bytes.buffer);
  });
});

describe('very large loads: asked for files opened with a FlowJo workspace and for bundles', () => {
  // 2 channels x 3M events x 4 bytes: about 24 MB per file; the budget is 30 MB
  const N = 3_000_000;
  const big = (name: string, v: number) =>
    new File([writeFcs({ channels: [{ name: 'FSC-A', range: 262144 }, { name: 'SSC-A', range: 262144 }], data: [new Float32Array(N).fill(v), new Float32Array(N).fill(2)], keywords: {} }) as BlobPart], name);
  const WSP = wsp([
    { id: 1, uri: 'file:/C:/data/big1.fcs', tot: N },
    { id: 2, uri: 'file:/C:/data/big2.fcs', tot: N },
  ]);
  let asked: LargeLoad[] = [];
  let answer: LargeLoadChoice = 'skip';
  beforeAll(() => {
    G.localStorage = { getItem: (k: string) => (k === 'fs.loadBudgetMB' ? '30' : null), setItem: () => undefined, removeItem: () => undefined };
  });
  afterAll(() => {
    setLargeLoadPrompt(null);
    delete G.localStorage;
  });
  beforeEach(() => {
    asked = [];
    setLargeLoadPrompt(async (plan) => {
      asked.push(plan);
      return answer;
    });
  });

  it('FlowJo workspace with its files: asked once; the file left out leaves its sample unlinked', async () => {
    answer = 'skip';
    await openFiles([new File([WSP], 'exp.wsp'), big('big1.fcs', 1), big('big2.fcs', 3)]);
    expect(asked).toHaveLength(1);
    expect(asked[0].skip).toHaveLength(1);
    const ws = st().ws;
    expect(ws.name).toBe('exp');
    expect(ws.samples).toHaveLength(2);
    expect(ws.samples.filter((s) => engine.has(s.id))).toHaveLength(1);
    expect(st().ui.missingFiles).toHaveLength(1);
    expect(toasts().some((t) => /^Left out 1 large file/.test(t) && /relink/.test(t))).toBe(true);
  });

  it('FlowJo workspace: Cancel opens nothing', async () => {
    answer = 'cancel';
    const before = st().ws;
    await openFiles([new File([WSP], 'exp.wsp'), big('big1.fcs', 1), big('big2.fcs', 3)]);
    expect(asked).toHaveLength(1);
    expect(st().ws).toBe(before);
    expect(engine.samples.size).toBe(0);
  });

  it('a bundle: asked before its files are unpacked; the sample left out waits for its file', async () => {
    setLargeLoadPrompt(null);
    const f1 = big('big1.fcs', 1);
    const f2 = big('big2.fcs', 3);
    const ids = await loadFcsFiles([f1, f2]);
    expect(ids).toHaveLength(2);
    const ws = st().ws;
    const zip = zipSync(
      {
        'workspace.flowstate.json': strToU8(serializeWorkspace({ ...ws, name: 'bundle' })),
        [`fcs/${ids[0]}/big1.fcs`]: new Uint8Array(await f1.arrayBuffer()),
        [`fcs/${ids[1]}/big2.fcs`]: new Uint8Array(await f2.arrayBuffer()),
      },
      { level: 0 },
    );
    newBlankWorkspace();
    answer = 'skip';
    setLargeLoadPrompt(async (plan) => {
      asked.push(plan);
      return answer;
    });
    await openFiles([new File([zip as BlobPart], 'bundle.flowstate.zip')]);
    expect(asked).toHaveLength(1);
    expect(asked[0].skip.map((f) => f.name)).toHaveLength(1);
    const after = st().ws;
    expect(after.name).toBe('bundle');
    expect(after.samples).toHaveLength(2);
    expect(after.samples.filter((s) => engine.has(s.id))).toHaveLength(1);
    expect(st().ui.missingFiles).toHaveLength(1);
  });
});
