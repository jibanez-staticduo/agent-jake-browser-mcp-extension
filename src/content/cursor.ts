/**
 * Virtual cursor (INFRA-855): the indicator the extension draws while the agent
 * clicks and types. The agent's events are synthetic (CDP) and never move the
 * real mouse; this pointer glides from the previous action point to the next,
 * ripples on click and pulses while typing, and fades after a moment of quiet.
 */

const GLIDE_MIN_MS = 160;
const GLIDE_MAX_MS = 450;
const IDLE_HIDE_MS = 2000;

/** Glide time (ms) for a move of `dist` CSS px: proportional, clamped. */
export function glideMs(dist: number): number {
  return Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, Math.round(dist * 0.8)));
}

export interface CursorEvent {
  kind?: 'move' | 'click' | 'type';
  x?: number;
  y?: number;
}

let pointer: HTMLDivElement | null = null;
let last: { x: number; y: number } | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function ensurePointer(): HTMLDivElement {
  if (pointer) return pointer;
  pointer = document.createElement('div');
  pointer.style.cssText =
    'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;will-change:transform';
  pointer.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 3l14 8-6.5 1.5L9 19z" fill="#c96442" stroke="#ffffff" stroke-width="1.5"/></svg>';
  document.documentElement.appendChild(pointer);
  return pointer;
}

/** Move the pointer to (x, y); returns the glide duration so the click can wait for it. */
function glideTo(x: number, y: number): number {
  const node = ensurePointer();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ms = !last || reduced ? 0 : glideMs(Math.hypot(x - last.x, y - last.y));
  node.style.transition = `transform ${ms}ms cubic-bezier(.22,1,.36,1), opacity .3s`;
  node.style.transform = `translate(${x}px, ${y}px)`;
  node.style.opacity = '1';
  last = { x, y };
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (pointer) pointer.style.opacity = '0';
  }, IDLE_HIDE_MS);
  return ms;
}

/** Expanding ring at (x, y): the click ripple / typing pulse. */
function ring(x: number, y: number, size: number): void {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px;` +
    'border-radius:50%;border:2px solid #c96442;pointer-events:none;z-index:2147483646;transform:scale(.2);opacity:1;' +
    'transition:transform .45s ease-out,opacity .45s ease-out';
  document.documentElement.appendChild(el);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.transform = 'scale(1.8)';
      el.style.opacity = '0';
    })
  );
  setTimeout(() => el.remove(), 700);
}

export function showCursor(event: CursorEvent): void {
  if (event.x !== undefined && event.y !== undefined) {
    const x = event.x;
    const y = event.y;
    const ms = glideTo(x, y);
    if (event.kind === 'click') setTimeout(() => ring(x, y, 28), ms);
  } else if (event.kind === 'type' && last) {
    ring(last.x, last.y, 16);
  }
}
