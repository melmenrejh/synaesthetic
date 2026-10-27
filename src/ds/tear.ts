// The torn right edge of the primary button, ported from the design system's bundle.js
// (Synaesthetic.tear): deterministic per label, so a button always tears the same way.

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One edge: a slow wobble plus fine fibre jitter, depth in px into the shape. */
function edge(len: number, depth: number, step: number, r: () => number): [number, number][] {
  const n = Math.max(2, Math.round(len / step));
  const out: [number, number][] = [];
  const wob = r() * 6.28, f = 1.5 + r() * 2.5;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const slow = (Math.sin(u * f * 6.28 + wob) + 1) / 2;
    let d = depth * (0.55 * slow + 0.45 * r());
    if (i === 0 || i === n) d = depth * 0.5;
    out.push([u * len, d]);
  }
  return out;
}

export function tear(el: HTMLElement) {
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h) return;
  const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
  const r = rng(hash(el.dataset.seed || label || 'synaesthetic'));
  const pts: [number, number][] = [[0, 0], [w, 0]];
  for (const [y, d] of edge(h, 3, 3, r)) pts.push([w - d, y]);
  pts.push([w, h], [0, h]);
  el.style.setProperty('--torn-clip', `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',')})`);
}

const observer = new ResizeObserver((entries) => entries.forEach((e) => tear(e.target as HTMLElement)));

/** Tears every primary button inside root and keeps them torn when their size changes. */
export function tearAll(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('.s-btn--primary').forEach((el) => {
    tear(el);
    observer.observe(el);
  });
}
