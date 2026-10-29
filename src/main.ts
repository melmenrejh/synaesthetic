import './styles/tokens.css';
import './styles/components.css';
import './styles/app.css';
import { deleteBottle, getBlob, loadShelf } from './data/db';
import type { ShelfEntry } from './data/model';
import { tearAll } from './ds/tear';
import { bitmapOf } from './images/process';
import { Shelf, type ShelfItem } from './shelf/scene';
import { openAddFlow } from './ui/addFlow';
import { confirmDialog } from './ui/confirm';
import { createPlayer } from './ui/player';
import { h, icon, revealWords } from './ui/dom';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = document.documentElement;
let shelf: Shelf | null = null;

// ---------- theme: День / Ночь follow the system ----------
const dark = matchMedia('(prefers-color-scheme: dark)');
const setTheme = () => {
  root.dataset.theme = dark.matches ? 'dark' : 'light';
  shelf?.applyTheme();
};
dark.addEventListener('change', setTheme);
setTheme();

// Canvas text needs the fonts loaded before the first sleeve is drawn.
await Promise.race([
  Promise.all(['28px Prata', '400 14px "IBM Plex Mono"', '500 14px "IBM Plex Mono"'].map((f) => document.fonts.load(f))),
  new Promise((r) => setTimeout(r, 2500)),
]);

// the tip over a hovered sleeve (see showSleeveTip): ready before the shelf can be hovered
const sleeveTip = h('span', { class: 's-tip', role: 'tooltip' });
const sleeveTipAnchor = h('div', { class: 's-tip-anchor shelf-tip', 'aria-hidden': 'true' }, sleeveTip);
document.body.append(sleeveTipAnchor);
let tipTimer = 0;

// ---------- the shelf ----------
try {
  shelf = new Shelf($('stage'), {
    onPick: showHeld,
    onPutBack: hideHeld,
    onChange: syncActions,
    onPeek: showPeekHint,
    onHover: showSleeveTip,
    onWall: applyWallTone,
  });
} catch {
  $('stage').append(h('p', { class: 'fail ui' }, 'Этот браузер не смог запустить 3D. Открой страницу в свежем Chrome, Safari или Firefox.'));
}

let entries: ShelfEntry[] = [];

async function refresh() {
  entries = await loadShelf();
  const items: ShelfItem[] = await Promise.all(
    entries.map(async (entry) => {
      const coverId = entry.current?.pairing.coverImage ?? entry.current?.track.artwork;
      const [cover, photo, cutout] = await Promise.all(
        [coverId, entry.bottle.photo, entry.bottle.cutout].map((id) => (id ? bitmapOf(id, getBlob) : null)),
      );
      return { entry, images: { cover, photo, cutout } };
    }),
  );
  shelf?.setItems(items);
  $('empty').hidden = entries.length > 0;
  $('add').hidden = entries.length === 0;
  renderIndex();
  const picked = shelf?.pickedEntry;
  if (picked) showHeld(picked);
}

// Keyboard and screen-reader way onto the shelf: one button per sleeve, in shelf order.
function renderIndex() {
  $('index').replaceChildren(
    ...entries.map((e, i) =>
      h('li', {}, h('button', { type: 'button', onclick: () => shelf?.pick(i) }, `${e.bottle.name}${e.bottle.brand ? `, ${e.bottle.brand}` : ''}`)),
    ),
  );
}

// ---------- the sleeve in hand ----------
function showHeld(e: ShelfEntry) {
  document.body.classList.add('is-held');
  const caption = $('caption');
  caption.replaceChildren(
    ...present(
      h('h2', { class: 'name' }, ...revealWords(e.bottle.name)),
      e.bottle.brand ? h('p', { class: 'ui muted' }, e.bottle.brand) : null,
      h('p', { class: 'meta muted' }, e.current ? `сейчас звучит: ${trackLine(e)}` : 'песни пока нет'),
    ),
  );
  caption.hidden = false;
  setTextTone(shelf?.backdropTone ?? null);
  syncActions();
}

function hideHeld() {
  document.body.classList.remove('is-held');
  $('caption').hidden = true;
  $('actions').hidden = true;
  setTextTone(null);
  void syncAudio();
}

// ---------- what lies on the wall ----------
// The top bar, the empty-shelf words and the credits sit on the wall, whose colour comes from the
// model (dark plaster, light paint…): they take the light or the dark ink by the wall, not by the theme.
function applyWallTone() {
  const tone = shelf?.wallTone ?? 'dark';
  for (const el of document.querySelectorAll<HTMLElement>('.topbar, .empty, .credits')) el.dataset.theme = tone;
}

// ---------- paging hint ----------
// While the view leans toward the next shelf, a quiet toast (design system: Toast, quiet) above
// the shelf in view says where the next gesture will go. It leaves when the step is made or
// the lean times out.
let peekHint: HTMLElement | null = null;

function showPeekHint(dir: -1 | 0 | 1) {
  if (peekHint) {
    const old = peekHint;
    old.querySelector('.s-toast')?.classList.add('is-leaving');
    setTimeout(() => old.remove(), 420);
    peekHint = null;
  }
  const at = dir && shelf?.hintAnchor();
  if (!at) return;
  // on the wall, as the top bar: the wall's tone, whatever the theme
  peekHint = h(
    'div',
    { class: 's-toast-stack s-toast-stack--quiet shelf-hint', 'data-theme': shelf?.wallTone ?? 'dark' },
    h(
      'div',
      { class: 's-toast s-toast--quiet', role: 'status' },
      h('span', { class: 's-toast__text' }, dir > 0 ? 'следующая полка' : 'предыдущая полка'),
    ),
  );
  Object.assign(peekHint.style, { left: `${at.x}px`, top: `${at.y}px`, transform: 'translate(-50%, -100%)' });
  document.body.append(peekHint);
}

// ---------- tip over the hovered sleeve ----------
// Which perfume it is (design system: Tip): above the sleeve as it stands once risen, after
// --tip-delay; moved straight to a neighbour, it shows at once — the tips are already being read.
// One tip on the screen, leaving at once when the mouse does.

function showSleeveTip(e: ShelfEntry | null) {
  clearTimeout(tipTimer);
  const shown = sleeveTip.classList.contains('is-visible');
  sleeveTip.classList.remove('is-visible');
  const at = e && shelf?.hoverAnchor();
  if (!e || !at) return;
  sleeveTip.textContent = e.bottle.brand ? `${e.bottle.name}, ${e.bottle.brand}` : e.bottle.name;
  sleeveTipAnchor.dataset.theme = shelf?.wallTone ?? 'dark';
  // near the top edge the tip goes under the sleeve's top instead
  sleeveTip.classList.toggle('s-tip--below', at.y < 64);
  Object.assign(sleeveTipAnchor.style, { left: `${at.x}px`, top: `${at.y}px` });
  const show = () => sleeveTip.classList.add('is-visible');
  if (shown) show();
  else tipTimer = window.setTimeout(show, 400);
}

// On water in a cover's colours, the caption and the words take the light or the dark ink,
// whichever reads better there; on the theme's water they follow the theme.
function setTextTone(tone: 'light' | 'dark' | null) {
  for (const el of [$('caption'), $('actions'), dock]) {
    if (tone) el.dataset.theme = tone;
    else delete el.dataset.theme;
  }
}

// ---------- the record plays the song's own file ----------
// Order from the MVP doc §5: own file → platform player → «open in the app». The file plays while
// the record is out of its sleeve and fades away when it goes back.
const audio = new Audio();
audio.loop = true;
let audioFor = '';
let fade = 0;
/** The person paused it with the player; stays paused until they press play again. */
let userPaused = false;

// The volume, 0–100, remembered between visits (design system: Player).
const VOLUME_KEY = 'synaesthetic.volume';
let volume = (() => {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && v >= 0 && v <= 100 ? v : 80;
  } catch {
    return 80;
  }
})();

// ---------- the player under the sleeve ----------
// Shown while the record of a song with its own file is out (a song by link opens where it lives).
const player = createPlayer({
  toggle: () => void togglePlay(),
  seek: (t) => {
    if (Number.isFinite(t)) audio.currentTime = t;
    paintPlayer();
  },
  volume: (v) => {
    volume = v;
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      // private window: the level just is not remembered
    }
    clearInterval(fade);
    audio.volume = v / 100;
  },
});
player.setVolume(volume);
const dock = h('div', { class: 'player-dock', hidden: true }, player.root);
document.body.append(dock);

function paintPlayer() {
  player.update({ playing: !audio.paused && !userPaused, current: audio.currentTime, duration: audio.duration });
}
for (const ev of ['timeupdate', 'play', 'pause', 'durationchange', 'loadedmetadata', 'seeked']) audio.addEventListener(ev, paintPlayer);
// the arc moves smoothly while it plays (timeupdate alone comes ~4 times a second)
(function tick() {
  if (!dock.hidden && !audio.paused) paintPlayer();
  requestAnimationFrame(tick);
})();

/** Shows the player under the sleeve and has the sleeve make room for it, or hides it. */
function showPlayer(on: boolean) {
  if (on === !dock.hidden) return placePlayer();
  dock.hidden = !on;
  shelf?.setDock(on ? dock.getBoundingClientRect().height : 0);
  placePlayer();
}
function placePlayer() {
  if (!dock.hidden && shelf) dock.style.top = `${shelf.dockTop}px`;
}
// the sleeve's size depends on the window: the scene re-lays out first, then the player follows
new ResizeObserver(() => requestAnimationFrame(placePlayer)).observe($('stage'));

async function togglePlay() {
  if (audio.paused || userPaused) {
    userPaused = false;
    shelf?.setSpinning(true);
    try {
      await audio.play();
      fadeTo(volume / 100);
    } catch {
      // the browser refused to start sound
    }
  } else {
    userPaused = true;
    shelf?.setSpinning(false);
    fadeTo(0, () => audio.pause());
  }
  paintPlayer();
}

// A timer, not requestAnimationFrame: frames stop in a background tab, and the sound must not.
function fadeTo(target: number, done?: () => void) {
  clearInterval(fade);
  const from = audio.volume, start = performance.now(), ms = 600;
  fade = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / ms);
    audio.volume = from + (target - from) * t;
    if (t < 1) return;
    clearInterval(fade);
    done?.();
  }, 30);
}

async function syncAudio() {
  const file = shelf?.pickedEntry?.current?.track.localFile;
  showPlayer(!!(shelf?.recordOut && file));
  if (!shelf?.recordOut || !file) {
    // the record went back: the next time it comes out, it plays again
    userPaused = false;
    shelf?.setSpinning(true);
    if (!audio.paused) fadeTo(0, () => audio.pause());
    return;
  }
  if (audioFor !== file) {
    const blob = await getBlob(file);
    if (!blob) return;
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(blob);
    audioFor = file;
    audio.volume = 0;
  }
  if (userPaused) return;
  try {
    await audio.play();
    fadeTo(volume / 100);
  } catch {
    // the browser refused to start sound; the record still turns
  }
}

const present = (...nodes: (Node | null)[]) => nodes.filter((n): n is Node => n !== null);

const trackLine = (e: ShelfEntry) => {
  const t = e.current!.track;
  return t.artist ? `${t.artist} — ${t.title}` : t.title;
};

function syncActions() {
  const e = shelf?.pickedEntry;
  if (!shelf || !e) return;
  // round icon buttons (design system: Button, round): the name shows on hover and is read aloud
  const iconButton = (name: 'swap' | 'plus' | 'trash', label: string, run: () => void) => {
    const b = h('button', { type: 'button', class: 's-btn s-btn--round', 'aria-label': label, title: label, onclick: () => run() });
    b.append(icon(name));
    return b;
  };
  const bar = $('actions');
  const out = shelf.recordOut;
  // Turning, the record and going back to the shelf are gestures (drag the sleeve, pull its right
  // half, tap beside it or Esc); only what has no gesture stays here, as icons under the caption.
  bar.replaceChildren(
    ...present(
      out && e.current?.track.sourceUrl ? listenLink(e) : null,
      e.current
        ? iconButton('swap', 'Сменить песню', () => changeSong(e))
        : iconButton('plus', 'Добавить песню', () => changeSong(e)),
      // irreversible: last, and asks first
      iconButton('trash', 'Удалить', () => void removeBottle(e)),
    ),
  );
  bar.hidden = false;
  void syncAudio();
}

// A song with a link can also be opened where it lives.
function listenLink(e: ShelfEntry) {
  const a = h('a', { class: 's-btn', href: e.current!.track.sourceUrl, target: '_blank', rel: 'noopener' }, 'Слушать');
  a.append(icon('external'));
  return a;
}

async function removeBottle(e: ShelfEntry) {
  const ok = await confirmDialog({
    title: `Удалить «${e.bottle.name}»?`,
    text: 'Флакон и вся история его песен исчезнут с полки насовсем.',
    confirm: 'Удалить',
  });
  if (!ok || shelf?.pickedEntry?.bottle.id !== e.bottle.id) return;
  await shelf.discardPicked();
  await deleteBottle(e.bottle.id);
  await refresh();
}

function changeSong(e: ShelfEntry) {
  openAddFlow({ kind: 'song', entry: e }, () => void refresh());
}

function addBottle() {
  shelf?.putBack();
  openAddFlow({ kind: 'new' }, () => void refresh());
}

$('add').addEventListener('click', addBottle);
$('empty-add').addEventListener('click', addBottle);
// The keyboard's way to the gestures: Esc puts the sleeve back, Space brings the record out or in
// (unless Space is pressing a focused button or typing in a field).
addEventListener('keydown', (e) => {
  if (document.querySelector('.overlay')) return;
  if (e.key === 'Escape') shelf?.putBack();
  const onControl = e.target instanceof HTMLElement && e.target.closest('button, a, input, textarea');
  // arrows page between shelves, like a scroll: the first leans, the second goes
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !shelf?.pickedEntry && !onControl) {
    e.preventDefault();
    shelf?.nudge(e.key === 'ArrowRight' ? 1 : -1);
  }
  if (e.key === ' ' && shelf?.pickedEntry?.current && !onControl) {
    e.preventDefault();
    // with the player shown, Space is play / pause (design system: Player); otherwise the record
    if (!dock.hidden) void togglePlay();
    else {
      shelf.toggleRecord();
      syncActions();
    }
  }
});

$('empty-title').replaceChildren(...revealWords('Полка ждёт первый флакон'));
await refresh();
tearAll();
