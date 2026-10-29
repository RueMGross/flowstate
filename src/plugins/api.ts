// FlowState plugin API, version 1: what a plugin is (FlowStatePlugin) and what it may do (PluginContext). Plugins add
// assay-specific workflows (bead-based multiplex assays such as MACSPlex or LEGENDplex, plate assays ...) on top of the
// app's own data, gates and statistics. They reach the app only through the PluginContext, so the same plugin runs
// built into the app (src/plugins/index.ts) or loaded from a file (Plugins > Load plugin file). See docs/PLUGINS.md.
//
// Compatibility: within an API version, members are only added, never changed or removed. A plugin states the version
// it was written for (apiVersion); the app refuses plugins written for a newer version than PLUGIN_API_VERSION.
import type { ComponentType } from 'react';
import type { GateGeom, StatKind } from '../core/model';

export type { GateGeom, StatKind };

/** Version of the plugin API this app provides. */
export const PLUGIN_API_VERSION = 1;

/** A plugin: its identity and its page. `S` is the plugin's own state, saved with the workspace. */
export interface FlowStatePlugin<S = unknown> {
  /** API version the plugin was written for (PLUGIN_API_VERSION at the time) */
  apiVersion: number;
  /** unique id: lowercase letters, digits and '-', starting with a letter (e.g. "macsplex"); keys the saved state */
  id: string;
  /** shown in the ribbon and the plugin list (e.g. "MACSPlex Exosome") */
  name: string;
  /** the plugin's own version (e.g. "0.1.0") */
  version: string;
  description?: string;
  author?: string;
  /** documentation or source code */
  homepage?: string;
  /** the plugin's page, shown in the Plugins view (see PluginPageProps) */
  Page: ComponentType<PluginPageProps<S>>;
  /**
   * Check (and upgrade) the state saved with a workspace before the plugin uses it, e.g. one written by an older version
   * of the plugin or a damaged file: return the state to use, or null to start without one. Without it, the saved
   * state is used as it is.
   */
  parseState?(raw: unknown): S | null;
}

export interface PluginPageProps<S = unknown> {
  /** everything the plugin may read and do */
  fs: PluginContext<S>;
  /**
   * Changes whenever results may have changed: the workspace was edited (gates, samples, compensation, the plugin's
   * state), data were loaded, background computations finished. Use it as a dependency of useMemo / useEffect for
   * anything computed from fs (counts, statistics, events).
   */
  revision: number;
}

/** A sample of the workspace. */
export interface PluginSample {
  id: string;
  name: string;
  fileName: string;
  eventCount: number;
  /** whether its events are loaded (a workspace opened without its FCS files lists samples that are not) */
  loaded: boolean;
  /** FCS keywords (upper-case keys, e.g. "$DATE", "$CYT", "$WELLID") when loaded, else the few kept with the workspace */
  keywords: Readonly<Record<string, string>>;
  /** names of the groups the sample belongs to */
  groups: string[];
  /** plate and well ("A01") when known */
  plate?: string;
  well?: string;
  /** the plate layout's annotations of its well (e.g. { Analyte: "IL-6", "Concentration (pg/ml)": "1000" }) */
  annotations: Readonly<Record<string, string>>;
}

/** A measured (or computed) channel. */
export interface PluginChannel {
  /** $PnN, the name used everywhere in the API (e.g. "APC-A") */
  name: string;
  /** marker / stain ($PnS or set in the app, e.g. "CD63"); "" when none */
  label: string;
  /** channel range ($PnR) */
  range: number;
}

/** A gated population. */
export interface PluginPopulation {
  id: string;
  name: string;
  /** parent population id; null = All Events */
  parentId: string | null;
  /** "Beads/Singlets/CD63" (names from the top) */
  path: string;
  /** the gate (raw channel values; see GateGeom in core/model.ts) */
  gate: Readonly<GateGeom>;
  color: string;
}

/** What to auto-gate: the population of events around a seed (see PluginContext.autoGate). */
export interface AutoGateRequest {
  /** the sample whose events decide the boundary */
  sampleId: string;
  /** population to look in (default: All Events) */
  parent?: string | null;
  /** x channel; with y a 2-D gate (polygon), without one a 1-D gate (range) */
  x: string;
  y?: string;
  /** a point inside the population, in raw channel values ([x] or [x, y]) */
  seed: [number] | [number, number];
  /** how far the gate reaches into the tails: 'tight' | 'normal' (default) | 'loose' */
  tightness?: 'tight' | 'normal' | 'loose';
}

export type CellValue = string | number | null;

/** Everything a plugin may read and do. All calls are synchronous unless they return a Promise. */
export interface PluginContext<S = unknown> {
  /** the plugin itself (id, name, version) */
  readonly plugin: { id: string; name: string; version: string };

  // ------------------------------------------------------------------ data (read only)

  /** samples in workspace order */
  samples(): PluginSample[];
  /** channels of all samples (union, in first-seen order), including computed ones (unmixing, calibration) */
  channels(): PluginChannel[];
  /** a channel by its name or marker ("APC-A", "apc-a", "CD63"); null when none or ambiguous */
  findChannel(nameOrMarker: string): string | null;
  /** populations in tree order (parents before children) */
  populations(): PluginPopulation[];
  /** groups with their samples */
  groups(): { id: string; name: string; sampleIds: string[] }[];
  /**
   * Values of `channel` for the events of `population` (default All Events) in a sample, compensated as the sample is
   * (the values every statistic uses): a new array, in event order. Null when the sample is not loaded, the channel is
   * missing (or a computed channel is still being computed) or the population does not exist or apply to the sample.
   */
  events(sampleId: string, channel: string, population?: string | null): Float32Array | null;
  /** event count of a population (default All Events); null when not loaded or the population does not apply */
  count(sampleId: string, population?: string | null): number | null;
  /**
   * A statistic, exactly as the Statistics tables compute it ('count', 'freqParent', 'median', 'geomean', 'percentile'
   * ...; channel statistics need `channel`). NaN when it does not apply or has no value (no events, sample not loaded).
   */
  stat(sampleId: string, population: string | null, stat: StatKind, channel?: string, percentile?: number): number;

  // ------------------------------------------------------------------ gates (each call is an undo step; see transaction)

  /** Add a population; returns its id. The name is made unique among its siblings. Throws on an invalid gate or parent. */
  addGate(spec: { name: string; parent?: string | null; gate: GateGeom; color?: string }): string;
  /** Replace a population's gate (with `sampleId`: its sample-specific gate there when it has one, else the shared gate). */
  setGate(population: string, gate: GateGeom, sampleId?: string): void;
  /** Delete a population with its subpopulations. */
  removePopulation(population: string): void;
  /**
   * The gate the app's auto gate draws around a seed (the population of events the seed lies in, by density), or null
   * when no population is found there. The gate is returned, not added: pass it to addGate.
   */
  autoGate(req: AutoGateRequest): GateGeom | null;
  /** Run `fn` (synchronous) as one undo step: everything it changes is undone together. */
  transaction<T>(fn: () => T): T;

  // ------------------------------------------------------------------ the plugin's own state (saved with the workspace)

  /** the plugin's state in this workspace (undefined: none yet); see FlowStatePlugin.parseState */
  getState(): S | undefined;
  /** Save the plugin's state with the workspace (plain JSON data; undoable). */
  setState(next: S | ((prev: S | undefined) => S)): void;

  // ------------------------------------------------------------------ output

  /** Save rows as a CSV file (the user picks where, or it downloads). Resolves to false when cancelled. */
  saveCsv(fileName: string, rows: CellValue[][]): Promise<boolean>;
  /** Save sheets as an Excel workbook (.xlsx). Resolves to false when cancelled. */
  saveXlsx(fileName: string, sheets: { name: string; rows: CellValue[][] }[]): Promise<boolean>;
  /** A short message at the bottom of the window. */
  notify(text: string, kind?: 'info' | 'success' | 'error'): void;
}
