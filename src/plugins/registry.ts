// Plugins available in this session: the built-in ones (src/plugins/index.ts) and those loaded from a file
// (Plugins > Load plugin file, for developing and trying a plugin without rebuilding the app). A file plugin is kept
// for the session only: it runs with the app's full access, so it is loaded again on purpose after each reload.
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { create } from 'zustand';
import { PLUGIN_API_VERSION, type FlowStatePlugin } from './api';
import { BUILTIN_PLUGINS } from './index';

export interface PluginEntry {
  // (each plugin has its own state type)
  plugin: FlowStatePlugin<any>;
  source: 'built-in' | 'file';
  /** file the plugin was loaded from */
  fileName?: string;
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;

/** What is wrong with a plugin object, or null when it can be used. */
export function pluginProblem(p: unknown): string | null {
  if (!p || typeof p !== 'object') return 'the file does not provide a plugin (an object with id, name, version, apiVersion and Page)';
  const o = p as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id)) return `invalid id "${String(o.id).slice(0, 40)}": lowercase letters, digits and "-", starting with a letter`;
  if (typeof o.name !== 'string' || !o.name.trim()) return 'the plugin has no name';
  if (typeof o.version !== 'string' || !o.version.trim()) return 'the plugin has no version';
  if (typeof o.apiVersion !== 'number' || !Number.isInteger(o.apiVersion) || o.apiVersion < 1)
    return 'the plugin does not state the plugin API version it was written for (apiVersion)';
  if (o.apiVersion > PLUGIN_API_VERSION)
    return `the plugin needs plugin API version ${o.apiVersion}; this FlowState provides version ${PLUGIN_API_VERSION}. Update FlowState.`;
  if (typeof o.Page !== 'function' && !(o.Page && typeof o.Page === 'object')) return 'the plugin has no page (Page)';
  if (o.parseState !== undefined && typeof o.parseState !== 'function') return 'parseState is not a function';
  return null;
}

function builtins(): PluginEntry[] {
  const out: PluginEntry[] = [];
  for (const p of BUILTIN_PLUGINS) {
    const why = pluginProblem(p);
    if (why) console.error(`Built-in plugin "${(p as { id?: string })?.id}" is not used: ${why}`);
    else if (out.some((e) => e.plugin.id === p.id)) console.error(`Built-in plugin id "${p.id}" is used twice; the second is not used`);
    else out.push({ plugin: p, source: 'built-in' });
  }
  return out;
}

export const usePlugins = create<{ entries: PluginEntry[] }>(() => ({ entries: builtins() }));

export function pluginEntry(id: string | null | undefined): PluginEntry | null {
  return (id && usePlugins.getState().entries.find((e) => e.plugin.id === id)) || null;
}

/**
 * Add a plugin loaded from a file; returns an error message, or null. A file plugin with the same id is replaced (a new
 * build during development); a built-in plugin is not.
 */
export function registerFilePlugin(p: unknown, fileName: string): string | null {
  const why = pluginProblem(p);
  if (why) return why;
  const plugin = p as FlowStatePlugin;
  const { entries } = usePlugins.getState();
  const same = entries.find((e) => e.plugin.id === plugin.id);
  if (same?.source === 'built-in') return `a built-in plugin already has the id "${plugin.id}"`;
  const entry: PluginEntry = { plugin, source: 'file', fileName };
  usePlugins.setState({ entries: same ? entries.map((e) => (e === same ? entry : e)) : [...entries, entry] });
  return null;
}

/** Remove a plugin loaded from a file (its saved state stays with the workspace). */
export function unloadFilePlugin(id: string) {
  usePlugins.setState((s) => ({ entries: s.entries.filter((e) => !(e.source === 'file' && e.plugin.id === id)) }));
}

/** What a plugin file built with `npm run build:plugin` expects to find (see scripts/build-plugin.mjs). */
export interface PluginHost {
  apiVersion: number;
  React: typeof React;
  jsxRuntime: typeof jsxRuntime;
  register(plugin: unknown): void;
  fail(error: unknown): void;
}

/** Runs plugin code with `FlowStateHost` set; the default injects it as a script element (works offline and from file://). */
export type CodeRunner = (code: string) => void;

const scriptRunner: CodeRunner = (code) => {
  const el = document.createElement('script');
  el.textContent = code;
  document.head.appendChild(el); // an inline script runs right here
  el.remove();
};

/**
 * Load a plugin file built with `npm run build:plugin` (one script that registers its plugin). Returns the plugin id, or
 * an error message. The code runs with the app's full access: the caller asks the user first.
 */
export function loadPluginCode(code: string, fileName: string, run: CodeRunner = scriptRunner): { id: string } | { error: string } {
  const got: unknown[] = [];
  let failure: unknown = null;
  const host: PluginHost = {
    apiVersion: PLUGIN_API_VERSION,
    React,
    jsxRuntime,
    register: (p) => void got.push(p),
    fail: (e) => void (failure = failure ?? e),
  };
  const g = globalThis as { FlowStateHost?: PluginHost };
  const prev = g.FlowStateHost;
  g.FlowStateHost = host;
  // errors of the script itself (syntax, a throw while it is set up) are reported as error events
  const onError = (ev: ErrorEvent) => {
    failure = failure ?? ev.error ?? ev.message;
    ev.preventDefault();
  };
  const win = typeof window !== 'undefined' ? window : null;
  win?.addEventListener('error', onError);
  try {
    run(code);
  } catch (e) {
    failure = failure ?? e;
  } finally {
    win?.removeEventListener('error', onError);
    g.FlowStateHost = prev;
  }
  if (failure) return { error: `the plugin could not be started: ${String((failure as Error)?.message ?? failure)}` };
  if (got.length !== 1)
    return { error: got.length ? 'the file registers more than one plugin' : 'the file registers no plugin. Build it with "npm run build:plugin -- <id>" (see docs/PLUGINS.md).' };
  const why = registerFilePlugin(got[0], fileName);
  return why ? { error: why } : { id: (got[0] as FlowStatePlugin).id };
}
