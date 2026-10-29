// The PluginContext a plugin gets (see api.ts): the app's samples, gates and statistics through a small, stable surface.
// Statistics and events come from the engine exactly as the Statistics tables use them.
import { squashSince } from '../ai/history';
import { SENSITIVITY } from '../core/autogate';
import { engine } from '../core/engine';
import { allChannels, gateProblem, popById, type GateGeom, type Population, type Workspace } from '../core/model';
import { gather } from '../core/stats';
import { makeScale } from '../core/transforms';
import { saveFile } from '../io/files';
import { writeXlsxBook } from '../io/xlsx';
import { addPopulation, deletePopulation, runAs, useStore } from '../state/store';
import { csvLine } from '../ui/calib/util';
import { autoGateAt, autoSession, commitGate } from '../ui/gateOps';
import type { AutoGateRequest, FlowStatePlugin, PluginChannel, PluginContext, PluginPopulation, PluginSample } from './api';

const ws = (): Workspace => useStore.getState().ws;

/** a population id of the API (null / undefined / 'root' = All Events) that exists, or null */
function popRef(w: Workspace, id: string | null | undefined): string | null {
  if (!id || id === 'root') return 'root';
  return popById(w, id) ? id : null;
}

/** populations in tree order (parents before children; siblings in workspace order) */
function treeOrder(w: Workspace): Population[] {
  const kids = new Map<string | null, Population[]>();
  for (const p of w.populations) {
    const k = p.parentId && popById(w, p.parentId) ? p.parentId : null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k)!.push(p);
  }
  const out: Population[] = [];
  const seen = new Set<string>();
  const walk = (k: string | null) => {
    for (const p of kids.get(k) ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      walk(p.id);
    }
  };
  walk(null);
  return out;
}

function pathOf(w: Workspace, p: Population): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let cur: Population | undefined = p; cur && !seen.has(cur.id); cur = cur.parentId ? popById(w, cur.parentId) : undefined) {
    seen.add(cur.id);
    names.unshift(cur.name);
  }
  return names.join('/');
}

function checkedGate(g: GateGeom): GateGeom {
  const why = gateProblem(g);
  if (why) throw new Error(`Invalid gate: ${why}`);
  // plain data (the workspace keeps no references to the plugin's objects)
  return JSON.parse(JSON.stringify(g)) as GateGeom;
}

const contexts = new WeakMap<object, PluginContext<unknown>>();

/** The context of a plugin (one per plugin object, so it is stable across renders). */
export function contextFor<S>(plugin: FlowStatePlugin<S>): PluginContext<S> {
  const hit = contexts.get(plugin);
  if (hit) return hit as PluginContext<S>;
  const id = plugin.id;
  const parsed = new WeakMap<object, S | null>();

  const ctx: PluginContext<S> = {
    plugin: { id, name: plugin.name, version: plugin.version },

    samples(): PluginSample[] {
      const w = ws();
      return w.samples.map((s) => {
        const plate = s.plate ? w.plates?.find((p) => p.name === s.plate) : undefined;
        return {
          id: s.id,
          name: s.name,
          fileName: s.fileName,
          eventCount: engine.has(s.id) ? engine.eventCount(s.id) : s.eventCount,
          loaded: engine.has(s.id),
          keywords: { ...(engine.keywordsOf(s.id) ?? s.info ?? {}) },
          groups: w.groups.filter((g) => g.sampleIds.includes(s.id)).map((g) => g.name),
          plate: s.plate,
          well: s.well,
          annotations: { ...((s.well && plate?.annotations?.[s.well]) || {}) },
        };
      });
    },

    channels(): PluginChannel[] {
      const w = ws();
      return allChannels(w).map((c) => ({ name: c.name, label: (w.channelLabels[c.name] ?? c.label ?? '').trim(), range: c.range }));
    },

    findChannel(q: string): string | null {
      const t = typeof q === 'string' ? q.trim() : '';
      if (!t) return null;
      const chans = ctx.channels();
      const lc = t.toLowerCase();
      const one = (l: PluginChannel[]) => (l.length === 1 ? l[0].name : null);
      return chans.find((c) => c.name === t)?.name ?? one(chans.filter((c) => c.name.toLowerCase() === lc)) ?? one(chans.filter((c) => c.label.toLowerCase() === lc));
    },

    populations(): PluginPopulation[] {
      const w = ws();
      return treeOrder(w).map((p) => ({ id: p.id, name: p.name, parentId: p.parentId, path: pathOf(w, p), gate: p.gate, color: p.color }));
    },

    groups() {
      return ws().groups.map((g) => ({ id: g.id, name: g.name, sampleIds: [...g.sampleIds] }));
    },

    events(sampleId, channel, population) {
      const w = ws();
      const pop = popRef(w, population);
      if (!pop || !engine.has(sampleId) || !engine.applies(w, sampleId, pop)) return null;
      const raw = engine.raw(w, sampleId, channel);
      if (!raw) return null;
      return gather(raw, engine.population(w, sampleId, pop));
    },

    count(sampleId, population) {
      const w = ws();
      const pop = popRef(w, population);
      return pop ? engine.countOrNA(w, sampleId, pop) : null;
    },

    stat(sampleId, population, stat, channel, percentile) {
      const w = ws();
      const pop = popRef(w, population);
      if (!pop) return NaN;
      return engine.stat(w, sampleId, { population: pop, stat, channel, percentile });
    },

    addGate(spec) {
      const w = ws();
      const parent = spec.parent && spec.parent !== 'root' ? spec.parent : null;
      if (parent && !popById(w, parent)) throw new Error(`No population "${parent}" to add the gate to`);
      const name = String(spec.name ?? '').trim() || 'Gate';
      return addPopulation(name, parent, checkedGate(spec.gate), spec.color).id;
    },

    setGate(population, gate, sampleId) {
      if (!popById(ws(), population)) throw new Error(`No population "${population}"`);
      commitGate(population, checkedGate(gate), sampleId ?? null, `plugin-gate:${id}:${population}`);
    },

    removePopulation(population) {
      if (popById(ws(), population)) deletePopulation(population, { quiet: true });
    },

    autoGate(req: AutoGateRequest): GateGeom | null {
      const w = ws();
      const { sampleId, x, y } = req;
      const parent = popRef(w, req.parent);
      if (!parent || !engine.has(sampleId)) return null;
      const xScale = engine.scaleFor(w, x, sampleId);
      const yScale = y ? engine.scaleFor(w, y, sampleId) : null;
      const axes = { xScale, yScale };
      const s = autoSession(w, { xParam: x, yParam: y ?? x, plotType: y ? 'dot' : 'histogram' }, axes, sampleId, parent);
      if (!s) return null;
      const u = makeScale(xScale).fwd(req.seed[0]);
      const seed = yScale && req.seed.length > 1 ? { u, v: makeScale(yScale).fwd(req.seed[1]!) } : { u };
      if (!Number.isFinite(u) || ('v' in seed && !Number.isFinite(seed.v))) return null;
      const r = autoGateAt(s, axes, seed, SENSITIVITY[req.tightness ?? 'normal'] ?? SENSITIVITY.normal);
      if (!r) return null;
      return r.kind === '2d' ? { type: 'polygon', x, y: y!, points: r.raw } : { type: 'range', x, min: r.min, max: r.max };
    },

    transaction<T>(fn: () => T): T {
      const st = useStore.getState();
      st.breakGroup();
      const before = st.ws;
      try {
        return runAs(`plugin:${id}`, fn);
      } finally {
        // all steps since `before` become one
        if (useStore.getState().ws !== before) squashSince(before);
      }
    },

    getState(): S | undefined {
      const raw = ws().plugins?.[id];
      if (raw === undefined) return undefined;
      if (!plugin.parseState) return raw as S;
      const key = raw !== null && typeof raw === 'object' ? (raw as object) : null;
      if (key && parsed.has(key)) return parsed.get(key) ?? undefined;
      let v: S | null = null;
      try {
        v = plugin.parseState(raw);
      } catch (e) {
        console.warn(`Plugin "${id}": its saved state could not be read`, e);
      }
      if (key) parsed.set(key, v);
      return v ?? undefined;
    },

    setState(next) {
      const v = typeof next === 'function' ? (next as (prev: S | undefined) => S)(ctx.getState()) : next;
      // plain JSON data (what a saved workspace keeps)
      const plain = v === undefined ? undefined : JSON.parse(JSON.stringify(v));
      useStore.getState().update((w) => {
        if (plain === undefined) {
          if (w.plugins) delete w.plugins[id];
        } else (w.plugins ??= {})[id] = plain;
      }, `plugin-state:${id}`);
    },

    saveCsv(fileName, rows) {
      const name = /\.csv$/i.test(fileName) ? fileName : `${fileName}.csv`;
      return saveFile(name, rows.map((r) => csvLine(r)).join('\n') + '\n');
    },

    saveXlsx(fileName, sheets) {
      const name = /\.xlsx$/i.test(fileName) ? fileName : `${fileName}.xlsx`;
      return saveFile(name, writeXlsxBook(sheets.map((s) => ({ name: s.name, rows: s.rows, header: true }))));
    },

    notify(text, kind = 'info') {
      useStore.getState().toast(String(text), kind);
    },
  };
  contexts.set(plugin, ctx as PluginContext<unknown>);
  return ctx;
}
