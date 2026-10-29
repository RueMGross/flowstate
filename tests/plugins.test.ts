// Plugin API (src/plugins): registry and file loader, the PluginContext on real data (statistics as the tables compute
// them, gates, auto gate, undo, state saved with the workspace), the example plugin's numbers, and a plugin built as a
// standalone file with `npm run build:plugin` loading into the app.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToString } from 'react-dom/server';
import { engine } from '../src/core/engine';
import { writeFcs } from '../src/core/fcs';
import { emptyWorkspace, type Workspace } from '../src/core/model';
import { repairWorkspace } from '../src/core/repair';
import { serializeWorkspace } from '../src/io/files';
import { PLUGIN_API_VERSION, type FlowStatePlugin } from '../src/plugins/api';
import { contextFor } from '../src/plugins/context';
import example from '../src/plugins/example';
import { beadMfi, resultRows, type BeadMfiSettings } from '../src/plugins/example/compute';
import { loadPluginCode, pluginEntry, pluginProblem, unloadFilePlugin, usePlugins } from '../src/plugins/registry';
import { loadFcsFiles, useStore } from '../src/state/store';
import { PluginsView } from '../src/ui/PluginsView';

const run = (code: string) => new Function(code)();
const st = () => useStore.getState();

let seed = 5;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** Two bead populations (FITC-A / PE-A: A near 2000 / 2000, B near 20000 / 20000); APC-A reporter a / b per bead. */
function beadFile(name: string, a: number, b: number, n = 2000): File {
  const fitc = new Float32Array(n);
  const pe = new Float32Array(n);
  const apc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const isA = i % 2 === 0;
    const c = isA ? 2000 : 20000;
    fitc[i] = c * (1 + 0.08 * (rnd() - 0.5));
    pe[i] = c * (1 + 0.08 * (rnd() - 0.5));
    apc[i] = isA ? a : b;
  }
  const channels = [
    { name: 'FITC-A', range: 262144 },
    { name: 'PE-A', label: 'Bead ID', range: 262144 },
    { name: 'APC-A', label: 'CD63', range: 262144 },
  ];
  return new File([writeFcs({ channels, data: [fitc, pe, apc], keywords: { $CYT: 'TestCyt' } }) as BlobPart], name);
}

function reset(ws: Workspace = emptyWorkspace()) {
  for (const id of [...engine.samples.keys()]) engine.removeSample(id);
  st().replaceWorkspace(ws);
  useStore.setState({ ui: { ...st().ui, toasts: [] } });
}

async function beads() {
  reset();
  await loadFcsFiles([beadFile('blank.fcs', 100, 200), beadFile('sample.fcs', 1100, 2200)]);
  const sid = (n: string) => st().ws.samples.find((s) => s.name.startsWith(n))!.id;
  return { blank: sid('blank'), sample: sid('sample') };
}

const fs = contextFor(example);
const rect = (lo: number, hi: number) => ({ type: 'rect' as const, x: 'FITC-A', y: 'PE-A', xmin: lo, xmax: hi, ymin: lo, ymax: hi });

describe('registry', () => {
  const ok = { apiVersion: 1, id: 'demo', name: 'Demo', version: '1.0', Page: () => null };
  it('checks plugins', () => {
    expect(pluginProblem(ok)).toBeNull();
    expect(pluginProblem({ ...ok, id: 'Demo Plugin' })).toMatch(/invalid id/);
    expect(pluginProblem({ ...ok, apiVersion: PLUGIN_API_VERSION + 1 })).toMatch(/needs plugin API version/);
    expect(pluginProblem({ ...ok, Page: undefined })).toMatch(/no page/);
    expect(pluginProblem(null)).toMatch(/does not provide a plugin/);
  });

  it('the example is built in (development and tests)', () => {
    expect(pluginEntry('example')?.source).toBe('built-in');
  });

  it('loads a plugin file, replaces it when loaded again, unloads it', () => {
    const code = (v: string) => `FlowStateHost.register({ apiVersion: 1, id: 'demo', name: 'Demo', version: '${v}', Page: () => null });`;
    expect(loadPluginCode(code('1'), 'demo.js', run)).toEqual({ id: 'demo' });
    expect(loadPluginCode(code('2'), 'demo.js', run)).toEqual({ id: 'demo' });
    expect(usePlugins.getState().entries.filter((e) => e.plugin.id === 'demo').map((e) => e.plugin.version)).toEqual(['2']);
    unloadFilePlugin('demo');
    expect(pluginEntry('demo')).toBeNull();
    expect((globalThis as { FlowStateHost?: unknown }).FlowStateHost).toBeUndefined();
  });

  it('reports what is wrong with a plugin file', () => {
    expect(loadPluginCode('throw new Error("boom")', 'x.js', run)).toEqual({ error: expect.stringMatching(/could not be started: boom/) });
    expect(loadPluginCode('1 + 1', 'x.js', run)).toEqual({ error: expect.stringMatching(/registers no plugin/) });
    expect(loadPluginCode(`FlowStateHost.register({ apiVersion: 9, id: 'x', name: 'X', version: '1', Page: () => null })`, 'x.js', run)).toEqual({
      error: expect.stringMatching(/needs plugin API version 9/),
    });
    expect(loadPluginCode(`FlowStateHost.register({ apiVersion: 1, id: 'example', name: 'X', version: '1', Page: () => null })`, 'x.js', run)).toEqual({
      error: expect.stringMatching(/built-in plugin already has the id "example"/),
    });
  });
});

describe('plugin context on real data', () => {
  it('samples, channels, statistics and events as the app has them', async () => {
    const { blank, sample } = await beads();
    const s = fs.samples();
    expect(s.map((x) => [x.name, x.loaded, x.eventCount, x.keywords.$CYT])).toEqual([
      ['blank', true, 2000, 'TestCyt'],
      ['sample', true, 2000, 'TestCyt'],
    ]);
    expect(fs.findChannel('apc-a')).toBe('APC-A');
    expect(fs.findChannel('CD63')).toBe('APC-A');
    expect(fs.findChannel('nope')).toBeNull();
    const a = fs.addGate({ name: 'Bead A', gate: rect(1000, 4000) });
    expect(fs.count(sample, a)).toBe(1000);
    expect(fs.stat(sample, a, 'median', 'APC-A')).toBe(engine.stat(st().ws, sample, { population: a, stat: 'median', channel: 'APC-A' }));
    expect(fs.stat(blank, a, 'median', 'APC-A')).toBeCloseTo(100, 4);
    const ev = fs.events(sample, 'APC-A', a)!;
    expect(ev.length).toBe(1000);
    expect(ev.every((v) => Math.abs(v - 1100) < 1e-3)).toBe(true);
    expect(fs.count(sample, 'no-such-pop')).toBeNull();
    expect(fs.events(sample, 'APC-A', 'no-such-pop')).toBeNull();
    expect(Number.isNaN(fs.stat(sample, 'no-such-pop', 'median', 'APC-A'))).toBe(true);
    expect(fs.populations().map((p) => p.path)).toEqual(['Bead A']);
  });

  it('refuses invalid gates and parents', async () => {
    await beads();
    expect(() => fs.addGate({ name: 'X', gate: { type: 'rect' } as never })).toThrow(/Invalid gate/);
    expect(() => fs.addGate({ name: 'X', parent: 'missing', gate: rect(0, 1) })).toThrow(/No population/);
  });

  it('auto gate finds a bead population around a seed', async () => {
    const { sample } = await beads();
    const g = fs.autoGate({ sampleId: sample, x: 'FITC-A', y: 'PE-A', seed: [2000, 2000] });
    expect(g?.type).toBe('polygon');
    const id = fs.addGate({ name: 'A', gate: g! });
    const n = fs.count(sample, id)!;
    expect(n).toBeGreaterThan(950);
    expect(n).toBeLessThanOrEqual(1000);
    expect(fs.autoGate({ sampleId: sample, x: 'FITC-A', y: 'PE-A', seed: [150000, 150000] })).toBeNull();
  });

  it('a transaction is one undo step; state is saved with the workspace', async () => {
    await beads();
    const before = st().ws;
    fs.transaction(() => {
      const a = fs.addGate({ name: 'Bead A', gate: rect(1000, 4000) });
      const b = fs.addGate({ name: 'Bead B', gate: rect(10000, 40000) });
      fs.setState({ reporter: 'APC-A', stat: 'median', beads: [a, b], blanks: [], normalizeTo: [] });
    });
    expect(st().ws.populations.length).toBe(2);
    expect(fs.getState()?.beads.length).toBe(2);
    st().undo();
    expect(st().ws).toBe(before);
    expect(fs.getState()).toBeUndefined();
    st().redo();
    expect(fs.getState()?.reporter).toBe('APC-A');
    // saved and opened again (repair keeps it; parseState checks it)
    const back = repairWorkspace(JSON.parse(serializeWorkspace(st().ws))).ws;
    expect(back.plugins?.example).toEqual(st().ws.plugins?.example);
    expect(repairWorkspace({ ...JSON.parse(serializeWorkspace(st().ws)), plugins: { 'Bad Id': 1, ok: { a: 1 } } }).ws.plugins).toEqual({ ok: { a: 1 } });
    st().update((w) => void ((w.plugins ??= {}).example = 'garbage'));
    expect(fs.getState()).toBeUndefined();
  });
});

describe('example plugin', () => {
  it('blank subtraction and normalization', async () => {
    const { blank } = await beads();
    const a = fs.addGate({ name: 'Bead A', gate: rect(1000, 4000) });
    const b = fs.addGate({ name: 'Bead B', gate: rect(10000, 40000) });
    const s: BeadMfiSettings = { reporter: 'APC-A', stat: 'median', beads: [a, b], blanks: [blank], normalizeTo: [] };
    const r = beadMfi(fs, s);
    expect(r.blank.map((v) => Math.round(v!))).toEqual([100, 200]);
    expect(r.rows.map((x) => [x.sample, ...x.values.map((v) => Math.round(v!))])).toEqual([['sample', 1000, 2000]]);
    const n = beadMfi(fs, { ...s, normalizeTo: [a] });
    expect(n.rows[0].values.map((v) => +v!.toFixed(6))).toEqual([1, 2]);
    expect(resultRows(r, s)[0]).toEqual(['Sample', 'Bead A', 'Bead B']);
    expect(beadMfi(fs, { ...s, blanks: [] }).notes[0]).toMatch(/not background-subtracted/);
  });

  it('renders: its page, and its entry in the plugins view', async () => {
    await beads();
    fs.addGate({ name: 'Bead A', gate: rect(1000, 4000) });
    const html = renderToString(createElement(example.Page, { fs, revision: 1 }));
    expect(html).toContain('Bead populations');
    expect(html).toContain('Reporter channel');
    expect(html).toContain('Bead A');
    // (server rendering shows the store's initial UI state: the list of plugins)
    expect(renderToString(createElement(PluginsView))).toContain('Example: bead assay');
  });
});

describe('standalone plugin file', () => {
  it('npm run build:plugin builds a file the loader runs with the app\'s React', () => {
    const root = path.resolve(__dirname, '..');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build-plugin.mjs'), 'example'], { cwd: root, stdio: 'pipe' });
    const code = readFileSync(path.join(root, 'dist-plugins', 'example.flowstate-plugin.js'), 'utf8');
    // the example is also built in: the loader ran the file and got a valid plugin with the same id
    expect(loadPluginCode(code, 'example.flowstate-plugin.js', run)).toEqual({ error: 'a built-in plugin already has the id "example"' });
    let got: FlowStatePlugin | null = null;
    const g = globalThis as { FlowStateHost?: unknown };
    g.FlowStateHost = { React, jsxRuntime, register: (p: FlowStatePlugin) => (got = p) };
    try {
      run(code);
    } finally {
      delete g.FlowStateHost;
    }
    expect(pluginProblem(got)).toBeNull();
    expect(got!.id).toBe('example');
  }, 120000);
});
