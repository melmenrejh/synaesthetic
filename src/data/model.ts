// The MVP data model (synaesthetic-perfumerie.md §2): a bottle is a permanent entity, a pairing ties
// it to one track for a period, and the periods of one bottle follow each other without gaps.

export type PhotoSource = 'camera' | 'upload' | 'link' | 'silhouette';

export interface Bottle {
  id: string;
  brand: string;
  name: string;
  /** Blob id of the bottle photo (stored downscaled). */
  photo?: string;
  /** Stored only; matters once public shelves exist. */
  photoSource: PhotoSource;
  sourceUrl?: string;
  /** Blob id of the photo with the background removed (PNG with alpha), when that worked. */
  cutout?: string;
  /** Up to three hex colours taken from the photo. */
  palette: string[];
  /** Local date and time it was added (see `now`); orders the shelf. */
  addedAt: string;
}

export interface Pairing {
  id: string;
  bottleId: string;
  trackId: string;
  /** Blob id of the person's own cover; without it the track artwork is the cover. */
  coverImage?: string;
  /** Local date and time the song was put on (no back-dating; see `now`). */
  from: string;
  /** Absent for the current pairing. */
  to?: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  /** Blob id of the artwork. */
  artwork?: string;
  sourceUrl: string;
  platformLinks: Record<string, string>;
  /** Blob id of an uploaded audio file: the later "upgrade". */
  localFile?: string;
}

/** One bottle with its track history, as the shelf shows it. */
export interface ShelfEntry {
  bottle: Bottle;
  /** Oldest first. */
  history: { pairing: Pairing; track: Track }[];
  current?: { pairing: Pairing; track: Track };
}

export const newId = () => crypto.randomUUID();

/**
 * Local date and time to the millisecond, 'YYYY-MM-DDTHH:mm:ss.sss'. Down to the millisecond so
 * that two bottles added on the same day still keep their order; screens show only the month.
 * (Records written before this were date-only; on the same day those sort before these.)
 */
export const now = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
};

/** '2024-03-01' → '03.2024' */
export const monthLabel = (iso: string) => `${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** '03.2024 — 02.2025' or 'с 02.2025' */
export const periodLabel = (p: Pairing) =>
  p.to ? `${monthLabel(p.from)} — ${monthLabel(p.to)}` : `с ${monthLabel(p.from)}`;

/** When the shelf last changed for this bottle: added, or a new song. Newest first on the shelf. */
export const lastChange = (e: ShelfEntry) =>
  e.current && e.current.pairing.from > e.bottle.addedAt ? e.current.pairing.from : e.bottle.addedAt;
