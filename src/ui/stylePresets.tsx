// Style presets in the UI: applying them to plots, the workspace default for new plots, and shared small widgets.
import { useState } from 'react';
import { setNewPlotStyle, type PlotItem, type PlotOptions, type Worksheet } from '../core/model';
import { pageIsDark } from '../render/figstyle';
import { COLORMAP_GROUPS, COLORMAP_LABELS, COLORMAP_NAMES, CUSTOM_CMAP, colormapCss, type CmapSpec } from '../render/colormaps';
import { applyPreset, copyAppearance, presetById, PRESETS } from '../render/presets';
import { useStore } from '../state/store';
import { ContextMenu } from './widgets';

/**
 * A preset's options for a plot on `sheet`: a dark plot background (Dark preset) is left out on dark pages, so plots
 * take the page's color (automatic background) instead of showing as gray boxes on a dark slide.
 */
function presetOptionsOn(options: Partial<PlotOptions>, sheet: Pick<Worksheet, 'pageColor'> | undefined): Partial<PlotOptions> {
  if (options.bg === 'dark' && pageIsDark(sheet)) {
    const o = { ...options };
    delete o.bg;
    return o;
  }
  return options;
}

// new plots take the appearance of the workspace's default preset (defaultPlotOptions reads it), for the active page
let synced: string | null = null;
function syncNewPlotStyle() {
  const s = useStore.getState();
  const id = s.ws.style.preset;
  const sheet = s.ws.worksheets.find((w) => w.id === s.ui.activeSheetId) ?? s.ws.worksheets[0];
  const key = `${id ?? ''}|${pageIsDark(sheet) ? 'dark' : 'light'}`;
  if (key === synced) return;
  synced = key;
  setNewPlotStyle(presetOptionsOn(presetById(id)?.options ?? {}, sheet));
}
syncNewPlotStyle();
useStore.subscribe(() => syncNewPlotStyle());

export const PRESET_OPTIONS = PRESETS.map((p) => ({ value: p.id, label: p.label }));

/** Apply a preset to the given plots of a sheet ('all': every plot on it). */
export function applyPresetTo(sheetId: string, ids: string[] | 'all', presetId: string) {
  const p = presetById(presetId);
  if (!p) return;
  const st = useStore.getState();
  let n = 0;
  st.update((w) => {
    const sh = w.worksheets.find((s) => s.id === sheetId);
    for (const it of sh?.items ?? []) if (it.kind === 'plot' && (ids === 'all' || ids.includes(it.id))) {
      applyPreset(it, p);
      // the Dark preset on a dark page: the page is the background (no gray boxes)
      if (p.options.bg === 'dark' && pageIsDark(sh)) delete it.options.bg;
      n++;
    }
  });
  if (!n) st.toast('Select one or more plots first.', 'info');
}

/** Copy one plot's appearance to every other plot on the sheet. */
export function copyStyleToSheet(sheetId: string, src: PlotItem) {
  useStore.getState().update((w) => {
    const sh = w.worksheets.find((s) => s.id === sheetId);
    for (const it of sh?.items ?? []) if (it.kind === 'plot' && it.id !== src.id) copyAppearance(it.options, src.options);
  });
}

export function ZebraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4v16h16" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <ellipse cx="12" cy="12" rx="6.5" ry="5" fill="#3b8ee6" />
      <ellipse cx="12" cy="12" rx="4.8" ry="3.6" fill="#bfe3c8" />
      <ellipse cx="12" cy="12" rx="3.2" ry="2.3" fill="#f2c94c" />
      <ellipse cx="12" cy="12" rx="1.6" ry="1.1" fill="#e85d4a" />
    </svg>
  );
}

/** Colormap chooser: a gradient button opening a list of all maps with their swatches. */
export function CmapPicker({ spec, onChange }: { spec: CmapSpec; onChange: (name: string) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className="cmap-btn"
        aria-label="Colormap"
        aria-haspopup="menu"
        title="Colormap"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        <span className="cmap-swatch" style={{ background: colormapCss(spec) }} />
        <span className="cmap-name">{COLORMAP_LABELS[spec.name] ?? spec.name}</span>
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} style={{ maxHeight: 'min(440px, calc(100vh - 8px))', minWidth: 236 }}>
          {[...COLORMAP_NAMES, CUSTOM_CMAP].map((n, i, all) => (
            <div key={n}>
              {i > 0 && (COLORMAP_GROUPS[n] ?? 'Custom') !== (COLORMAP_GROUPS[all[i - 1]] ?? 'Custom') && <hr />}
              <button
                role="menuitemradio"
                aria-checked={n === spec.name}
                className={`cmap-item${n === spec.name ? ' on' : ''}`}
                onClick={() => {
                  onChange(n);
                  setMenu(null);
                }}
              >
                <span className="cmap-swatch" style={{ background: colormapCss({ ...spec, name: n }) }} />
                {COLORMAP_LABELS[n]}
              </button>
            </div>
          ))}
        </ContextMenu>
      )}
    </>
  );
}
