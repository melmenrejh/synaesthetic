// Client side of the link-parsing API (server/api.ts) plus the title clean-up that turns
// a page title into brand / name or artist / title.
import type { OgResult, TrackResult } from '../../server/api';

const API = import.meta.env.VITE_API_BASE ?? '';

export const looksLikeUrl = (s: string) => /^https?:\/\/\S+\.\S+/i.test(s.trim());

export async function fetchOg(url: string): Promise<OgResult> {
  try {
    return await (await fetch(`${API}/api/og?url=${encodeURIComponent(url)}`)).json();
  } catch {
    return { url, error: 'offline' };
  }
}

export async function fetchTrack(url: string): Promise<TrackResult> {
  try {
    return await (await fetch(`${API}/api/track?url=${encodeURIComponent(url)}`)).json();
  } catch {
    return { url, links: {}, error: 'offline' };
  }
}

export async function fetchImage(url: string): Promise<Blob | null> {
  try {
    const r = await fetch(`${API}/api/img?url=${encodeURIComponent(url)}`);
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

const NOISE = [
  /\s+(купить|цена|отзывы|описание|в интернет-магазине)\b.*$/i,
  /\s+for (women and men|women|men)\b.*$/i,
  /\s+(для женщин и мужчин|для женщин|для мужчин)\b.*$/i,
  /\s+(eau de parfum|eau de toilette|eau de cologne|extrait de parfum|parfum|парфюмерная вода|туалетная вода|духи|edp|edt)\b.*$/i,
];

/**
 * Splits a shop or catalogue page title into brand and name. Generic on purpose (no per-site
 * parsers): strips the site name and shop words, then looks for the brand given by the URL.
 */
export function splitBottleTitle(title: string, siteName?: string, url?: string): { brand?: string; name?: string } {
  let t = title;
  if (siteName) t = t.replace(new RegExp(`\\s*[|·—–-]\\s*${escape(siteName)}\\s*$`, 'i'), '');
  t = t.replace(/\s*[|]\s*.*$/, '');
  for (const re of NOISE) t = t.replace(re, '');
  t = t.trim();
  const fromUrl = url ? guessFromUrl(url) : {};
  if (fromUrl.brand) {
    const i = t.toLowerCase().indexOf(fromUrl.brand.toLowerCase());
    if (i >= 0) {
      const brand = t.slice(i, i + fromUrl.brand.length);
      const name = (t.slice(0, i) + t.slice(i + fromUrl.brand.length)).replace(/^\s*[-—–:]\s*|\s*[-—–:]\s*$/g, '').trim();
      return { brand, name: name || undefined };
    }
  }
  const by = /^(.+?)\s+by\s+(.+)$/i.exec(t);
  if (by) return { name: by[1], brand: by[2] };
  return { name: t || undefined };
}

const STOP = new Set(['perfume', 'perfumes', 'product', 'products', 'p', 'catalog', 'catalogue', 'shop', 'item', 'ru', 'en', 'parfum', 'brand', 'brands']);

/**
 * Last-resort guess from the address itself: /perfume/Dolce-Gabbana/Light-Blue-485.html gives
 * name "Light Blue" and brand "Dolce Gabbana". Used when the site does not answer the server.
 */
export function guessFromUrl(url: string): { brand?: string; name?: string } {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const words = (s: string) =>
      s
        .replace(/\.(html?|php|aspx?)$/i, '')
        .replace(/[-_]?\d{3,}$/, '')
        .replace(/^\d+[-_]/, '')
        .replace(/[-_+]+/g, ' ')
        .trim();
    const last = parts.length ? words(parts[parts.length - 1]) : '';
    const prev = parts.length > 1 ? parts[parts.length - 2] : '';
    const brand = prev && !STOP.has(prev.toLowerCase()) && !/\d/.test(prev) ? words(prev) : undefined;
    // an id such as "4uLU6hMCjMI75M1A2tKUQC" is not a name
    const isId = !last.includes(' ') && /\d/.test(last) && /[a-zа-я]/i.test(last);
    return { name: /[a-zа-я]/i.test(last) && !isId ? last : undefined, brand: brand && !isId ? brand : undefined };
  } catch {
    return {};
  }
}

/** "Artist - Title" (YouTube style) → parts, if the artist is known to be in front. */
export function splitTrackTitle(title: string, artist?: string): { artist?: string; title: string } {
  let t = title.replace(/\s*\((official|lyric|music)[^)]*\)|\s*\[(official|lyric|music)[^\]]*\]/gi, '').trim();
  if (artist) {
    const re = new RegExp(`^${escape(artist)}\\s*[-—–]\\s*`, 'i');
    if (re.test(t)) t = t.replace(re, '');
    return { artist, title: t };
  }
  const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(t);
  return m ? { artist: m[1], title: m[2] } : { title: t };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
