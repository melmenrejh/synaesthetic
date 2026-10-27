// Title, artist and cover from an audio file's ID3v2 tag (MP3), so a file from the device fills the
// form like a link does. Other formats fall back to the file name ("Artist - Title.m4a").

export interface AudioTags {
  title?: string;
  artist?: string;
  picture?: Blob;
}

export const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i;

export const isAudio = (f: File) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);

export async function readTags(file: File): Promise<AudioTags> {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {}; // "ID3"
    const major = head[3];
    if (major < 3 || major > 4) return {};
    const flags = head[5];
    const size = syncsafe(head, 6);
    const tag = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    let p = 0;
    if (flags & 0x40) p += major === 4 ? syncsafe(tag, 0) : 4 + u32(tag, 0); // extended header
    const out: AudioTags = {};
    while (p + 10 <= tag.length && tag[p] !== 0) {
      const id = String.fromCharCode(tag[p], tag[p + 1], tag[p + 2], tag[p + 3]);
      const len = major === 4 ? syncsafe(tag, p + 4) : u32(tag, p + 4);
      const body = tag.subarray(p + 10, p + 10 + len);
      p += 10 + len;
      if (id === 'TIT2') out.title = text(body);
      else if (id === 'TPE1') out.artist = text(body);
      else if (id === 'APIC' && !out.picture) out.picture = picture(body);
    }
    return out;
  } catch {
    return {};
  }
}

/** "Massive Attack - Teardrop.mp3" → { artist, title } */
export function tagsFromName(name: string): AudioTags {
  const base = name.replace(AUDIO_EXT, '').replace(/^\d+[\s.\-_]+/, '').replace(/_/g, ' ').trim();
  const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(base);
  return m ? { artist: m[1], title: m[2] } : { title: base };
}

const syncsafe = (b: Uint8Array, i: number) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

const DECODERS = ['latin1', 'utf-16', 'utf-16be', 'utf-8'];

function text(body: Uint8Array): string | undefined {
  const s = new TextDecoder(DECODERS[body[0]] ?? 'utf-8').decode(body.subarray(1)).replace(/\0.*$/s, '').trim();
  return s || undefined;
}

function picture(body: Uint8Array): Blob | undefined {
  const enc = body[0];
  let i = 1;
  const mimeEnd = body.indexOf(0, i);
  const mime = new TextDecoder('latin1').decode(body.subarray(i, mimeEnd)) || 'image/jpeg';
  i = mimeEnd + 2; // terminator + picture type
  // description, terminated by one zero byte (two for UTF-16)
  if (enc === 1 || enc === 2) {
    while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2;
    i += 2;
  } else {
    while (i < body.length && body[i] !== 0) i++;
    i += 1;
  }
  const data = body.subarray(i);
  return data.length > 100 ? new Blob([data], { type: mime.includes('/') ? mime : `image/${mime.toLowerCase()}` }) : undefined;
}
