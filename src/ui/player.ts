// The player under the sleeve in hand (design system: Player). No plate: a centred column —
// the round play / pause button under a progress arc (drag along it to seek), elapsed and duration
// level with the arc's ends, and the volume as a number between «−» and «+». No track title: it is
// already on the screen, in the caption.
import { h } from './dom';

const PLAY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>';
const MINUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M3.5 8h9"/></svg>';
const PLUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
const ARC = 'M8 44A36 36 0 0 1 80 44';

const time = (s: number) => {
  if (!Number.isFinite(s)) return '–:––';
  const r = Math.max(0, Math.round(s));
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
};

export interface PlayerHandlers {
  toggle(): void;
  seek(seconds: number): void;
  volume(level: number): void;
}

export function createPlayer(on: PlayerHandlers) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 88 88');
  svg.setAttribute('aria-hidden', 'true');
  const path = (cls: string, extra: Record<string, string> = {}) => {
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('class', cls);
    p.setAttribute('d', ARC);
    for (const [k, v] of Object.entries(extra)) p.setAttribute(k, v);
    return p;
  };
  const thumb = document.createElementNS(svgNS, 'line');
  thumb.setAttribute('class', 's-dial__thumb');
  Object.entries({ x1: '44', y1: '2', x2: '44', y2: '14' }).forEach(([k, v]) => thumb.setAttribute(k, v));
  const hit = path('s-dial__hit');
  svg.append(path('s-dial__track'), path('s-dial__done', { pathLength: '100' }), thumb, hit);

  const seek = h('input', { class: 's-player__seek', type: 'range', min: '0', max: '1', step: '1', value: '0', 'aria-label': 'Позиция в треке' });
  const play = h('button', { type: 'button', class: 's-btn s-btn--round', 'aria-label': 'Слушать' });
  play.innerHTML = PLAY;
  const dial = h('div', { class: 's-player__dial' }, seek, play);
  dial.prepend(svg);
  const cur = h('span', {}, '0:00');
  const dur = h('span', {}, '–:––');
  const down = h('button', { type: 'button', class: 's-btn s-btn--icon', 'aria-label': 'Тише' });
  const up = h('button', { type: 'button', class: 's-btn s-btn--icon', 'aria-label': 'Громче' });
  down.innerHTML = MINUS;
  up.innerHTML = PLUS;
  const level = h('output', { class: 's-player__level', 'aria-live': 'polite' });
  const root = h(
    'section',
    { class: 's-player', 'aria-label': 'Плеер' },
    h('div', { class: 's-player__progress' }, cur, dial, dur),
    h('div', { class: 's-player__volume', role: 'group', 'aria-label': 'Громкость' }, down, level, up),
  );

  let duration = NaN;
  let vol = 80;
  let seeking = false;

  function paintTime(t: number) {
    const p = Number.isFinite(duration) && duration > 0 ? Math.min(1, t / duration) : 0;
    dial.style.setProperty('--p', (p * 100).toFixed(2));
    cur.textContent = time(t);
    seek.value = String(Math.round(t));
    seek.setAttribute('aria-valuetext', `${time(t)} из ${time(duration)}`);
  }
  function paintVolume() {
    level.textContent = String(vol);
    level.classList.toggle('is-zero', vol === 0);
    down.disabled = vol === 0;
    up.disabled = vol === 100;
  }

  // drag along the arc: the angle from 9 o'clock over the top to 3 o'clock; below the arc, the
  // nearer end
  function seekTo(e: PointerEvent) {
    if (!Number.isFinite(duration)) return;
    const r = dial.getBoundingClientRect();
    const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    const a = Math.atan2(x, -y);
    const t = y > 0 ? (x < 0 ? 0 : 1) : Math.min(1, Math.max(0, (a + Math.PI / 2) / Math.PI));
    paintTime(t * duration);
    on.seek(t * duration);
  }
  hit.addEventListener('pointerdown', (e) => {
    seeking = true;
    dial.classList.add('is-seeking');
    hit.setPointerCapture(e.pointerId);
    seekTo(e);
    seek.focus({ preventScroll: true });
  });
  hit.addEventListener('pointermove', (e) => seeking && seekTo(e));
  const endSeek = () => {
    seeking = false;
    dial.classList.remove('is-seeking');
  };
  hit.addEventListener('pointerup', endSeek);
  hit.addEventListener('pointercancel', endSeek);
  // keyboard: arrows ±1 s, PageUp / PageDown ±10 s (the hidden range does the stepping)
  seek.addEventListener('keydown', (e) => {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
    e.preventDefault();
    const t = Number(seek.value) + (e.key === 'PageUp' ? 10 : -10);
    on.seek(Math.max(0, Math.min(duration, t)));
  });
  seek.addEventListener('input', () => on.seek(Number(seek.value)));

  play.addEventListener('click', () => on.toggle());
  const step = (d: number) => {
    vol = Math.max(0, Math.min(100, vol + d));
    paintVolume();
    on.volume(vol);
  };
  down.addEventListener('click', () => step(-10));
  up.addEventListener('click', () => step(10));
  for (const b of [down, up, level] as HTMLElement[]) {
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        step(e.key === 'ArrowUp' ? 10 : -10);
      }
    });
  }

  return {
    root,
    /** Where the track is and whether it plays. */
    update(s: { playing: boolean; current: number; duration: number }) {
      if (s.duration !== duration) {
        duration = s.duration;
        seek.max = String(Number.isFinite(duration) ? Math.round(duration) : 1);
        dur.textContent = time(duration);
      }
      if (!seeking) paintTime(s.current);
      const label = s.playing ? 'Пауза' : 'Слушать';
      if (play.getAttribute('aria-label') !== label) {
        play.innerHTML = s.playing ? PAUSE : PLAY;
        play.setAttribute('aria-label', label);
      }
    },
    setVolume(v: number) {
      vol = v;
      paintVolume();
    },
  };
}
