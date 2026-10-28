// Canvas drawings for one sleeve: front (cover), back (track history), the bottle sticker and
// the record. Sizes are parameters so the shelf uses small textures and the sleeve in hand
// a large one (§7 of the MVP doc: video memory is the main risk).
import { periodLabel, type ShelfEntry } from '../data/model';

export interface SleeveImages {
  cover?: ImageBitmap | null;
  photo?: ImageBitmap | null;
  cutout?: ImageBitmap | null;
}

const SERIF = 'Prata, Georgia, serif';
const MONO = '"IBM Plex Mono", "Courier New", monospace';
// Print colours: sleeves are physical paper, so they keep these in both themes.
const PRINT_INK = '#1f1e21';
const PRINT_MUTED = '#5f5d63';
const PRINT_PAPER = '#ecebe8';
const SLIP = '#fbfbfa';
const ORCHID = '#7c53aa';
/** The sleeve of a bottle without a song yet: plain board. Kept cool and grey, as the palette asks. */
export const KRAFT = '#b9b2a6';

function canvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function mix(a: string, b: string, t: number) {
  const pa = rgb(a), pb = rgb(b);
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
}
function rgb(h: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  const n = m ? parseInt(m[1], 16) : 0x8f8a94;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Paper grain: deterministic per sleeve, so a redraw at another size looks the same. */
function grain(x: CanvasRenderingContext2D, seed: string, amount: number, alpha: number) {
  const r = rng(seed);
  const W = x.canvas.width, H = x.canvas.height, s = Math.max(1, W / 512);
  for (let i = 0; i < amount * (W / 1024) ** 2; i++) {
    x.fillStyle = r() < 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
    x.fillRect(r() * W, r() * H, 2 * s, 2 * s);
  }
}

export function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function coverFit(x: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, S: number) {
  const k = Math.max(S / img.width, S / img.height);
  const w = img.width * k, h = img.height * k;
  x.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
}

function wrap(x: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (x.measureText(next).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

export function frontCanvas(e: ShelfEntry, img: SleeveImages, S: number) {
  const c = canvas(S);
  const x = c.getContext('2d')!;
  const u = S / 1024;
  const palette = e.bottle.palette;

  if (!e.current) {
    // An unfinished chain: an empty sleeve with the ring a record has left on the board.
    x.fillStyle = KRAFT;
    x.fillRect(0, 0, S, S);
    grain(x, e.bottle.id, 26000, 0.05);
    x.strokeStyle = 'rgba(40,36,44,.10)';
    x.lineWidth = 44 * u;
    x.beginPath();
    x.arc(S / 2, S / 2, 400 * u, 0, Math.PI * 2);
    x.stroke();
    x.fillStyle = 'rgba(40,36,44,.18)';
    x.beginPath();
    x.arc(S / 2, S / 2, 60 * u, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = 'rgba(31,30,33,.7)';
    x.font = `500 ${22 * u}px ${MONO}`;
    x.letterSpacing = `${0.08 * 22 * u}px`;
    x.fillText('ПЕСНЯ ЕЩЁ НЕ НАШЛАСЬ', 72 * u, 112 * u);
    x.letterSpacing = '0px';
    return c;
  }

  if (img.cover) {
    coverFit(x, img.cover, S);
    grain(x, e.bottle.id, 14000, 0.035);
    return c;
  }

  // A song without any picture: a quiet typographic cover in the bottle's colours.
  const base = mix(palette[0], '#131214', 0.55);
  x.fillStyle = base;
  x.fillRect(0, 0, S, S);
  x.fillStyle = mix(palette[1] ?? palette[0], '#ffffff', 0.12);
  x.globalAlpha = 0.85;
  x.beginPath();
  x.arc(640 * u, 390 * u, 280 * u, 0, Math.PI * 2);
  x.fill();
  x.globalAlpha = 1;
  grain(x, e.bottle.id, 30000, 0.045);
  const { track } = e.current;
  x.fillStyle = 'rgba(251,251,250,.92)';
  x.font = `${64 * u}px ${SERIF}`;
  // title anchored to the bottom edge, artist above its first line
  const lines = wrap(x, track.title, 880 * u, 2);
  const top = 940 - (lines.length - 1) * 72;
  lines.forEach((l, i) => x.fillText(l, 68 * u, (top + i * 72) * u));
  x.font = `500 ${24 * u}px ${MONO}`;
  x.letterSpacing = `${0.08 * 24 * u}px`;
  x.fillText((track.artist || '').toUpperCase(), 72 * u, (top - 84) * u, 880 * u);
  x.letterSpacing = '0px';
  return c;
}

export function backCanvas(e: ShelfEntry, S: number) {
  const c = canvas(S);
  const x = c.getContext('2d')!;
  const u = S / 1024;
  x.fillStyle = PRINT_PAPER;
  x.fillRect(0, 0, S, S);
  grain(x, e.bottle.id + 'b', 18000, 0.03);

  const label = (text: string, px: number, y: number, color = PRINT_MUTED) => {
    x.fillStyle = color;
    x.font = `500 ${px * u}px ${MONO}`;
    x.letterSpacing = `${0.08 * px * u}px`;
    x.fillText(text.toUpperCase(), 80 * u, y * u, 864 * u);
    x.letterSpacing = '0px';
  };

  label(e.bottle.brand || '—', 24, 120);
  x.fillStyle = PRINT_INK;
  x.font = `${64 * u}px ${SERIF}`;
  x.fillText(e.bottle.name, 76 * u, 196 * u, 868 * u);
  x.fillStyle = 'rgba(31,30,33,.25)';
  x.fillRect(80 * u, 244 * u, 864 * u, Math.max(1, 2 * u));

  if (!e.history.length) {
    x.fillStyle = PRINT_MUTED;
    x.font = `${34 * u}px ${MONO}`;
    ['Песни пока нет.', 'Когда найдёшь её, в конверте', 'появится пластинка.'].forEach((l, i) =>
      x.fillText(l, 80 * u, (330 + i * 52) * u),
    );
  } else {
    // newest on top; a long history keeps its latest rows
    const rows = [...e.history].reverse().slice(0, 6);
    // each row: the song in Prata, its period underneath (the current one in orchid)
    rows.forEach(({ pairing, track }, i) => {
      const y = 324 + i * 112;
      x.fillStyle = PRINT_INK;
      x.font = `${38 * u}px ${SERIF}`;
      const line = track.artist ? `${track.artist} — ${track.title}` : track.title;
      x.fillText(line, 78 * u, y * u, 864 * u);
      x.fillStyle = pairing.to ? PRINT_MUTED : ORCHID;
      x.font = `400 ${22 * u}px ${MONO}`;
      x.fillText(periodLabel(pairing), 80 * u, (y + 40) * u);
    });
  }
  return c;
}

/** World size of the sticker plane plus its picture. */
export interface Sticker {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  polaroid: boolean;
}

/**
 * The bottle on the cover: a die-cut sticker with a white border when the background could be
 * removed, a polaroid when it could not, and nothing at all when there is no photo.
 */
export function stickerCanvas(e: ShelfEntry, img: SleeveImages, S: number): Sticker | null {
  const u = S / 1024;
  if (img.cutout) {
    const k = (720 * u) / Math.max(img.cutout.width, img.cutout.height);
    const w = img.cutout.width * k, h = img.cutout.height * k, b = 18 * u;
    const c = canvas(Math.ceil(w + b * 2 + 4), Math.ceil(h + b * 2 + 4));
    const x = c.getContext('2d')!;
    // white border: the silhouette stamped around in a circle, then whitened
    const sil = canvas(c.width, c.height);
    const sx = sil.getContext('2d')!;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      sx.drawImage(img.cutout, b + 2 + Math.cos(a) * b, b + 2 + Math.sin(a) * b, w, h);
    }
    sx.globalCompositeOperation = 'source-in';
    sx.fillStyle = SLIP;
    sx.fillRect(0, 0, c.width, c.height);
    x.drawImage(sil, 0, 0);
    x.drawImage(img.cutout, b + 2, b + 2, w, h);
    const H = 1.2;
    return { canvas: c, w: (H * c.width) / c.height, h: H, polaroid: false };
  }
  if (img.photo) {
    const c = canvas(Math.round(600 * u), Math.round(720 * u));
    const x = c.getContext('2d')!;
    x.fillStyle = SLIP;
    x.fillRect(0, 0, c.width, c.height);
    x.save();
    x.beginPath();
    x.rect(30 * u, 30 * u, 540 * u, 540 * u);
    x.clip();
    x.translate(30 * u, 30 * u);
    coverFit(x, img.photo, 540 * u);
    x.restore();
    x.fillStyle = PRINT_INK;
    x.font = `400 ${34 * u}px ${MONO}`;
    x.textAlign = 'center';
    x.fillText(e.bottle.name, 300 * u, 652 * u, 540 * u);
    return { canvas: c, w: 0.92, h: 1.1, polaroid: true };
  }
  return null;
}

/** The record model's colour texture and where its labels lie on it (see shelf/record.ts). */
export interface RecordSkin {
  image: CanvasImageSource;
  /**
   * Label centres and radii as shares of the texture's side; `rot` turns our label to read upright,
   * `mirror` flips it for a model whose UVs show the texture mirrored.
   */
  labels: { u: number; v: number; r: number; rot: number; mirror: boolean }[];
}

/**
 * The record's colour texture. With the record model: its own texture (grooves, rim, sheen live in
 * its maps), with our label laid over each of its labels. Without it: a drawn black disc.
 */
export function vinylCanvas(e: ShelfEntry, S: number, skin?: RecordSkin) {
  const c = canvas(S);
  const x = c.getContext('2d')!;
  if (skin) {
    x.drawImage(skin.image, 0, 0, S, S);
    for (const l of skin.labels) drawLabel(x, e, l.u * S, l.v * S, l.r * S, l.rot, l.mirror);
    return c;
  }
  const u = S / 1024, m = S / 2;
  x.fillStyle = '#0e0d10';
  x.fillRect(0, 0, S, S);
  for (let r = 500; r > 175; r -= 3) {
    x.strokeStyle = `rgba(255,255,255,${r % 9 === 0 ? 0.07 : 0.025})`;
    x.lineWidth = Math.max(1, u);
    x.beginPath();
    x.arc(m, m, r * u, 0, Math.PI * 2);
    x.stroke();
  }
  drawLabel(x, e, m, m, 170 * u, 0, false);
  return c;
}

/**
 * The label ("яблоко"): the bottle's colour (§3: "Цвет винила или яблока в центре — из палитры
 * аромата"), the artist in mono capitals above the hole, the title in Prata below it.
 */
function drawLabel(
  x: CanvasRenderingContext2D,
  e: ShelfEntry,
  cx: number,
  cy: number,
  R: number,
  rot: number,
  mirror: boolean,
) {
  x.save();
  x.translate(cx, cy);
  x.rotate(rot);
  if (mirror) x.scale(-1, 1);
  x.beginPath();
  x.arc(0, 0, R, 0, Math.PI * 2);
  x.clip();
  x.fillStyle = mix(e.bottle.palette[0], '#000000', 0.1);
  x.fillRect(-R, -R, 2 * R, 2 * R);
  const t = e.current?.track;
  x.fillStyle = 'rgba(251,251,250,.92)';
  x.textAlign = 'center';
  x.font = `500 ${0.118 * R}px ${MONO}`;
  x.fillText((t?.artist ?? '').toUpperCase(), 0, -0.353 * R, 1.65 * R);
  x.font = `${0.176 * R}px ${SERIF}`;
  x.fillText(t?.title ?? '', 0, 0.518 * R, 1.7 * R);
  x.fillStyle = '#0e0d10';
  x.beginPath();
  x.arc(0, 0, 0.082 * R, 0, Math.PI * 2);
  x.fill();
  x.restore();
}
