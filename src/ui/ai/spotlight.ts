// "Show me" of the How do I … help: opens the ribbon tab of a button (or the panel of an area) and rings it with a
// short callout. Passive: the ring lets clicks through, it goes away on the next click, Escape or after a while.
import { AREA_SELECTORS, type HelpTarget } from '../../ai/manual';
import { useStore } from '../../state/store';
import { selectRibbonTab } from '../Ribbon';
import { ribbonMinimized, showPanel, useLayout } from '../shell';

let current: (() => void) | null = null;

const frame = () => new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok())));

const visible = (el: Element | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

/** The ribbon button with this label (as shown on it), or the "More commands" button when the ribbon is too narrow. */
function ribbonButton(label: string): { el: HTMLElement; more: boolean } | null {
  const want = label.trim().toLowerCase();
  const buttons = [...document.querySelectorAll('.ribbon-body button, .ribbon-more button')] as HTMLElement[];
  const hit = buttons.find((b) => visible(b) && (b.querySelector('span')?.textContent ?? b.textContent ?? '').trim().toLowerCase() === want);
  if (hit) return { el: hit, more: false };
  const more = document.querySelector('.ribbon-more-btn');
  return visible(more) ? { el: more, more: true } : null;
}

/** Ring the target and show `text` next to it. Resolves false when it is not on screen (the reason is toasted). */
export async function showTarget(t: HelpTarget, text: string): Promise<boolean> {
  clearSpotlight();
  let el: HTMLElement | null = null;
  let note = text;
  if ('tab' in t) {
    if (ribbonMinimized(useLayout.getState())) useLayout.getState().set({ ribbonPeek: true });
    selectRibbonTab(t.tab);
    await frame();
    const tabEl = [...document.querySelectorAll('.ribbon-tab')].find((x) => x.getAttribute('aria-selected') === 'true') as HTMLElement | undefined;
    const b = ribbonButton(t.label);
    if (b) {
      el = b.el;
      if (b.more) note = `"${t.label}" is under More (the window is narrow). ${text}`;
    } else if (t.tab === 'calib') {
      useStore.getState().toast('The Calibration tab is hidden for this experiment: turn on MESF or size calibration under Experiment > Setup (or start a nanoscale analysis).', 'info', { duration: 8000 });
      return false;
    } else el = visible(tabEl ?? null) ? tabEl! : null;
  } else {
    if (t.area === 'samples' || t.area === 'groups' || t.area === 'populations') showPanel('left');
    if (t.area === 'inspector') showPanel('right');
    if (t.area === 'worksheet') useStore.getState().setUI({ view: 'sheet' });
    await frame();
    const found = document.querySelector(AREA_SELECTORS[t.area]);
    el = visible(found) ? found : null;
  }
  if (!el) {
    useStore.getState().toast(`Not on screen right now: ${text}`, 'info', { duration: 7000 });
    return false;
  }
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  ring(el, note);
  return true;
}

function ring(el: HTMLElement, text: string) {
  const spot = document.createElement('div');
  spot.className = 'help-spot';
  const tip = document.createElement('div');
  tip.className = 'help-callout';
  tip.setAttribute('role', 'status');
  tip.textContent = text;
  document.body.append(spot, tip);
  let raf = 0;
  // follows the target while it moves (the ribbon re-fits, panels open)
  const place = () => {
    const r = el.getBoundingClientRect();
    const pad = 4;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const below = r.bottom + 10 + th < window.innerHeight;
    const x = Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2));
    Object.assign(tip.style, { left: `${x}px`, top: `${below ? r.bottom + 10 : Math.max(8, r.top - 10 - th)}px` });
    raf = requestAnimationFrame(place);
  };
  place();
  const end = () => {
    cancelAnimationFrame(raf);
    spot.remove();
    tip.remove();
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
    if (current === end) current = null;
  };
  // the click that started it is over; the next one (anywhere, also on the target) ends it
  const onDown = () => setTimeout(end, 0);
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && end();
  setTimeout(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  }, 0);
  const timer = setTimeout(end, 12000);
  current = end;
}

export function clearSpotlight() {
  current?.();
}
