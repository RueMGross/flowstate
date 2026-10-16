// Regression (review 3, acceptance test): workflow defaults. Nanoscale scatter plots and axes, figure text sizes of new
// items, short instrument names, the MFI table's first channel choice, the "+ Group" chip, per-instrument scales of
// imported FlowJo workspaces and in the methods summary.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { writeFcs } from '../src/core/fcs';
import { Engine, engine } from '../src/core/engine';
import { importFlowJo } from '../src/core/flowjo';
import { emptyWorkspace, type Workspace } from '../src/core/model';
import { positiveLogScaleFor } from '../src/core/transforms';
import { instrumentDisplayName, loadFcsFiles, newChartItem, newPlotItem, pickDefaultChannels, useStore } from '../src/state/store';
import { isMarkerLabel, mfiPreselect } from '../src/ui/TablesView';
import { SamplePanel } from '../src/ui/Panels';
import { workspaceSummary } from '../src/ai/methods';

function reset() {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  useStore.getState().replaceWorkspace(emptyWorkspace());
  useStore.setState({ ui: { ...useStore.getState().ui, toasts: [] } });
}

/** A CytoFLEX-nano-like file: VSSC1 positive (trigger), VSSC2 with many events below 0, a fluorescence channel. */
function nanoFile(n = 4000) {
  let s = 7;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const v1 = Float32Array.from({ length: n }, () => 100 + Math.exp(r() * 10));
  const v2 = Float32Array.from({ length: n }, (_, i) => v1[i] * 0.45 - 60 + r() * 40);
  const fl = Float32Array.from({ length: n }, () => (r() - 0.5) * 400);
  const range = 16777216;
  return new File(
    [
      writeFcs({
        channels: [
          { name: 'FSC-A', label: 'VFSC-A', range },
          { name: 'SSC-A', label: 'VSSC1-A', range },
          { name: 'SSC_1-A', label: 'VSSC2-A', range },
          { name: 'FL2-A', label: 'B531-A', range },
        ],
        data: [Float32Array.from({ length: n }, () => (r() - 0.5) * 1000), v1, v2, fl],
        keywords: { $CYT: 'CytoFLEX nano', $CYTSN: 'BH20023' },
      }) as BlobPart,
    ],
    'ev.fcs',
  );
}

describe('nanoscale defaults', () => {
  it('"Add plot" scatter channels are VSSC1 vs VSSC2; VSSC1 (no events below 0) gets a log axis, VSSC2 logicle', async () => {
    reset();
    await loadFcsFiles([nanoFile()]);
    const ws = useStore.getState().ws;
    const { fsc, ssc } = pickDefaultChannels(ws);
    expect([fsc, ssc]).toEqual(['SSC-A', 'SSC_1-A']);
    expect(ws.scales['SSC-A'].type).toBe('log');
    expect(ws.scales['SSC_1-A'].type).toBe('logicle');
    // fluorescence keeps its default
    expect(ws.scales['FL2-A'].type).toBe('logicle');
  });

  it('pure log only without meaningful values at or below 0', () => {
    const pos = Float32Array.from({ length: 10000 }, (_, i) => 150 + i * 10);
    const lg = positiveLogScaleFor(16777216, pos);
    expect(lg).toEqual({ type: 'log', min: 100, max: 16777216 });
    const some = Float32Array.from(pos, (v, i) => (i % 50 === 0 ? -5 : v)); // 2 %
    expect(positiveLogScaleFor(16777216, some)).toBeNull();
    const few = Float32Array.from(pos, (v, i) => (i % 500 === 0 ? -5 : v)); // 0.2 %
    expect(positiveLogScaleFor(16777216, few)?.type).toBe('log');
  });
});

it('new charts, stats boxes and plots take the figure style text size', () => {
  reset();
  useStore.getState().update((w) => void (w.style.fontSize = 11));
  expect(newChartItem(0, 0, 100, 100).fontSize).toBe(11);
  expect(newPlotItem('dot', 'FSC-A', 'SSC-A', 0, 0).options.fontSize).toBe(11);
});

it('instrument keys have short display names', () => {
  const k = 'CytoFLEX mosaic 88 & CytoFLEX LX (BJ08011 & BJ09005)';
  expect(instrumentDisplayName(k)).toBe('CytoFLEX mosaic 88 & LX');
  expect(instrumentDisplayName('CytoFLEX nano (BH20023)')).toBe('CytoFLEX nano');
  expect(instrumentDisplayName('LSRII')).toBe('LSRII');
  // two instruments of the same model: the serial numbers stay
  expect(instrumentDisplayName('CytoFLEX LX (BJ08011)', ['CytoFLEX LX (BJ08011)', 'CytoFLEX LX (BJ09005)'])).toBe('CytoFLEX LX (BJ08011)');
});

describe('MFI table: channels chosen at first', () => {
  it('marker labels, not detector or dye names', () => {
    expect(isMarkerLabel('CD4 FITC', 'FL1-A')).toBe(true);
    expect(isMarkerLabel('CD127', 'FL1-A')).toBe(true);
    expect(isMarkerLabel('Ki-67', 'FL1-A')).toBe(true);
    expect(isMarkerLabel('Live/Dead Aqua', 'FL1-A')).toBe(true);
    for (const l of ['V447-A', 'B525-FITC-A', 'PE-Cy7-A', 'BV421-A', 'FL1-A', 'BL1-A', 'VSSC1-A', 'APC-H7', 'PE-Dazzle594-A', 'R670-A', '']) expect(isMarkerLabel(l, 'FL1-A')).toBe(false);
  });

  it('gated and labelled channels; none of 92 unlabelled detectors', () => {
    const ws = emptyWorkspace();
    const chans = Array.from({ length: 92 }, (_, i) => `FL${i + 1}-A`);
    ws.samples = [{ id: 's', name: 's', fileName: 's.fcs', fileSize: 0, eventCount: 1, channels: chans.map((c, i) => ({ name: c, label: i === 4 ? 'CD3 BV421' : `B${525 + i}-A`, range: 1 })), compId: null }];
    expect(mfiPreselect(ws, chans)).toEqual(['FL5-A']);
    ws.populations = [{ id: 'p', name: 'p', parentId: null, color: '#000', gate: { type: 'range', x: 'FL9-A', min: 0, max: 1 } }];
    ws.channelLabels = { 'FL20-A': 'CD8' };
    expect(mfiPreselect(ws, chans)).toEqual(['FL5-A', 'FL9-A', 'FL20-A']);
    ws.populations = [];
    ws.channelLabels = {};
    ws.samples[0].channels = chans.map((c) => ({ name: c, label: '', range: 1 }));
    expect(mfiPreselect(ws, chans)).toEqual([]);
    expect(mfiPreselect(ws, chans.slice(0, 10))).toEqual(chans.slice(0, 10));
  });
});

it('the sample panel shows "+ Group" before any group exists', () => {
  reset();
  Object.assign((useStore as unknown as { getInitialState: () => { ws: object } }).getInitialState().ws, useStore.getState().ws);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined); // (useLayoutEffect on the server)
  const html = renderToString(createElement(SamplePanel, { onOpen: () => undefined }));
  quiet.mockRestore();
  expect(html).toContain('+ Group');
});

describe('FlowJo workspace with samples of two instruments', () => {
  const NS =
    'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';
  const dim = (n: string) => `<gating:dimension><data-type:fcs-dimension data-type:name="${n}"/></gating:dimension>`;
  const vtx = (x: number, y: number) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
  const sample = (id: string, cyt: string, max: number) => `<Sample>
  <DataSet uri="file:/${id}.fcs" sampleID="${id}"/>
  <Transformations>
    <transforms:linear transforms:minRange="0" transforms:maxRange="${max}" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
    <transforms:linear transforms:minRange="0" transforms:maxRange="${max}" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
  </Transformations>
  <Keywords><Keyword name="$CYT" value="${cyt}"/><Keyword name="$PAR" value="2"/><Keyword name="$P1N" value="FSC-A"/><Keyword name="$P2N" value="SSC-A"/><Keyword name="$P1R" value="${max}"/><Keyword name="$P2R" value="${max}"/></Keywords>
  <SampleNode name="${id}.fcs" count="2000" sampleID="${id}"><Subpopulations>
    <Population name="Cells" count="-1"><Gate><gating:PolygonGate eventsInside="1" gateResolution="256">${dim('FSC-A')}${dim('SSC-A')}${vtx(max * 0.1, max * 0.1)}${vtx(max * 0.6, max * 0.12)}${vtx(max * 0.5, max * 0.7)}</gating:PolygonGate></Gate></Population>
  </Subpopulations></SampleNode></Sample>`;
  const wsp = `<?xml version="1.0"?><Workspace version="20.0" flowJoVersion="10.8.1" ${NS}><SampleList>${sample('1', 'LSRII', 262144)}${sample('2', 'LSRII', 262144)}${sample('3', 'CytoFLEX', 16777216)}</SampleList></Workspace>`;

  it('the minority instrument gets its own axis scales; counts do not depend on them', () => {
    const ws: Workspace = importFlowJo(wsp).workspace;
    expect(ws.scales['FSC-A']).toMatchObject({ type: 'linear', max: 262144 });
    expect(ws.instrumentScales?.CytoFLEX?.['FSC-A']).toMatchObject({ type: 'linear', max: 16777216 });
    expect(ws.instrumentScales?.LSRII).toBeUndefined();
    expect(ws.samples.map((s) => s.instrument)).toEqual(['LSRII', 'LSRII', 'CytoFLEX']);
    // the CytoFLEX sample's counts: the same without the instrument scales (gates carry their own scales)
    const cy = ws.samples[2].id;
    let k = 3;
    const r = () => (k = (k * 16807) % 2147483647) / 2147483647;
    const ds = { channels: [{ name: 'FSC-A', label: '', range: 16777216 }, { name: 'SSC-A', label: '', range: 16777216 }], data: [Float32Array.from({ length: 2000 }, () => r() * 16777216), Float32Array.from({ length: 2000 }, () => r() * 16777216)], eventCount: 2000, keywords: { $CYT: 'CytoFLEX' }, warnings: [] };
    const e = new Engine();
    e.addSample(cy, ds as never);
    const pop = ws.populations[0].id;
    const without: Workspace = { ...ws, instrumentScales: undefined };
    expect(e.count(ws, cy, pop)).toBe(e.count(without, cy, pop));
    expect(e.scaleFor(ws, 'FSC-A', cy)).toBe(ws.instrumentScales!.CytoFLEX['FSC-A']);
  });

  it('the methods summary names the per-instrument scales', () => {
    const ws: Workspace = importFlowJo(wsp).workspace;
    const text = workspaceSummary(ws, null, ws.worksheets[0].id);
    expect(text).toMatch(/samples of CytoFLEX: Linear/);
    expect(text).toMatch(/evaluated on each sample's own instrument scale/);
  });
});
