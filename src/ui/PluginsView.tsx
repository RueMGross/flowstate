// Plugins view: the open plugin's page, or the list of plugins (built-in and loaded from a file). See src/plugins/api.ts.
import { useEffect, useRef, useState } from 'react';
import { engine } from '../core/engine';
import { contextFor } from '../plugins/context';
import { loadPluginCode, pluginEntry, unloadFilePlugin, usePlugins, type PluginEntry } from '../plugins/registry';
import { useStore } from '../state/store';
import { ErrorBoundary } from './ErrorBoundary';
import { Modal } from './widgets';

const GUIDE = 'https://github.com/RueMGross/flowstate/blob/main/docs/PLUGINS.md';

/** Changes whenever a plugin's results may change: workspace edits, loaded data, background computations. */
function useRevision(): number {
  const ws = useStore((s) => s.ws);
  const data = useStore((s) => s.ui.dataVersion);
  const [bg, setBg] = useState(0);
  useEffect(() => engine.subscribe(() => setBg((v) => v + 1)), []);
  const ref = useRef({ ws, data, bg, n: 0 });
  const r = ref.current;
  if (r.ws !== ws || r.data !== data || r.bg !== bg) ref.current = { ws, data, bg, n: r.n + 1 };
  return ref.current.n;
}

/** Open a plugin's page (null: the list). */
export function openPlugin(id: string | null) {
  useStore.getState().setUI({ view: 'plugins', activePlugin: id });
}

let pickFile: (() => void) | null = null;
/** Ask for a plugin file (after the trust note); see PluginsView. */
export function loadPluginFile() {
  openPlugin(useStore.getState().ui.activePlugin ?? null);
  setTimeout(() => pickFile?.(), 0);
}

function PluginPage({ entry }: { entry: PluginEntry }) {
  const revision = useRevision();
  const ws = useStore((s) => s.ws);
  const { plugin } = entry;
  const Page = plugin.Page;
  return (
    <ErrorBoundary label={`plugin "${plugin.name}"`} resetKey={ws}>
      <Page fs={contextFor(plugin)} revision={revision} />
    </ErrorBoundary>
  );
}

export function PluginsView() {
  const entries = usePlugins((s) => s.entries);
  const active = useStore((s) => s.ui.activePlugin ?? null);
  const saved = useStore((s) => s.ws.plugins);
  const st = useStore.getState();
  const [trust, setTrust] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    pickFile = () => setTrust(true);
    return () => void (pickFile = null);
  }, []);
  const entry = pluginEntry(active);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const res = loadPluginCode(await f.text(), f.name);
    if ('error' in res) st.toast(`Plugin file "${f.name}": ${res.error}`, 'error');
    else {
      st.toast(`Plugin "${pluginEntry(res.id)?.plugin.name}" loaded from ${f.name} (for this session).`, 'success');
      openPlugin(res.id);
    }
  };

  return (
    <div className="doc-view">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        {entry ? (
          <>
            <button className="btn sm" onClick={() => openPlugin(null)}>
              All plugins
            </button>
            <h2 style={{ margin: 0, fontSize: 16 }}>{entry.plugin.name}</h2>
            <span className="hint" style={{ margin: 0 }}>
              {entry.plugin.version}
              {entry.source === 'file' ? ` · loaded from ${entry.fileName}` : ''}
            </span>
          </>
        ) : (
          <h2 style={{ margin: 0, fontSize: 16 }}>Plugins</h2>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setTrust(true)} title="Load a plugin file built with npm run build:plugin (for this session)">
          Load plugin file…
        </button>
        <a className="btn sm" href={GUIDE} target="_blank" rel="noreferrer">
          Developer guide
        </a>
      </div>
      <input ref={input} type="file" accept=".js" hidden onChange={(e) => void onFile(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
      {entry ? (
        <PluginPage key={entry.plugin.id + (entry.fileName ?? '')} entry={entry} />
      ) : active ? (
        <p className="hint">
          The plugin "{active}" is not available in this FlowState{saved?.[active] !== undefined ? ' (the workspace keeps its saved state)' : ''}. Load its file with Load plugin
          file.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10, maxWidth: 760 }}>
          {!entries.length && <p className="hint">No plugins yet. Plugins add workflows for particular assays (for example bead-based multiplex assays); see the developer guide.</p>}
          {entries.map((e) => (
            <div key={e.plugin.id} className="card">
              <div className="card-head">
                <h3>{e.plugin.name}</h3>
                <span className="hint" style={{ margin: 0 }}>
                  {e.plugin.version} · {e.source === 'file' ? `loaded from ${e.fileName}` : 'built in'}
                </span>
                <span style={{ flex: 1 }} />
                {e.source === 'file' && (
                  <button className="btn sm" onClick={() => unloadFilePlugin(e.plugin.id)}>
                    Unload
                  </button>
                )}
                <button className="btn sm primary" onClick={() => openPlugin(e.plugin.id)}>
                  Open
                </button>
              </div>
              {(e.plugin.description || e.plugin.author) && (
                <div className="card-body">
                  {e.plugin.description && <p style={{ margin: 0 }}>{e.plugin.description}</p>}
                  {e.plugin.author && <p className="hint">By {e.plugin.author}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {trust && (
        <Modal
          title="Load a plugin file"
          onClose={() => setTrust(false)}
          footer={
            <>
              <button className="btn" data-autofocus onClick={() => setTrust(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setTrust(false);
                  input.current?.click();
                }}
              >
                Choose file…
              </button>
            </>
          }
        >
          <p>
            A plugin file is a program: it runs inside FlowState with full access to your data, your analysis and the AI settings. Only load plugins from people you
            trust.
          </p>
          <p className="hint">The plugin stays loaded until the page is reloaded. Its saved state is kept with the workspace.</p>
        </Modal>
      )}
    </div>
  );
}
