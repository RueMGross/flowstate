// Fixes found by testing with real lab data (CytoFLEX LX conventional and nanoscale runs, CytExpert plates, FlowJo
// 10.5 / 10.10 workspaces, FCMPASS 5.0.8 exports). The lab data are not part of the repository: these tests rebuild
// the situations with synthetic data.
import { writeFcs, parseFcs } from '../src/core/fcs';
import { importFlowJo } from '../src/core/flowjo';
import { Engine, engine, fileByteSize, fileBytes } from '../src/core/engine';
import { emptyWorkspace } from '../src/core/model';
import { riWater, resolveRI } from '../src/core/mie';
import { tubeName } from '../src/core/plate';
import { apertureCrossSections, evModelFcmpass, FCMPASS_EV_CORES } from '../src/core/scattercal';
import { matchBeadPattern } from '../src/ui/calib/logic';
import { fromParticleModel, modelPresetDraft, toParticleModel } from '../src/ui/calib/util';
import { largeLoadPlan, loadFcsFiles, useStore } from '../src/state/store';
import { calibTools, setupFor } from '../src/core/model';
import { repairWorkspace } from '../src/core/repair';
import { experimentRequest, parseExperiment } from '../src/ai/experiment';
import { useAiSettings } from '../src/ai/settings';

// ------------------------------------------------------------------ FlowJo log axes

const NS =
  'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';
/** raw value at a display channel of a FlowJo log axis (offset 100, 4 decades, 256 channels) */
const atChannel = (c: number) => 100 * Math.pow(10, (c * 4) / 256);

describe('FlowJo polygon gates on log axes', () => {
  it('rounds events and vertices to the nearest channel of the gate grid, as FlowJo does', () => {
    const vertex = (x: number, y: number) =>
      `<gating:vertex><gating:coordinate data-type:value="${atChannel(x)}"/><gating:coordinate data-type:value="${atChannel(y)}"/></gating:vertex>`;
    const dim = (n: string) => `<gating:dimension><data-type:fcs-dimension data-type:name="${n}"/></gating:dimension>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" flowJoVersion="10.5.3" ${NS}>
  <Groups><GroupNode name="All Samples"><Group name="All Samples"><SampleRefs><SampleRef sampleID="1"/></SampleRefs></Group></GroupNode></Groups>
  <SampleList><Sample>
    <DataSet uri="file:/C:/data/log.fcs" sampleID="1"/>
    <Transformations>
      <transforms:log transforms:offset="100" transforms:decades="4"><data-type:parameter data-type:name="FL1-A"/></transforms:log>
      <transforms:log transforms:offset="100" transforms:decades="4"><data-type:parameter data-type:name="SSC_1-H"/></transforms:log>
    </Transformations>
    <Keywords><Keyword name="$FIL" value="log.fcs"/><Keyword name="$TOT" value="15"/></Keywords>
    <SampleNode name="log.fcs" count="15" sampleID="1"><Subpopulations>
      <Population name="Lipos" count="10"><Gate><gating:PolygonGate eventsInside="1" gateResolution="256">${dim('FL1-A')}${dim('SSC_1-H')}${vertex(50, 50)}${vertex(150, 50)}${vertex(150, 150)}${vertex(50, 150)}</gating:PolygonGate></Gate></Population>
    </Subpopulations></SampleNode>
  </Sample></SampleList>
</Workspace>`;
    const res = importFlowJo(xml);
    const ws = res.workspace;
    // 3 events at channel 49.6 (round: 50, on the outline, in; truncate: 49, out), 5 at 150.6 (round: 151, out;
    // truncate: 150, in), 7 well inside
    const xs = [...Array(3).fill(49.6), ...Array(5).fill(150.6), ...Array(7).fill(100)].map(atChannel);
    const ys = xs.map(() => atChannel(100));
    const ds = parseFcs(
      writeFcs({ channels: [{ name: 'FL1-A', range: 1e6 }, { name: 'SSC_1-H', range: 1e6 }], data: [new Float32Array(xs), new Float32Array(ys)], keywords: { $FIL: 'log.fcs' } }).buffer as ArrayBuffer,
    );
    const eng = new Engine();
    eng.addSample(ws.samples[0].id, ds);
    const p = ws.populations.find((x) => x.name === 'Lipos')!;
    expect(eng.count(ws, ws.samples[0].id, p.id)).toBe(10);
    expect(res.counts[ws.samples[0].id][p.id]).toBe(10);
  });
});

// ------------------------------------------------------------------ FCMPASS EV models

describe('FCMPASS EV models', () => {
  it('states the RIs at 488 nm and shifts them with the dispersion of water', () => {
    const m = evModelFcmpass('average');
    const d = riWater(405) - riWater(488);
    expect(resolveRI(m.core, 405).re).toBeCloseTo(1.38 + d, 6);
    expect(resolveRI(m.shell, 405).re).toBeCloseTo(1.48 + d, 6);
    expect(resolveRI(m.core, 488).re).toBeCloseTo(1.38, 9);
    // at 405 nm FCMPASS's average EV core is 1.3857 (fitted to its exported EV diameters: 1.386)
    expect(resolveRI(m.core, 405).re).toBeCloseTo(1.3857, 3);
    expect(resolveRI(evModelFcmpass('low').core, 405).re).toBeCloseTo(1.3657, 3);
    expect(resolveRI(evModelFcmpass('high').core, 405).re).toBeCloseTo(1.4057, 3);
    expect(Object.values(FCMPASS_EV_CORES)).toEqual([1.36, 1.38, 1.4]);
  });

  it('the EV preset of the size page follows FCMPASS and round-trips through a stored model', () => {
    const draft = modelPresetDraft('ev');
    expect(draft).toEqual({ kind: 'ev', core: 1.38, shell: 1.48, shellNm: 5, refNm: 488 });
    const pm = toParticleModel(draft);
    expect(pm).toMatchObject({ kind: 'coreShell', core: { material: 'water', n: 1.38, atNm: 488 }, shellNm: 5 });
    expect(fromParticleModel(pm)).toEqual(draft);
    // the same σ as FCMPASS's model
    const setup = { wavelengthNm: 405, nMedium: riWater(405), geometry: { thetaDeg: 90, phiDeg: 90, halfAngleDeg: 48.5 } };
    expect(apertureCrossSections(pm, [150], setup)[0]).toBeCloseTo(apertureCrossSections(evModelFcmpass(), [150], setup)[0], 9);
    // RIs entered at the laser wavelength (older calibrations) stay as they were
    const plain = toParticleModel({ kind: 'ev', core: 1.38, shell: 1.48, shellNm: 5 });
    expect(plain).toMatchObject({ core: 1.38, shell: 1.48 });
    expect(fromParticleModel(plain)).toEqual({ kind: 'ev', core: 1.38, shell: 1.48, shellNm: 5 });
    // undispersed RIs scatter less at 405 nm: they read the same signal as a larger particle
    expect(apertureCrossSections(plain, [150], setup)[0]).toBeLessThan(apertureCrossSections(pm, [150], setup)[0]);
  });
});

// ------------------------------------------------------------------ bead peaks by the kit's pattern

describe('bead peaks chosen by the brightness pattern of the kit', () => {
  // a nanoViS Low tube on a CytoFLEX LX (violet SSC-A): noise, the 108 and 142 nm beads, and aggregates far above;
  // the 40 and 80 nm beads are in the noise. Modelled σ (nm²) of 40 / 80 / 108 / 142 nm polystyrene at 405 nm.
  const peaks = [
    { median: 750, count: 6000 },
    { median: 3700, count: 1400 },
    { median: 11000, count: 2100 },
    { median: 150000, count: 100 },
    { median: 620000, count: 200 },
    { median: 1300000, count: 270 },
    { median: 3200000, count: 560 },
  ];
  const sigma = [0.3477, 19.51, 97.61, 344];

  it('takes the beads that follow the pattern, not the largest peaks, and leaves the dimmest in the noise', () => {
    const m = matchBeadPattern(peaks, sigma, [0, 1, 2, 3], true)!;
    expect(m.noisePeak).toBe(0);
    expect(m.assign).toEqual([-1, -1, 1, 2]);
    expect(m.spread).toBeLessThan(0.1);
  });

  it('keeps every bead when all are there', () => {
    // high set: 142 / 304 / 600 / 1020 nm with a small extra peak between noise and the first bead
    const hi = [
      { median: 900, count: 18000 },
      { median: 2500, count: 5300 },
      { median: 9000, count: 28000 },
      { median: 67000, count: 15000 },
      { median: 340000, count: 12000 },
      { median: 1150000, count: 11000 },
    ];
    const m = matchBeadPattern(hi, [344, 2030, 10561, 34737], [0, 1, 2, 3], true)!;
    expect(m.assign).toEqual([2, 3, 4, 5]);
  });

  it('returns null without beads or peaks', () => {
    expect(matchBeadPattern([], sigma, [0, 1], true)).toBeNull();
    expect(matchBeadPattern(peaks, sigma, [], true)).toBeNull();
  });
});

// ------------------------------------------------------------------ CytExpert tube names

describe('tube names of CytExpert samples', () => {
  it('drops the plate number and the well', () => {
    expect(tubeName('01-Donor 3-A1', 'A01')).toBe('Donor 3');
    expect(tubeName('02-Liposomes stained-C1', 'C01')).toBe('Liposomes stained');
    expect(tubeName('02-dilution 1 10-E3', 'E03')).toBe('dilution 1 10');
    expect(tubeName('02-nano ViS high-B12')).toBe('nano ViS high');
    // FCMPASS exports add " FCMPASS" after the well
    expect(tubeName('02-Beads sized-A4 FCMPASS', 'A04')).toBe('Beads sized');
    // CytExpert's default tube name says nothing
    expect(tubeName('02-Well-B7', 'B07')).toBe('');
    // other names stay
    expect(tubeName('Donor3_HC')).toBe('Donor3_HC');
    expect(tubeName('ALS 12')).toBe('ALS 12');
    expect(tubeName('200 nm beads')).toBe('200 nm beads');
    expect(tubeName('EV d1')).toBe('EV d1');
    expect(tubeName('EV d7')).toBe('EV d7');
  });
});

// ------------------------------------------------------------------ files kept once in memory

describe('opened files are not kept twice in memory', () => {
  it('a file of one data set stays a File (read again only to save it); its bytes are the same', async () => {
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    useStore.getState().replaceWorkspace(emptyWorkspace());
    const bytes = writeFcs({ channels: [{ name: 'FSC-A', range: 1024 }, { name: 'SSC-A', range: 1024 }], data: [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])], keywords: { $CYT: 'CytoFLEX' } });
    const f = new File([bytes as BlobPart], 'one.fcs');
    const [id] = await loadFcsFiles([f]);
    const sd = engine.samples.get(id)!;
    expect(sd.bytes).toBeInstanceOf(Blob);
    expect(fileByteSize(sd.bytes)).toBe(bytes.length);
    expect(Array.from(await fileBytes(sd.bytes!))).toEqual(Array.from(bytes));
    expect(engine.memory().fileBytesMB).toBe(0);
  });
});

// ------------------------------------------------------------------ very large loads and the experiment setup


describe('very large loads', () => {
  const file = (name: string, mb: number) => {
    const f = new File([], name);
    Object.defineProperty(f, 'size', { value: mb * 1024 * 1024 });
    return f;
  };
  it('leaves out the largest files (cleaning and buffer tubes) until the rest fits', () => {
    const files = [file('02-Sample-A1.fcs', 2), file('01-Water-B1.fcs', 745), file('01-Contrad-A1.fcs', 552), file('01-PBS-C1.fcs', 242), file('02-Sample-A2.fcs', 3)];
    const GB = 1024 ** 3;
    expect(largeLoadPlan(files, 0, 2 * GB)).toBeNull();
    const p = largeLoadPlan(files, 0, 0.5 * GB)!;
    expect(p.skip.map((f) => f.name)).toEqual(['01-Water-B1.fcs', '01-Contrad-A1.fcs']);
    // what is open already counts
    expect(largeLoadPlan(files, 1 * GB, 2 * GB)!.skip.map((f) => f.name)).toEqual(['01-Water-B1.fcs']);
    // a few small files: not worth asking; one file alone: nothing to leave out (load or cancel)
    expect(largeLoadPlan([file('a.fcs', 10), file('b.fcs', 12)], 0, 1024 * 1024)).toBeNull();
    expect(largeLoadPlan([file('01-Water-B1.fcs', 745)], 0, 0.5 * GB)!.skip).toEqual([]);
  });
});

describe('experiment setup', () => {
  it('shows the calibration tools of the setup, and those already used', () => {
    const ws = emptyWorkspace();
    expect(calibTools(ws)).toEqual({ mesf: true, size: true }); // no setup: everything
    ws.setup = setupFor('conventional');
    expect(calibTools(ws)).toEqual({ mesf: false, size: false });
    ws.derived = [{ id: 'm', kind: 'mesf' } as never];
    expect(calibTools(ws)).toEqual({ mesf: true, size: false });
    expect(setupFor('nanoscale')).toEqual({ kind: 'nanoscale', mesf: true, size: true });
  });
  it('a damaged setup is dropped (every tool shown)', () => {
    const r = repairWorkspace(JSON.parse(JSON.stringify({ ...emptyWorkspace(), setup: { kind: 'spectral', mesf: 1 } })));
    expect(r.ws.setup).toBeUndefined();
    const ok = repairWorkspace(JSON.parse(JSON.stringify({ ...emptyWorkspace(), setup: setupFor('nanoscale') })));
    expect(ok.ws.setup).toEqual(setupFor('nanoscale'));
  });
});

// ------------------------------------------------------------------ "AI auto-analysis"


describe('AI reading of an experiment', () => {
  it('sends tube names, plates and per-sample medians (no events), and maps the answer back to samples', async () => {
    for (const id of [...engine.samples.keys()]) engine.removeSample(id);
    useStore.getState().replaceWorkspace(emptyWorkspace());
    const mk = (name: string, well: string, level: number) =>
      new File(
        [
          writeFcs({
            channels: [{ name: 'SSC-A', range: 1e6 }, { name: 'FL1-A', range: 1e6, label: 'B525-FITC-A' }, { name: 'FL9-A', range: 1e6, label: 'R660-APC-A' }],
            data: [new Float32Array(200).fill(1000), new Float32Array(200).map((_, i) => level + i), new Float32Array(200).fill(5)],
            keywords: { $CYT: 'CytoFLEX LX', $SMNO: well, $BTIM: '12:00:00', $ETIM: '12:01:00', $OP: 'Some Person' },
          }) as BlobPart,
        ],
        `${name}.fcs`,
      );
    await loadFcsFiles([mk('01-Unstained-A1', 'A1', 10), mk('01-Drug X stained-A2', 'A2', 5000), mk('01-Drug X stained-A3', 'A3', 5200)]);
    const ws = useStore.getState().ws;
    const r = experimentRequest(ws, { names: true });
    expect(r.refs).toEqual(['S1', 'S2', 'S3']);
    expect(r.prompt).toContain('S1 | Plate 1 A02 | Drug X stained | 200 | 60 |');
    expect(r.prompt).toContain('S3 | Plate 1 A01 | Unstained | 200 | 60 |');
    expect(r.prompt).toContain('FL1-A (B525-FITC-A)');
    expect(r.prompt).not.toContain('Some Person');
    // names hidden: only control words
    useAiSettings.getState().set({ anonymize: true });
    const hidden = experimentRequest(ws);
    expect(hidden.prompt).not.toContain('Drug X');
    expect(hidden.prompt).toContain('| unstained |');
    const res = parseExperiment(ws, r, {
      summary: 'A stain with an unstained control.',
      kind: 'conventional',
      calibrations: { mesf: false, size: false },
      groups: [
        { name: 'Unstained', role: 'unstained', samples: ['S3'] },
        { name: 'Drug X', role: 'treatment?', samples: ['S1', 's2', 'S9', 'S3'] },
      ],
      steps: [{ title: 'Gate the stained events', action: 'strategy', goal: 'FITC+' }, { title: 'Look', action: 'dance' }, { action: 'none' }],
      questions: ['Which dose?'],
    });
    const id = (n: string) => ws.samples.find((s) => s.name === n)!.id;
    expect(res.setup).toEqual({ kind: 'conventional', mesf: false, size: false });
    expect(res.groups).toEqual([
      { name: 'Unstained', role: 'unstained', sampleIds: [id('01-Unstained-A1')] },
      { name: 'Drug X', role: 'other', sampleIds: [id('01-Drug X stained-A2'), id('01-Drug X stained-A3')] },
    ]);
    expect(res.steps.map((s) => [s.title, s.action])).toEqual([
      ['Gate the stained events', 'strategy'],
      ['Look', 'none'],
    ]);
    expect(parseExperiment(ws, r, 'nonsense').groups).toEqual([]);
  });
});
