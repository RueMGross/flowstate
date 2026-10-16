// QC fixes (export, saving, Gating-ML): exported computed channels (MESF, size) come from compensated values whatever
// the raw channels are; "no value" is an empty CSV cell or -1 in FCS files (FLOWSTATE_NOVALUE); "Save with data" asks
// before leaving out samples without data; a Gating-ML import warns about gates on parameters no sample has.
import { strFromU8, unzipSync } from 'fflate';
import type { DerivedDef } from '../src/core/derived';
import { engine } from '../src/core/engine';
import { parseFcs, writeFcs } from '../src/core/fcs';
import { EV_MODEL } from '../src/core/scattercal';
import { exportPopulation, importGatingMLText, newBlankWorkspace, NO_VALUE, NO_VALUE_KEYWORD, saveWorkspaceBundle, type ConfirmExtraPayload } from '../src/io/files';
import { loadFcsFiles, useStore } from '../src/state/store';

const G = globalThis as unknown as Record<string, unknown>;
const st = () => useStore.getState();
const saved: { filename: string; data: unknown }[] = [];

beforeAll(() => {
  // the artifact viewer's download capability (saveFile uses it when present)
  G.window = {
    addEventListener: () => undefined,
    claude: {
      use: async () => ({
        save: async (req: { filename: string; data: unknown }) => {
          saved.push(req);
          return { status: 'saved' };
        },
      }),
    },
  };
});
afterAll(() => {
  delete G.window;
});
beforeEach(() => {
  newBlankWorkspace();
  saved.length = 0;
});

const bytesOf = (d: unknown) => (d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer));
const file = (name: string, chans: string[], cols: number[][], kw: Record<string, string> = {}) =>
  new File([writeFcs({ channels: chans.map((name) => ({ name, range: 262144 })), data: cols.map((c) => Float32Array.from(c)), keywords: kw }) as BlobPart], name);

/** CSV text of the last export: header and rows split. */
function lastCsv(): { header: string[]; rows: string[][] } {
  const text = strFromU8(bytesOf(saved[saved.length - 1].data));
  const [h, ...r] = text.split('\n');
  return { header: h.split(','), rows: r.map((x) => x.split(',')) };
}
/** The FCS file(s) in the zip of the last export. */
function lastFcs() {
  const z = unzipSync(bytesOf(saved[saved.length - 1].data));
  return Object.values(z).map((b) => parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
}

describe('event export: computed channels', () => {
  // PE-bright, FITC-negative events: true FITC 200, PE 100000, 10 % of PE spills into FITC (raw FITC 10200)
  async function mesfSample() {
    const n = 5;
    const [id] = await loadFcsFiles([file('s.fcs', ['FITC-A', 'PE-A'], [Array(n).fill(200 + 0.1 * 100000), Array(n).fill(100000)])]);
    st().update((w) => {
      w.compensations.push({ id: 'c1', name: 'comp', channels: ['FITC-A', 'PE-A'], matrix: [[1, 0], [0.1, 1]], source: 'manual' });
      w.samples[0].compId = 'c1';
      w.derived = [{ id: 'm', kind: 'mesf', name: 'FITC-A MEFL', channel: 'FITC-A', unit: 'MEFL', outputs: [{ name: 'FITC-A MEFL', range: 1e6 }], fit: { method: 'log', slope: 1, intercept: 0, r2: 1 } }] as DerivedDef[];
    });
    expect(engine.raw(st().ws, id, 'FITC-A MEFL')![0]).toBeCloseTo(200, 2); // in the app
    return id;
  }

  it('the default (uncompensated) export writes MESF as the app shows it, from compensated FITC', async () => {
    const id = await mesfSample();
    await exportPopulation([id], 'root', 'csv', false);
    const { header, rows } = lastCsv();
    expect(header).toEqual(['FITC-A', 'PE-A', 'FITC-A MEFL']);
    expect(Number(rows[0][0])).toBeCloseTo(10200, 2); // raw channel: uncompensated, as chosen
    expect(Number(rows[0][2])).toBeCloseTo(200, 2); // computed channel: 200 MEFL, not 10200
    await exportPopulation([id], 'root', 'fcs', false);
    const [ds] = lastFcs();
    expect(ds.data[0][0]).toBeCloseTo(10200, 2);
    expect(ds.data[2][0]).toBeCloseTo(200, 2);
    expect(ds.keywords[NO_VALUE_KEYWORD]).toBe(String(NO_VALUE));
  });

  it('the compensated export writes the same MESF', async () => {
    const id = await mesfSample();
    await exportPopulation([id], 'root', 'csv', true);
    const { rows } = lastCsv();
    expect(Number(rows[0][0])).toBeCloseTo(200, 2);
    expect(Number(rows[0][2])).toBeCloseTo(200, 2);
  });

  it('size outside the calibrated range: an empty CSV cell, -1 in FCS files (FLOWSTATE_NOVALUE), never 0 nm', async () => {
    const v = [-50, 0.0001, 30, 300, 3000, 1e9];
    const [id] = await loadFcsFiles([file('ev.fcs', ['VSSC1-A'], [v])]);
    st().update((w) => {
      w.derived = [
        {
          id: 'z',
          kind: 'size',
          name: 'z',
          channel: 'VSSC1-A',
          nm2PerAu: 1,
          setup: { wavelengthNm: 405, nMedium: 1.34, geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 50 } },
          model: EV_MODEL,
          outputs: [{ name: 'VSSC1-A diameter (nm)', range: 1000 }],
        },
      ] as DerivedDef[];
    });
    const inApp = Array.from(engine.raw(st().ws, id, 'VSSC1-A diameter (nm)')!);
    const none = inApp.map((x) => !Number.isFinite(x));
    expect(none.some(Boolean)).toBe(true);
    expect(none.every(Boolean)).toBe(false);
    await exportPopulation([id], 'root', 'csv', false);
    const { header, rows } = lastCsv();
    expect(header[1]).toBe('VSSC1-A diameter (nm)');
    rows.forEach((r, i) => {
      if (none[i]) expect(r[1]).toBe('');
      else expect(Number(r[1])).toBeCloseTo(inApp[i], 1);
    });
    await exportPopulation([id], 'root', 'fcs', false);
    const [ds] = lastFcs();
    expect(ds.keywords[NO_VALUE_KEYWORD]).toBe('-1');
    Array.from(ds.data[1]).forEach((x, i) => {
      if (none[i]) expect(x).toBe(-1);
      else expect(x).toBeCloseTo(inApp[i], 1);
    });
  });
});

describe('"Save with data": samples without data', () => {
  it('asks first, lists them, and saves without them only when told to', async () => {
    await loadFcsFiles([file('keep.fcs', ['FSC-A'], [[1, 2, 3]]), file('gone.fcs', ['FSC-A'], [[4, 5, 6]])]);
    const idOf = (fn: string) => st().ws.samples.find((s) => s.fileName === fn)!.id;
    const a = idOf('keep.fcs');
    const b = idOf('gone.fcs');
    engine.removeSample(b); // its file was not found (e.g. a workspace opened without it)
    const ok = await saveWorkspaceBundle();
    expect(ok).toBe(false);
    expect(saved).toHaveLength(0);
    const d = st().ui.dialog!;
    expect(d.kind).toBe('confirm');
    const p = d.payload as ConfirmExtraPayload;
    expect(p.text).toMatch(/1 sample of 2 has no data loaded/);
    expect(p.text).toMatch(/gone\.fcs/);
    expect(p.text).toMatch(/Locate files/);
    p.onOk();
    await new Promise((r) => setTimeout(r, 50));
    expect(saved).toHaveLength(1);
    const z = unzipSync(bytesOf(saved[0].data));
    expect(Object.keys(z).some((k) => k.startsWith(`fcs/${a}/`))).toBe(true);
    expect(Object.keys(z).some((k) => k.startsWith(`fcs/${b}/`))).toBe(false);
    expect(st().ui.toasts.some((t) => /no events for 1 sample/.test(t.text))).toBe(true);
  });

  it('saves at once when every sample has its data', async () => {
    await loadFcsFiles([file('keep.fcs', ['FSC-A'], [[1, 2, 3]])]);
    expect(await saveWorkspaceBundle()).toBe(true);
    expect(saved).toHaveLength(1);
  });
});

describe('Gating-ML import', () => {
  it('warns about gates on parameters none of the loaded files has', async () => {
    const a = Array.from({ length: 50 }, (_, i) => i * 100);
    await loadFcsFiles([file('x.fcs', ['FSC-A', 'FITC-A'], [a, a])]);
    const xml = `<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <gating:RectangleGate gating:id="pos"><gating:dimension gating:min="1000" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension></gating:RectangleGate></gating:Gating-ML>`;
    const before = st().ui.toasts.length;
    importGatingMLText(xml, 'g.xml');
    const t = st().ui.toasts.slice(before);
    expect(t.some((x) => x.kind === 'error' && /Gates use parameters that none of the loaded files has: "FL1-A"/.test(x.text))).toBe(true);
  });
});
