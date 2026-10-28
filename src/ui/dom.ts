// A tiny element builder: the UI around the shelf is a handful of DOM nodes, no framework needed.

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

/** Splits a line into words that develop one after another (design system: «Проявление текста»). */
export function revealWords(text: string): HTMLElement[] {
  return text.split(' ').map((w, i) => {
    const s = h('span', { class: 'reveal-word' }, w);
    s.style.animationDelay = `calc(var(--duration-stagger) * ${i})`;
    return s;
  }).flatMap((s, i, all) => (i < all.length - 1 ? [s, document.createTextNode(' ')] : [s])) as HTMLElement[];
}

export const icons = {
  close:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
  external:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"><path d="M6 3.5h6.5V10M12.5 3.5l-9 9"/></svg>',
  // drawn to the design system's rule: a 16px square, 1px line, square ends
  /** Change the song: two arrows passing each other. */
  swap:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square" stroke-linejoin="miter"><path d="M2.5 5.5h10.5M10.5 3l2.5 2.5-2.5 2.5M13.5 10.5H3M5.5 8L3 10.5 5.5 13"/></svg>',
  /** Delete: a bin. */
  trash:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square" stroke-linejoin="miter"><path d="M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l.75 9h6.5l.75-9M6.5 7v4M9.5 7v4"/></svg>',
  /** Add a song: a plus. */
  plus:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="square"><path d="M8 3v10M3 8h10"/></svg>',
};

export function icon(name: keyof typeof icons): HTMLElement {
  const s = h('span', { 'aria-hidden': 'true', class: 'icon' });
  s.innerHTML = icons[name];
  return s;
}
