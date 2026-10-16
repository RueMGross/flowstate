import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { middleEllipsis } from '../render/figstyle';

export function Field({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="frow" title={title}>
      <label>{label}</label>
      {children}
    </div>
  );
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Width (px) of `text` in the computed font of `el`. */
function textWidthIn(el: HTMLElement, text: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7;
  const cs = getComputedStyle(el);
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return measureCtx.measureText(text).width;
}

/**
 * Drop-down list. `fit`: long labels (names whose start and end tell them apart) are shortened in the middle to the
 * width of the list, the full text is the tooltip.
 */
export function Sel<T extends string>({
  value,
  options,
  onChange,
  id,
  ariaLabel,
  fit,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  id?: string;
  ariaLabel?: string;
  fit?: boolean;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!fit || !el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      // the text area: the inner width without the padding and the drop-down arrow
      setRoom(Math.max(0, el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) - 22));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  const shown = (label: string) => (fit && room > 0 && ref.current ? middleEllipsis(label, (t) => textWidthIn(ref.current!, t) <= room) : label);
  const cur = options.find((o) => o.value === value);
  return (
    <select ref={ref} id={id} aria-label={ariaLabel} className="sel" value={value} title={fit ? cur?.label : undefined} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled} title={o.title ?? (fit ? o.label : undefined)}>
          {shown(o.label)}
        </option>
      ))}
    </select>
  );
}

/** Shared logic of Num / Txt: local text while typing, committed on Enter, blur or unmount (to the item it was typed for). */
function useDraft<T>(value: T, fmt: (v: T) => string, commitText: (text: string) => T | undefined) {
  const [s, setS] = useState(fmt(value));
  const [rev, setRev] = useState(0);
  const dirty = useRef(false);
  const latest = useRef({ s, commitText });
  latest.current = { s, commitText };
  // follow outside changes unless the user is typing
  useEffect(() => {
    if (!dirty.current) setS(fmt(value));
  }, [value, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    latest.current.commitText(latest.current.s);
  };
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    s,
    set: (t: string) => {
      dirty.current = true;
      setS(t);
    },
    commit: () => {
      commit();
      setRev((r) => r + 1);
    },
    reset: (v: T) => {
      dirty.current = false;
      setS(fmt(v));
    },
  };
}

export function Num({ value, onChange, step, min, max, id, ariaLabel, digits }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; id?: string; ariaLabel?: string; digits?: number }) {
  const fmt = (v: number) => (Number.isFinite(v) ? (digits !== undefined ? String(Number(v.toFixed(digits))) : String(v)) : '');
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const d = useDraft(value, fmt, (text) => {
    const v = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(v)) return undefined;
    const vv = clamp(v);
    if (vv !== value) onChange(vv);
    return vv;
  });
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      className="inp num"
      type="text"
      inputMode="decimal"
      value={d.s}
      onChange={(e) => d.set(e.target.value)}
      onBlur={d.commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') d.commit();
        if (e.key === 'Escape') d.reset(value);
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const dd = (step ?? 1) * (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
          const v = Number(clamp((Number.isFinite(value) ? value : 0) + dd).toFixed(6));
          d.reset(v);
          onChange(v);
        }
      }}
    />
  );
}

export function Txt({ value, onChange, placeholder, id, ariaLabel }: { value: string; onChange: (v: string) => void; placeholder?: string; id?: string; ariaLabel?: string }) {
  const d = useDraft(value, (v) => v, (text) => {
    if (text !== value) onChange(text);
    return text;
  });
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      className="inp"
      value={d.s}
      placeholder={placeholder}
      onChange={(e) => d.set(e.target.value)}
      onBlur={d.commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') d.reset(value);
      }}
    />
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} title={o.title} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <label className="check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/**
 * Small "i" button with a short explanation ("what is this?"). Shown while the mouse is over it or it has keyboard
 * focus; a click or tap pins it open; Escape, a click elsewhere, scrolling or resizing closes it. The popup is placed
 * in the viewport (below, or above when there is no room) and never wider than the screen.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || focus || pinned;
  const openRef = useRef(open);
  openRef.current = open;
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const leave = useRef(0);
  const id = useId();
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const width = typeof window === 'undefined' ? 320 : Math.min(340, window.innerWidth - 32);
  const closeAll = () => {
    setHover(false);
    setFocus(false);
    setPinned(false);
  };
  const enter = () => {
    window.clearTimeout(leave.current);
    setHover(true);
  };
  const exit = () => {
    window.clearTimeout(leave.current);
    leave.current = window.setTimeout(() => setHover(false), 160);
  };
  // registered at mount (before the enclosing dialog's own listener), so Escape closes only the tip
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !openRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeAll();
    };
    window.addEventListener('keydown', k, true);
    return () => {
      window.removeEventListener('keydown', k, true);
      window.clearTimeout(leave.current);
    };
  }, []);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = pop.current?.offsetHeight ?? 0;
    const left = Math.min(Math.max(16, b.left + b.width / 2 - width / 2), vw - 16 - width);
    const below = b.bottom + 8;
    const top = below + h > vh - 8 && b.top - 8 - h >= 8 ? b.top - 8 - h : below;
    setPos({ left, top });
    const shut = (e: Event) => {
      if (e.type === 'pointerdown' && (btn.current?.contains(e.target as Node) || pop.current?.contains(e.target as Node))) return;
      closeAll();
    };
    document.addEventListener('pointerdown', shut, true);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      document.removeEventListener('pointerdown', shut, true);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
    };
  }, [open, width]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={'info-tip' + (open ? ' on' : '')}
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={(e) => e.pointerType === 'mouse' && enter()}
        onPointerLeave={(e) => e.pointerType === 'mouse' && exit()}
        onFocus={(e) => setFocus(e.currentTarget.matches(':focus-visible'))}
        onBlur={() => setFocus(false)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (pinned) closeAll();
          else setPinned(true);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            id={id}
            role="tooltip"
            className="info-tip-pop"
            style={pos ? { left: pos.left, top: pos.top, width } : { left: 0, top: 0, width, visibility: 'hidden' }}
            onPointerEnter={(e) => e.pointerType === 'mouse' && enter()}
            onPointerLeave={(e) => e.pointerType === 'mouse' && exit()}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

export function ColorIn({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel?: string }) {
  return <input type="color" className="color-in" aria-label={ariaLabel ?? 'Color'} value={toHex(value)} onChange={(e) => onChange(e.target.value)} />;
}

function toHex(c: string) {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('');
  return '#000000';
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, children, onClose, footer, wide, closable = true }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean; closable?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const closableRef = useRef(closable);
  closableRef.current = closable;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // initial focus: an element marked data-autofocus (e.g. Cancel of a destructive confirmation), else the first field
    // of the body, else the primary button, else the dialog
    const el = ref.current;
    const first =
      el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(`.modal-body :is(${FOCUSABLE})`) ?? el?.querySelector<HTMLElement>('.modal-foot .primary') ?? el;
    first?.focus({ preventScroll: true });
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      if (closableRef.current) close.current();
    };
    window.addEventListener('keydown', k, true);
    return () => {
      window.removeEventListener('keydown', k, true);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);
  // keep Tab inside the dialog
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
    if (!els.length) return;
    const a = els[0];
    const b = els[els.length - 1];
    if (e.shiftKey && (document.activeElement === a || document.activeElement === ref.current)) {
      e.preventDefault();
      b.focus();
    } else if (!e.shiftKey && document.activeElement === b) {
      e.preventDefault();
      a.focus();
    }
  };
  // portal: a dialog opened from inside a panel or view is still centered on the window
  return createPortal(
    <div className="modal-back" onPointerDown={(e) => closable && e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={trap}>
        <div className="modal-head">
          <span className="grow">{title}</span>
          {closable && (
            <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Floating menu at a viewport point: flips / clamps into the viewport after measuring itself and closes on
 * outside press, Escape, scrolling, resizing or window blur. Clicking one of its buttons closes it too.
 */
export function ContextMenu({ x, y, onClose, children, style, keepOpen }: { x: number; y: number; onClose: () => void; children: ReactNode; style?: CSSProperties; keepOpen?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + r.width > vw - m ? x - r.width : x;
    let top = y + r.height > vh - m ? y - r.height : y;
    left = Math.max(m, Math.min(left, vw - m - r.width));
    top = Math.max(m, Math.min(top, vh - m - r.height));
    setPos({ left, top });
  }, [x, y]);
  useEffect(() => {
    // take the keyboard focus once the opening press is over; give it back on close
    const prev = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => ref.current && !ref.current.contains(document.activeElement) && ref.current.focus({ preventScroll: true }));
    const t0 = performance.now();
    const inside = (e: Event) => !!ref.current && e.target instanceof Node && ref.current.contains(e.target);
    const down = (e: PointerEvent) => e.timeStamp > t0 && !inside(e) && close.current();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const btns = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
        if (!btns.length) return;
        e.preventDefault();
        e.stopPropagation();
        const i = btns.indexOf(document.activeElement as HTMLElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1) + (i < 0 && e.key === 'ArrowUp' ? 1 : 0)) % btns.length].focus();
      }
    };
    // scrolling closes the menu (not the scroll-into-view that focusing the clicked element may cause right away)
    const scroll = (e: Event) => (e.type === 'wheel' || e.timeStamp - t0 > 150) && !inside(e) && close.current();
    // window blur closes it, except while a color input of the menu has its system picker open
    const pickingColor = () => {
      const a = document.activeElement;
      return a instanceof HTMLInputElement && a.type === 'color' && !!ref.current?.contains(a);
    };
    const gone = (e: Event) => !(e.type === 'blur' && pickingColor()) && close.current();
    // an on-screen keyboard (touch screens) changes only the height: no reason to close
    const w0 = window.innerWidth;
    const resized = () => window.innerWidth !== w0 && close.current();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('wheel', scroll, { capture: true, passive: true });
    window.addEventListener('resize', resized);
    window.addEventListener('blur', gone);
    return () => {
      cancelAnimationFrame(raf);
      if (prev && prev !== document.body && document.contains(prev) && (document.activeElement === document.body || !document.activeElement)) prev.focus({ preventScroll: true });
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('wheel', scroll, true);
      window.removeEventListener('resize', resized);
      window.removeEventListener('blur', gone);
    };
  }, []);
  // portal: the menu is not part of the worksheet (keys aimed at it are not worksheet keys)
  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? 'visible' : 'hidden', maxHeight: 'calc(100vh - 8px)', overflowY: 'auto', ...style }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => !keepOpen && (e.target as HTMLElement).closest('button') && onClose()}
    >
      {children}
    </div>,
    document.body,
  );
}
