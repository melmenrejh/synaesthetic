// Link parsing for the shelf. Browsers cannot read other sites' pages (CORS), so this
// small handler fetches them on the server side. It uses only the standard fetch API,
// so the same code runs in the Vite dev server (Node) and in a Cloudflare Worker.
//
//   /api/og?url=…     og:title / og:image / og:site_name of any page (bottle links)
//   /api/track?url=…  track metadata: official oEmbed where a platform has one, og-tags otherwise
//   /api/img?url=…    an image passed through, so the app can store it and use it in WebGL
//
// The server introduces itself honestly. Sites that turn such requests away (anti-bot pages)
// simply yield nothing, and the form falls back to manual fields.

export interface OgResult {
  url: string;
  title?: string;
  image?: string;
  siteName?: string;
  description?: string;
  error?: string;
}

export interface TrackResult {
  url: string;
  title?: string;
  artist?: string;
  artwork?: string;
  links: Record<string, string>;
  error?: string;
}

const UA = 'synaesthetic-link-preview/0.1';
const TIMEOUT = 8000;
const MAX_HTML = 2_000_000;
const MAX_IMAGE = 12_000_000;

export async function handleApi(req: Request): Promise<Response | null> {
  const u = new URL(req.url);
  if (!u.pathname.startsWith('/api/')) return null;
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
  const raw = u.searchParams.get('url') ?? '';
  const target = safeUrl(raw);
  switch (u.pathname) {
    case '/api/og':
      return json(target ? await og(target) : { url: raw, error: 'bad-url' });
    case '/api/track':
      return json(target ? await track(target) : { url: raw, links: {}, error: 'bad-url' });
    case '/api/img':
      return target ? image(target) : new Response('bad url', { status: 400, headers: cors() });
  }
  return new Response('not found', { status: 404, headers: cors() });
}

// Only public http(s) addresses: the proxy must not become a way into the local network.
export function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const h = u.hostname.toLowerCase();
    if (
      h === 'localhost' ||
      h.startsWith('[') ||
      h.endsWith('.local') ||
      h.endsWith('.internal') ||
      h.endsWith('.localhost') ||
      /^(0|10|127)\./.test(h) ||
      /^169\.254\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      !h.includes('.')
    )
      return null;
    return u;
  } catch {
    return null;
  }
}

async function og(url: URL): Promise<OgResult> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'ru,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) return { url: url.href, error: `http-${r.status}` };
    const html = (await r.text()).slice(0, MAX_HTML);
    const meta = parseMeta(html);
    // No <title> fallback: anti-bot and app-shell pages have a <title> too, and it is never the product.
    const image = meta['og:image'] ?? meta['og:image:url'] ?? meta['og:image:secure_url'] ?? meta['twitter:image'];
    return {
      url: r.url || url.href,
      title: clean(meta['og:title'] ?? meta['twitter:title']),
      image: image ? resolve(image, r.url || url.href) : undefined,
      siteName: clean(meta['og:site_name']),
      description: clean(meta['og:description'] ?? meta['description']),
    };
  } catch (e) {
    return { url: url.href, error: e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'fetch-failed' };
  }
}

// Platforms with an official oEmbed endpoint. Odesli (song.link) closed its public API in 2026,
// so finding the same track on other platforms waits for an API key or a later step.
const OEMBED: { platform: string; hosts: RegExp; endpoint: string }[] = [
  { platform: 'spotify', hosts: /(^|\.)spotify\.com$/, endpoint: 'https://open.spotify.com/oembed?url=' },
  {
    platform: 'youtube',
    hosts: /(^|\.)(youtube\.com|youtu\.be)$/,
    endpoint: 'https://www.youtube.com/oembed?format=json&url=',
  },
  { platform: 'soundcloud', hosts: /(^|\.)soundcloud\.com$/, endpoint: 'https://soundcloud.com/oembed?format=json&url=' },
];

const PLATFORMS: [string, RegExp][] = [
  ['yandex', /(^|\.)music\.yandex\.(ru|com|by|kz)$/],
  ['vk', /(^|\.)(vk\.com|vk\.ru|music\.vk\.com)$/],
  ['apple', /(^|\.)music\.apple\.com$/],
  ['spotify', /(^|\.)spotify\.com$/],
  ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/],
  ['soundcloud', /(^|\.)soundcloud\.com$/],
  ['bandcamp', /(^|\.)bandcamp\.com$/],
];

export const platformOf = (url: URL) => PLATFORMS.find(([, re]) => re.test(url.hostname))?.[0] ?? 'web';

async function track(url: URL): Promise<TrackResult> {
  const links = { [platformOf(url)]: url.href };
  const oembed = OEMBED.find((o) => o.hosts.test(url.hostname));
  if (oembed) {
    try {
      const r = await fetch(oembed.endpoint + encodeURIComponent(url.href), { signal: AbortSignal.timeout(TIMEOUT) });
      if (r.ok) {
        const data = (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
        if (data.title) {
          // Spotify's oEmbed has no artist; YouTube's author is the channel, usually the artist.
          const artist = oembed.platform === 'spotify' ? undefined : data.author_name?.replace(/\s*-\s*Topic$/, '');
          return { url: url.href, title: clean(data.title), artist: clean(artist), artwork: data.thumbnail_url, links };
        }
      }
    } catch {
      // fall through to og-tags
    }
  }
  const page = await og(url);
  return { url: url.href, title: page.title, artwork: page.image, links, error: page.error };
}

async function image(url: URL): Promise<Response> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const type = r.headers.get('content-type') ?? '';
    if (!r.ok || !type.startsWith('image/')) return new Response('not an image', { status: 422, headers: cors() });
    const body = await r.arrayBuffer();
    if (body.byteLength > MAX_IMAGE) return new Response('too large', { status: 413, headers: cors() });
    return new Response(body, { headers: { ...cors(), 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
  } catch {
    return new Response('fetch failed', { status: 502, headers: cors() });
  }
}

export function parseMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? attr(tag, 'itemprop'))?.toLowerCase();
    const content = attr(tag, 'content');
    if (key && content !== undefined && !(key in meta)) meta[key] = decode(content);
  }
  return meta;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const clean = (s?: string) => s?.replace(/\s+/g, ' ').trim() || undefined;

function resolve(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { ...cors(), 'Content-Type': 'application/json; charset=utf-8' } });

const cors = () => ({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
