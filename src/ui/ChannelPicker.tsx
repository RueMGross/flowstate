// Searchable channel picker: type to filter (name or marker label), channels of the relevant samples first, keyboard
// friendly. Used wherever a channel is chosen (Inspector, axis menus); exported for the other views too.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as RKE } from 'react';
import { createPortal } from 'react-dom';
import { allChannels, channelDisplayName, isDerivedChannel, sampleHasChannel, type Workspace } from '../core/model';
import { useStore } from '../state/store';

export interface ChannelOption {
  name: string;
  /** marker / stain label, '' if none */
  label: string;
  /** text shown for the channel (as on axes) */
  display: string;
  /** measured (or computable) in one of the preferred samples */
  preferred: boolean;
  derived: boolean;
}

/**
 * All channels of the workspace, those of `preferSamples` first (in file order), then the rest. Without preferred
 * samples every channel counts as preferred.
 */
export function channelOptions(ws: Workspace, preferSamples: string[] = []): ChannelOption[] {
  const ids = preferSamples.filter((id) => ws.samples.some((s) => s.id === id));
  const all = allChannels(ws).map((c) => {
    const label = channelDisplayName(ws, c.name, 'label');
    return {
      name: c.name,
      label: label && label !== c.name ? label : '',
      display: channelDisplayName(ws, c.name),
      preferred: !ids.length || ids.some((id) => sampleHasChannel(ws, id, c.name)),
      derived: isDerivedChannel(ws, c.name),
    };
  });
  return [...all.filter((o) => o.preferred), ...all.filter((o) => !o.preferred)];
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** Options matching a query (every word must occur in the name or label), best matches first within each group. */
export function filterChannels(opts: ChannelOption[], query: string): ChannelOption[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return opts;
  const scored: { o: ChannelOption; s: number; i: number }[] = [];
  opts.forEach((o, i) => {
    const hay = `${o.name} ${o.label}`.toLowerCase();
    const hayN = norm(hay);
    if (!words.every((w) => hay.includes(w) || hayN.includes(norm(w)))) return;
    const q = norm(query);
    const n = norm(o.name);
    const l = norm(o.label);
    const s = n === q || l === q ? 0 : n.startsWith(q) || l.startsWith(q) ? 1 : 2;
    scored.push({ o, s: s + (o.preferred ? 0 : 10), i });
  });
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.o);
}

/** Samples a channel choice is usually about: the active sample and the selected ones. */
export function defaultPreferSamples(): string[] {
  const ui = useStore.getState().ui;
  return [...new Set([ui.activeSampleId, ...ui.selectedSampleIds].filter((x): x is string => !!x))];
}

// ---------------------------------------------------------------- popup list

export interface ChannelMenuProps {
  /** viewport position of the popup's top-left corner (it flips / clamps into the viewport) */
  x: number;
  y: number;
  value?: string;
  /** `how`: chosen with the pointer or the keyboard (Enter) */
  onPick: (channel: string, how?: 'pointer' | 'key') => void;
  onClose: () => void;
  /** samples whose channels are listed first (default: active + selected samples) */
  samples?: string[];
  initialQuery?: string;
  minWidth?: number;
  /** extra first entry, e.g. { value: '', label: 'None' } */
  extra?: { value: string; label: string };
  title?: string;
}

/** Floating searchable channel list (type to filter, arrows + Enter to pick, Escape to close). */
export function ChannelMenu({ x, y, value, onPick, onClose, samples, initialQuery = '', minWidth = 240, extra, title }: ChannelMenuProps) {
  const ws = useStore((s) => s.ws);
  const prefer = useMemo(() => samples ?? defaultPreferSamples(), [samples]);
  const opts = useMemo(() => channelOptions(ws, prefer), [ws, prefer]);
  const [query, setQuery] = useState(initialQuery);
  const shown = useMemo(() => filterChannels(opts, query), [opts, query]);
  const rows: { value: string; o?: ChannelOption; label?: string }[] = useMemo(
    () => [...(extra && !query ? [{ value: extra.value, label: extra.label }] : []), ...shown.map((o) => ({ value: o.name, o }))],
    [extra, query, shown],
  );
  const [active, setActive] = useState(() => Math.max(0, rows.findIndex((r) => r.value === value)));
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - y - m;
    const above = y - m;
    const h = Math.min(r.height, Math.max(below, above));
    const top = r.height <= below || below >= above ? y : Math.max(m, y - h);
    const left = Math.max(m, Math.min(x, vw - m - r.width));
    setPos({ left, top, maxH: Math.max(160, top === y ? below : above) });
  }, [x, y]);

  // first match (or the current channel) highlighted
  useEffect(() => {
    const i = query ? 0 : rows.findIndex((r) => r.value === value);
    setActive(Math.max(0, i));
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, pos]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    const t0 = performance.now();
    const inside = (e: Event) => !!ref.current && e.target instanceof Node && ref.current.contains(e.target);
    const down = (e: PointerEvent) => e.timeStamp > t0 && !inside(e) && close.current();
    const scroll = (e: Event) => (e.type === 'wheel' || e.timeStamp - t0 > 150) && !inside(e) && close.current();
    const gone = () => close.current();
    // an on-screen keyboard (touch screens) changes only the height: the menu stays open for typing
    const w0 = window.innerWidth;
    const resized = () => window.innerWidth !== w0 && close.current();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('wheel', scroll, { capture: true, passive: true });
    window.addEventListener('resize', resized);
    window.addEventListener('blur', gone);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('wheel', scroll, true);
      window.removeEventListener('resize', resized);
      window.removeEventListener('blur', gone);
    };
  }, []);

  const pick = (v: string, how: 'pointer' | 'key') => {
    onPick(v, how);
    onClose();
  };
  const onKey = (e: RKE<HTMLInputElement>) => {
    e.stopPropagation();
    const n = rows.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      if (n) setActive((a) => Math.max(0, Math.min(n - 1, a + (e.key === 'PageDown' ? 8 : -8))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rows[active]) pick(rows[active].value, 'key');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') onClose();
  };
  const firstOther = rows.findIndex((r) => r.o && !r.o.preferred);
  const anyPreferred = rows.some((r) => r.o?.preferred);
  const style: CSSProperties = { left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? 'visible' : 'hidden', minWidth, maxHeight: pos ? Math.min(420, pos.maxH) : 420 };
  return createPortal(
    <div ref={ref} className="ctx-menu chan-menu" role="dialog" aria-label={title ?? 'Choose a channel'} style={style} onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="inp chan-search"
        value={query}
        placeholder="Type to filter channels or markers"
        aria-label="Filter channels"
        role="combobox"
        aria-expanded="true"
        aria-controls="chan-list"
        aria-activedescendant={rows[active] ? `chan-opt-${active}` : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <div ref={listRef} className="chan-list" id="chan-list" role="listbox">
        {rows.map((r, i) => (
          <div key={r.value + i}>
            {i === firstOther && firstOther > 0 && anyPreferred && <div className="chan-group">{prefer.length > 1 ? 'Not in these samples' : 'Not in this sample'}</div>}
            <div
              id={`chan-opt-${i}`}
              data-i={i}
              role="option"
              aria-selected={r.value === value}
              className={`chan-opt${i === active ? ' active' : ''}${r.value === value ? ' cur' : ''}${r.o && !r.o.preferred ? ' other' : ''}`}
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => pick(r.value, 'pointer')}
              title={r.o ? r.o.display : r.label}
            >
              <span className="chan-name">{r.o ? r.o.name : r.label}</span>
              {r.o?.label && <span className="chan-label">{r.o.label}</span>}
              {r.o?.derived && <span className="chan-tag">computed</span>}
            </div>
          </div>
        ))}
        {!rows.length && <div className="chan-empty">No channel matches “{query}”</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- field

export interface ChannelPickerProps {
  value: string;
  onChange: (channel: string) => void;
  ariaLabel?: string;
  /** samples whose channels are listed first (default: active + selected samples) */
  samples?: string[];
  disabled?: boolean;
  /** optional first entry (e.g. 'None'); its value is passed to onChange */
  extra?: { value: string; label: string };
  placeholder?: string;
}

/**
 * A select-like field for one channel that opens the searchable ChannelMenu (click, Enter, Space or the arrow keys; then
 * type to search). Letters typed on the closed field are worksheet shortcuts (tools), not a search. After a choice with
 * the mouse the focus goes back to the worksheet, so the shortcuts work right away.
 */
export function ChannelPicker({ value, onChange, ariaLabel, samples, disabled, extra, placeholder }: ChannelPickerProps) {
  const ws = useStore((s) => s.ws);
  const btn = useRef<HTMLButtonElement>(null);
  const how = useRef<'pointer' | 'key' | null>(null);
  const [open, setOpen] = useState<{ x: number; y: number; w: number; q: string } | null>(null);
  const text = value ? channelDisplayName(ws, value) : extra && value === extra.value ? extra.label : placeholder ?? 'Choose…';
  const show = (q = '') => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setOpen({ x: r.left, y: r.bottom + 2, w: r.width, q });
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="sel chan-btn"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={!!open}
        disabled={disabled}
        title={value ? `${channelDisplayName(ws, value)} (click or type to search)` : undefined}
        onClick={() => (open ? setOpen(null) : show())}
        onKeyDown={(e) => {
          // opened on purpose only; letters stay tool shortcuts (V, P, R ...) while the field is closed
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'F4' || (e.altKey && e.key === 'ArrowDown')) {
            e.preventDefault();
            e.stopPropagation();
            show();
          }
        }}
      >
        <span className="chan-btn-text">{text}</span>
      </button>
      {open && (
        <ChannelMenu
          x={open.x}
          y={open.y}
          minWidth={Math.max(240, open.w)}
          value={value}
          samples={samples}
          extra={extra}
          initialQuery={open.q}
          title={ariaLabel}
          onPick={(v, h) => {
            how.current = h ?? 'pointer';
            if (v !== value) onChange(v);
          }}
          onClose={() => {
            setOpen(null);
            const h = how.current;
            how.current = null;
            requestAnimationFrame(() => {
              // a choice with the mouse: back to the worksheet (shortcuts); keyboard and Escape: stay on the field
              if (h === 'pointer') btn.current?.blur();
              else btn.current?.focus({ preventScroll: true });
            });
          }}
        />
      )}
    </>
  );
}
