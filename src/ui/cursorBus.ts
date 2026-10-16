// Lightweight channel for the pointer read-out in the status bar (avoids store updates on every mouse move).
type L = (t: string) => void;
const listeners = new Set<L>();
let last = '';
export function setCursorInfo(t: string) {
  if (t === last) return;
  last = t;
  listeners.forEach((l) => l(t));
}
export function onCursorInfo(l: L) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
