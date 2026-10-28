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

// ---------- the shelf ----------
try {
  shelf = new Shelf($('stage'), { onPick: showHeld, onPutBack: hideHeld, onChange: syncActions });
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

// On water in a cover's colours, the caption and the words take the light or the dark ink,
// whichever reads better there; on the theme's water they follow the theme.
function setTextTone(tone: 'light' | 'dark' | null) {
  for (const el of [$('caption'), $('actions')]) {
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
  if (!shelf?.recordOut || !file) {
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
  try {
    await audio.play();
    fadeTo(1);
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
  const word = (text: string, run: () => void, cls = '') =>
    h('button', { type: 'button', class: `s-btn ${cls}`.trim(), onclick: () => (run(), syncActions()) }, text);
  const bar = $('actions');
  const out = shelf.recordOut;
  // Turning, the record and going back to the shelf are gestures (drag the sleeve, pull its right
  // half, tap beside it or Esc); only what has no gesture stays a word here.
  bar.replaceChildren(
    ...present(
      out && e.current?.track.sourceUrl ? listenLink(e) : null,
      word(e.current ? 'Сменить песню' : 'Добавить песню', () => changeSong(e)),
      // irreversible: last, and asks first
      word('Удалить', () => void removeBottle(e)),
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
  if (e.key === ' ' && shelf?.pickedEntry?.current && !onControl) {
    e.preventDefault();
    shelf.toggleRecord();
    syncActions();
  }
});

$('empty-title').replaceChildren(...revealWords('Полка ждёт первый флакон'));
await refresh();
tearAll();
