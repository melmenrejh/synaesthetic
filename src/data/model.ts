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
  addedAt: string;
}

export interface Pairing {
  id: string;
  bottleId: string;
  trackId: string;
  /** Blob id of the person's own cover; without it the track artwork is the cover. */
  coverImage?: string;
  /** ISO date, first day of a month: dates are entered to the month. */
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

/** 'YYYY-MM' of today. */
export const thisMonth = () => new Date().toISOString().slice(0, 7);

/** '2024-03-01' → '03.2024' */
export const monthLabel = (iso: string) => `${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** '03.2024 — 02.2025' or 'с 02.2025' */
export const periodLabel = (p: Pairing) =>
  p.to ? `${monthLabel(p.from)} — ${monthLabel(p.to)}` : `с ${monthLabel(p.from)}`;

/** When the shelf last changed for this bottle: added, or a new song. Newest first on the shelf. */
export const lastChange = (e: ShelfEntry) =>
  e.current && e.current.pairing.from > e.bottle.addedAt ? e.current.pairing.from : e.bottle.addedAt;
