// Text shortened in the middle to the width of its box ("Specimen_001_H…07_018.fcs"), the full text as tooltip. For
// file and sample names, whose start and end tell them apart (CSS text-overflow only cuts the end).
import { useLayoutEffect, useRef, useState } from 'react';
import { middleEllipsis } from '../render/figstyle';

let measureCtx: CanvasRenderingContext2D | null = null;

/** Width (px) of `text` in the computed font of `el`. */
function textWidth(el: HTMLElement, text: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7;
  const cs = getComputedStyle(el);
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return measureCtx.measureText(text).width;
}

/**
 * `text` in a block that fills its parent's width (min-width 0 in flex rows), shortened in the middle when it does not
 * fit; the full text is the tooltip (and the accessible name) whenever it is shortened.
 */
export function MiddleText({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      if (!(w > 0)) {
        setShown(text);
        return;
      }
      setShown(middleEllipsis(text, (t) => textWidth(el, t) <= w));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  const cut = shown !== text;
  return (
    <span ref={ref} className={className} title={cut ? text : undefined} aria-label={cut ? text : undefined} style={{ display: 'block', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', ...style }}>
      {shown}
    </span>
  );
}
