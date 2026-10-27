// Adding a bottle (флакон → песня → обложка) and changing a bottle's song (песня → обложка).
// Built on the design system's Form, Input and Button: a window over the blurred shelf, one column,
// the result of a pasted link shown right under the field (MVP doc §4).
import { addBottle, findBottle, putBlob, setSong } from '../data/db';
import { monthLabel, thisMonth, type PhotoSource, type ShelfEntry } from '../data/model';
import { tearAll } from '../ds/tear';
import { cutout, paletteOf, prepareImage } from '../images/process';
import { fetchImage, fetchOg, fetchTrack, guessFromUrl, looksLikeUrl, splitBottleTitle, splitTrackTitle } from '../links/api';
import { h, icon } from './dom';

export type FlowMode = { kind: 'new' } | { kind: 'song'; entry: ShelfEntry };
type Step = 'bottle' | 'track' | 'cover';
type HintState = '' | 'found' | 'error';

const DEFAULT_PALETTE = ['#8f8a94', '#5f5d63', '#d6d5d6'];

interface Field {
  root: HTMLElement;
  input: HTMLInputElement;
  hint(text: string, state?: HintState): void;
  missing(on: boolean): void;
}

function field(o: { label: string; value: string; placeholder?: string; type?: string; onInput(v: string): void }): Field {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', { id, class: 's-input', type: o.type ?? 'text', placeholder: o.placeholder, autocomplete: 'off' });
  input.value = o.value;
  const hint = h('div', { class: 's-field__hint', 'aria-live': 'polite' });
  input.addEventListener('input', () => {
    input.classList.remove('is-missing', 'is-error');
    if (hint.classList.contains('is-error')) setHint('');
    o.onInput(input.value);
  });
  function setHint(text: string, state: HintState = '') {
    hint.textContent = text;
    hint.className = `s-field__hint${state ? ` is-${state}` : ''}`;
    input.classList.toggle('is-error', state === 'error');
  }
  return {
    root: h('div', { class: 's-field' }, h('label', { class: 's-field__label', for: id }, o.label), input, hint),
    input,
    hint: setHint,
    missing: (on) => input.classList.toggle('is-missing', on),
  };
}

const button = (text: string, onclick: () => void, cls = '') =>
  h('button', { type: 'button', class: `s-btn ${cls}`.trim(), onclick: () => onclick() }, text);

export function openAddFlow(mode: FlowMode, onSaved: (bottleId: string) => void) {
  const steps: Step[] = mode.kind === 'new' ? ['bottle', 'track', 'cover'] : ['track', 'cover'];
  let step: Step = steps[0];
  let dirty = false;
  let busy = false;

  const bottle = { link: '', brand: '', name: '', photo: undefined as Blob | undefined, photoSource: 'upload' as PhotoSource };
  const auto = { brand: false, name: false, title: false, artist: false };
  const track = { link: '', artist: '', title: '', artwork: undefined as Blob | undefined, links: {} as Record<string, string>, month: thisMonth() };
  const cover = { own: undefined as Blob | undefined, useOwn: false };
  const minMonth = mode.kind === 'song' ? mode.entry.current?.pairing.from.slice(0, 7) : undefined;
  // parts of the current step that are redrawn on their own
  let photoArea: HTMLElement;
  let photoHint: HTMLElement | undefined;
  let coverArea: HTMLElement;

  const title = mode.kind === 'new' ? 'Новый флакон' : 'Сменить песню';
  const body = h('div', { class: 's-window__body' });
  const win = h(
    'div',
    { class: 's-window flow', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 's-window__bar' }, h('span', { class: 's-window__title' }, title), closeButton()),
    body,
  );
  const overlay = h('div', { class: 'overlay' }, win);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) requestClose();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      requestClose();
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    if (step === 'bottle') setBottlePhoto(file, 'upload');
    else if (step === 'cover') setOwnCover(file);
  };
  addEventListener('keydown', onKey, true);
  addEventListener('paste', onPaste);
  document.body.append(overlay);
  render();

  function closeButton() {
    const b = h('button', { type: 'button', class: 's-btn s-btn--icon', 'aria-label': 'Закрыть', onclick: () => requestClose() });
    b.append(icon('close'));
    return b;
  }

  function close() {
    removeEventListener('keydown', onKey, true);
    removeEventListener('paste', onPaste);
    overlay.remove();
  }

  // Closing with typed data asks first, in place, like the design system's Popover confirm.
  function requestClose() {
    if (busy) return;
    if (!dirty) return close();
    const actions = body.querySelector('.s-form__actions');
    if (!actions || actions.classList.contains('is-confirm')) return;
    const saved = [...actions.childNodes];
    actions.classList.add('is-confirm');
    const stay = button('остаться', () => {
      actions.classList.remove('is-confirm');
      actions.replaceChildren(...saved);
    }, 's-btn--label s-btn--bracket');
    actions.replaceChildren(
      h('span', { class: 'ui' }, 'Закрыть? Введённое не сохранится.'),
      h('div', { class: 'row' }, button('закрыть', close, 's-btn--label s-btn--bracket'), stay),
    );
    stay.focus();
  }

  function stepsLine() {
    const names: Record<Step, string> = { bottle: 'флакон', track: 'песня', cover: 'обложка' };
    const line = h('div', { class: 's-form__steps' });
    steps.forEach((s, i) => {
      if (i) line.append(h('span', { 'aria-hidden': 'true' }, '→'));
      line.append(h('span', { class: s === step ? 'is-current' : '', 'aria-current': s === step ? 'step' : null }, `${i + 1} · ${names[s]}`));
    });
    return line;
  }

  function actions(left: HTMLElement[], primary: { text: string; run: () => void }) {
    const p = h('button', { type: 'button', class: 's-btn s-btn--primary', onclick: () => !busy && primary.run() }, primary.text);
    return h('div', { class: 's-form__actions' }, h('div', { class: 'row' }, ...left), p);
  }

  function render() {
    body.replaceChildren();
    const form = h('div', { class: 's-form' }, stepsLine());
    body.append(form);
    if (step === 'bottle') renderBottle(form);
    else if (step === 'track') renderTrack(form);
    else renderCover(form);
    tearAll(body);
    const first = body.querySelector<HTMLInputElement>('input.s-input');
    (first ?? body.querySelector<HTMLElement>('.s-btn--primary'))?.focus({ preventScroll: true });
  }

  function go(s: Step) {
    step = s;
    render();
  }

  // ---------- step 1: bottle ----------

  function renderBottle(form: HTMLElement) {
    let token = 0;
    const link = field({
      label: 'Ссылка · по желанию',
      value: bottle.link,
      placeholder: 'Страница аромата в магазине или каталоге',
      onInput: (v) => {
        bottle.link = v.trim();
        dirty = true;
        clearTimeout(timer);
        timer = setTimeout(() => parse(), 350);
      },
    });
    let timer: ReturnType<typeof setTimeout>;
    link.hint('бренд, название и фото подтянутся сами');
    const brand = field({ label: 'Бренд', value: bottle.brand, placeholder: 'Например, Diptyque', onInput: (v) => ((bottle.brand = v), (auto.brand = false), (dirty = true)) });
    const name = field({ label: 'Название', value: bottle.name, placeholder: 'Например, Philosykos', onInput: (v) => ((bottle.name = v), (auto.name = false), (dirty = true)) });

    const photoNote = (photoHint = h('div', { class: 's-field__hint' }));
    photoArea = h('div', { class: 's-drop' });
    const photo = h('div', { class: 's-field' }, h('span', { class: 's-field__label' }, 'Фото флакона · по желанию'), photoArea, photoNote);
    drawPhotoArea();
    dropTarget(photoArea, (blob, source) => setBottlePhoto(blob, source));

    form.append(link.root, h('div', { class: 's-form__row' }, brand.root, name.root), photo);
    form.append(
      actions([button('Отмена', requestClose)], {
        text: 'Дальше: песня',
        run: async () => {
          if (!bottle.name.trim()) {
            name.hint('без названия флакон не поставить', 'error');
            return name.input.focus();
          }
          if (await findBottle(bottle.brand, bottle.name)) {
            name.hint('этот флакон уже стоит на полке', 'error');
            return name.input.focus();
          }
          go('track');
        },
      }),
    );

    async function parse() {
      const url = bottle.link;
      const my = ++token;
      if (!url) return link.hint('бренд, название и фото подтянутся сами');
      if (!looksLikeUrl(url)) return link.hint('это не похоже на ссылку — она начинается с https://', 'error');
      link.hint('ищу…');
      const og = await fetchOg(url);
      if (my !== token) return;
      let parts = og.title ? splitBottleTitle(og.title, og.siteName, og.url) : {};
      const guessed = !og.title;
      if (guessed) parts = guessFromUrl(url);
      const fill = (key: 'brand' | 'name', f: Field, v?: string) => {
        if (!v || (bottle[key] && !auto[key])) return;
        bottle[key] = v;
        auto[key] = true;
        f.input.value = v;
        f.missing(false);
      };
      fill('brand', brand, parts.brand);
      fill('name', name, parts.name);

      let gotPhoto = false;
      if (og.image && (!bottle.photo || bottle.photoSource === 'link')) {
        photoNote.textContent = 'загружаю фото…';
        const img = await fetchImage(og.image);
        if (my !== token) return;
        if (img) {
          setBottlePhoto(img, 'link');
          gotPhoto = true;
        }
      }
      const found = [parts.name && 'название', parts.brand && 'бренд', gotPhoto && 'фото'].filter(Boolean) as string[];
      brand.missing(!bottle.brand);
      name.missing(!bottle.name);
      photoArea.classList.toggle('is-missing', !bottle.photo);
      photoNote.textContent = bottle.photo ? '' : 'по ссылке фото не нашлось — перетащи его сюда или вставь скриншот';
      if (!found.length) {
        link.hint('по ссылке ничего не нашлось — заполни вручную');
        name.input.focus();
      } else if (guessed) {
        link.hint('сайт не пустил к странице: бренд и название угаданы по адресу, проверь их');
      } else {
        link.hint(`нашлись ${list(found)}`, 'found');
      }
      if (!bottle.brand) brand.hint('по ссылке бренд не нашёлся');
    }
  }

  function drawPhotoArea() {
    photoArea.replaceChildren();
    const pick = filePicker((f) => setBottlePhoto(f, 'upload'));
    if (bottle.photo) {
      const url = URL.createObjectURL(bottle.photo);
      const img = h('img', { class: 'drop-preview', alt: 'Фото флакона', src: url });
      img.onload = () => URL.revokeObjectURL(url);
      photoArea.append(img, pick);
    } else photoArea.append(h('span', {}, 'Перетащи фото, вставь скриншот'), pick);
  }

  function setBottlePhoto(blob: Blob, source: PhotoSource) {
    bottle.photo = blob;
    bottle.photoSource = source;
    dirty = true;
    if (step !== 'bottle') return;
    photoArea.classList.remove('is-missing');
    if (photoHint) photoHint.textContent = '';
    drawPhotoArea();
  }

  // ---------- step 2: track ----------

  function renderTrack(form: HTMLElement) {
    let token = 0;
    let timer: ReturnType<typeof setTimeout>;
    const link = field({
      label: 'Ссылка на песню',
      value: track.link,
      placeholder: 'Яндекс Музыка, Spotify, YouTube…',
      onInput: (v) => {
        track.link = v.trim();
        dirty = true;
        clearTimeout(timer);
        timer = setTimeout(() => parse(), 350);
      },
    });
    link.hint('из «Моей волны»: «Поделиться» → «Скопировать ссылку»');
    const artist = field({ label: 'Исполнитель', value: track.artist, onInput: (v) => ((track.artist = v), (auto.artist = false), (dirty = true)) });
    const name = field({ label: 'Песня', value: track.title, onInput: (v) => ((track.title = v), (auto.title = false), (dirty = true)) });
    const month = field({
      label: mode.kind === 'new' ? 'Слушаю с' : 'Новая песня с',
      value: track.month,
      type: 'month',
      onInput: (v) => ((track.month = v), (dirty = true)),
    });
    month.input.max = thisMonth();
    if (minMonth) month.input.min = minMonth;
    if (minMonth) month.hint(`текущая песня — с ${monthLabel(minMonth + '-01')}`);

    form.append(link.root, h('div', { class: 's-form__row' }, artist.root, name.root), month.root);

    const left =
      mode.kind === 'new'
        ? [button('Назад', () => go('bottle')), button('Добавлю позже', () => void save(false))]
        : [button('Отмена', requestClose)];
    form.append(
      actions(left, {
        text: 'Дальше: обложка',
        run: () => {
          if (!track.link) {
            link.hint('нужна ссылка: без неё песню не послушать', 'error');
            return link.input.focus();
          }
          if (!track.title.trim()) {
            name.hint('впиши название песни', 'error');
            return name.input.focus();
          }
          if (!/^\d{4}-\d{2}$/.test(track.month) || track.month > thisMonth()) {
            month.hint('выбери месяц, не позже текущего', 'error');
            return month.input.focus();
          }
          if (minMonth && track.month < minMonth) {
            month.hint(`новая песня не может начаться раньше текущей (с ${monthLabel(minMonth + '-01')})`, 'error');
            return month.input.focus();
          }
          go('cover');
        },
      }),
    );

    async function parse() {
      const url = track.link;
      const my = ++token;
      if (!url) return link.hint('из «Моей волны»: «Поделиться» → «Скопировать ссылку»');
      if (!looksLikeUrl(url)) return link.hint('это не похоже на ссылку — она начинается с https://', 'error');
      link.hint('ищу…');
      const t = await fetchTrack(url);
      if (my !== token) return;
      track.links = t.links;
      const parts = t.title ? splitTrackTitle(t.title, t.artist) : { title: '' };
      const fill = (key: 'artist' | 'title', f: Field, v?: string) => {
        if (!v || (track[key] && !auto[key])) return;
        track[key] = v;
        auto[key] = true;
        f.input.value = v;
        f.missing(false);
      };
      fill('artist', artist, parts.artist);
      fill('title', name, parts.title);
      let gotArt = false;
      if (t.artwork) {
        const img = await fetchImage(t.artwork);
        if (my !== token) return;
        if (img) {
          track.artwork = img;
          gotArt = true;
        }
      }
      const found = [parts.title && 'название', parts.artist && 'исполнитель', gotArt && 'обложка'].filter(Boolean) as string[];
      artist.missing(!track.artist);
      name.missing(!track.title);
      if (!found.length) {
        link.hint(
          t.links.yandex
            ? 'Яндекс Музыка не отдаёт данные о треке — впиши исполнителя и песню'
            : 'по ссылке ничего не нашлось — впиши исполнителя и песню',
        );
        (track.artist ? name : artist).input.focus();
      } else link.hint(`нашлись ${list(found)}`, 'found');
      if (!track.artist && found.length) artist.hint('исполнитель по ссылке не нашёлся');
    }
  }

  // ---------- step 3: cover ----------

  function renderCover(form: HTMLElement) {
    if (!track.artwork) cover.useOwn = true;
    coverArea = h('div', { class: 'cover-pick' });
    form.append(coverArea);
    drawCover();
    form.append(
      actions([button('Назад', () => go('track'))], {
        text: mode.kind === 'new' ? 'Поставить на полку' : 'Сохранить пару',
        run: () => void save(true),
      }),
    );
  }

  function drawCover() {
    coverArea.replaceChildren();
    const options = h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'Обложка' });
    const opt = (text: string, own: boolean) => {
      const b = button(text, () => {
        cover.useOwn = own;
        drawCover();
      }, own === cover.useOwn ? 'is-current' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(own === cover.useOwn));
      return b;
    };
    if (track.artwork) options.append(opt('Обложка трека', false), opt('Своя картинка', true));

    const shown = cover.useOwn ? cover.own : track.artwork;
    const area = h('div', { class: 's-drop cover-drop' });
    if (shown) {
      const url = URL.createObjectURL(shown);
      const img = h('img', { class: 'cover-preview', alt: 'Обложка', src: url });
      img.onload = () => URL.revokeObjectURL(url);
      area.append(img);
    }
    if (cover.useOwn) {
      area.append(h('span', {}, shown ? '' : 'Картинка, которая для тебя звучит как эта пара'), filePicker((f) => setOwnCover(f)));
      dropTarget(area, (b) => setOwnCover(b));
    }
    const hint = h(
      'div',
      { class: 's-field__hint' },
      !shown ? 'без картинки на конверте будет название песни' : cover.useOwn ? 'можно перетащить или вставить из буфера' : '',
    );
    coverArea.append(
      h('div', { class: 's-field' }, h('span', { class: 's-field__label' }, 'Обложка · по желанию'), options, area, hint),
    );
  }

  function setOwnCover(blob: Blob) {
    cover.own = blob;
    cover.useOwn = true;
    dirty = true;
    if (step === 'cover') drawCover();
  }

  // ---------- saving ----------

  async function save(withSong: boolean) {
    if (busy) return;
    busy = true;
    const primary = body.querySelector<HTMLButtonElement>('.s-btn--primary');
    if (primary) {
      primary.textContent = 'Ставлю…';
      primary.disabled = true;
    }
    try {
      let bottleId: string;
      if (mode.kind === 'new') {
        let photo: string | undefined, cut: string | undefined, palette = DEFAULT_PALETTE;
        if (bottle.photo) {
          const small = await prepareImage(bottle.photo);
          photo = await putBlob(small);
          const c = await cutout(small);
          if (c) cut = await putBlob(c);
          palette = await paletteOf(c ?? small);
        }
        const b = await addBottle({
          brand: bottle.brand.trim(),
          name: bottle.name.trim(),
          photo,
          cutout: cut,
          palette,
          photoSource: bottle.photo ? bottle.photoSource : 'silhouette',
          sourceUrl: bottle.link || undefined,
        });
        bottleId = b.id;
      } else bottleId = mode.entry.bottle.id;

      if (withSong) {
        const artwork = track.artwork ? await putBlob(await prepareImage(track.artwork, 1024)) : undefined;
        const own = cover.useOwn && cover.own ? await putBlob(await prepareImage(cover.own)) : undefined;
        await setSong(
          bottleId,
          { title: track.title.trim(), artist: track.artist.trim(), artwork, sourceUrl: track.link, platformLinks: track.links },
          `${track.month}-01`,
          own,
        );
      }
      close();
      onSaved(bottleId);
    } catch (e) {
      busy = false;
      console.error(e);
      if (primary) {
        primary.disabled = false;
        primary.textContent = 'Попробовать ещё раз';
      }
    }
  }
}

function filePicker(onFile: (f: File) => void) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', () => input.files?.[0] && onFile(input.files[0]));
  const b = h('button', { type: 'button', class: 's-btn s-btn--label s-btn--bracket', onclick: () => input.click() }, 'выбрать файл');
  return h('span', {}, b, input);
}

/** Files and images dragged from another tab (those arrive as a link and go through the proxy). */
function dropTarget(el: HTMLElement, onImage: (b: Blob, source: PhotoSource) => void) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('is-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('is-over'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('is-over');
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) return onImage(file, 'upload');
    const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (url && looksLikeUrl(url)) {
      const blob = await fetchImage(url.split('\n')[0].trim());
      if (blob) onImage(blob, 'link');
    }
  });
}

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} и ${xs[xs.length - 1]}` : xs[0]);
