// Photo handling for bottles: downscale for storage, cut a white shop background away for the
// sticker, and take a small palette. Everything runs in the browser on a canvas.

const FALLBACK_PALETTE = ['#8f8a94', '#5f5d63', '#d6d5d6'];

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const bitmapCache = new Map<string, Promise<ImageBitmap | null>>();

/** Decodes a stored blob once and keeps the bitmap for the session. */
export function bitmapOf(id: string, load: (id: string) => Promise<Blob | undefined>): Promise<ImageBitmap | null> {
  let p = bitmapCache.get(id);
  if (!p) {
    p = load(id).then((b) => (b ? createImageBitmap(b) : null)).catch(() => null);
    bitmapCache.set(id, p);
  }
  return p;
}

function fit(bmp: ImageBitmap, max: number) {
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = canvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

const toBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));

/** Downscales a picture for storage (photos from phones are 10+ MB). */
export async function prepareImage(blob: Blob, max = 1600): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  return toBlob(fit(bmp, max), 'image/webp', 0.88);
}

/**
 * Removes a plain light background (shop photos are shot on white): flood fill from the border
 * through near-white pixels. Returns a cropped PNG with alpha, or null when the photo does not
 * look like an object on white; the sticker then becomes a polaroid.
 */
export async function cutout(blob: Blob): Promise<Blob | null> {
  const bmp = await createImageBitmap(blob);
  const c = fit(bmp, 640);
  const { width: w, height: h } = c;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  const img = x.getImageData(0, 0, w, h);
  const px = img.data;
  const light = (i: number) => {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    return px[i * 4 + 3] < 16 || (Math.min(r, g, b) > 226 && Math.max(r, g, b) - Math.min(r, g, b) < 22);
  };

  const border: number[] = [];
  for (let i = 0; i < w; i++) border.push(i, (h - 1) * w + i);
  for (let j = 1; j < h - 1; j++) border.push(j * w, j * w + w - 1);
  if (border.filter(light).length / border.length < 0.85) return null;

  const bg = new Uint8Array(w * h);
  const stack = border.filter(light);
  for (const i of stack) bg[i] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const cx = i % w, cy = (i / w) | 0;
    for (const n of [cx > 0 ? i - 1 : -1, cx < w - 1 ? i + 1 : -1, cy > 0 ? i - w : -1, cy < h - 1 ? i + w : -1]) {
      if (n >= 0 && !bg[n] && light(n)) {
        bg[n] = 1;
        stack.push(n);
      }
    }
  }
  let count = 0;
  for (let i = 0; i < bg.length; i++) count += bg[i];
  const share = count / bg.length;
  if (share < 0.12 || share > 0.95) return null;

  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (bg[k]) {
        px[k * 4 + 3] = 0;
        continue;
      }
      // soften the edge: a pixel touching the background is half transparent
      const edge = (i > 0 && bg[k - 1]) || (i < w - 1 && bg[k + 1]) || (j > 0 && bg[k - w]) || (j < h - 1 && bg[k + w]);
      if (edge) px[k * 4 + 3] = 150;
      if (i < x0) x0 = i;
      if (i > x1) x1 = i;
      if (j < y0) y0 = j;
      if (j > y1) y1 = j;
    }
  x.putImageData(img, 0, 0);
  const pad = 2;
  const cw = x1 - x0 + 1 + pad * 2, ch = y1 - y0 + 1 + pad * 2;
  const out = canvas(cw, ch);
  out.getContext('2d')!.drawImage(c, x0 - pad, y0 - pad, cw, ch, 0, 0, cw, ch);
  return toBlob(out, 'image/png');
}

/** Three colours that carry the photo: frequent and saturated beat frequent and grey. */
export async function paletteOf(blob: Blob): Promise<string[]> {
  const bmp = await createImageBitmap(blob);
  const c = fit(bmp, 48);
  const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (px[i + 3] < 128) continue;
    if (Math.min(r, g, b) > 226 || Math.max(r, g, b) < 24) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    buckets.set(key, e);
  }
  const colours = [...buckets.values()]
    .map((e) => {
      const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
      const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      return { hex: hex(r, g, b), score: e.n * (0.4 + sat) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => c.hex);
  return colours.length ? [...colours, ...FALLBACK_PALETTE].slice(0, 3) : FALLBACK_PALETTE;
}

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
