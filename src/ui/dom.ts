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
};

export function icon(name: keyof typeof icons): HTMLElement {
  const s = h('span', { 'aria-hidden': 'true', class: 'icon' });
  s.innerHTML = icons[name];
  return s;
}
