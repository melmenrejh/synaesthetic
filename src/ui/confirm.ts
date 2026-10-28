// A small confirmation window for irreversible actions, in the same window as the add form
// (design system: Form/Window). No red: the words say what will happen. Esc, a click beside the
// window or «Отмена» say no.
import { tearAll } from '../ds/tear';
import { h, icon } from './dom';

export function confirmDialog(o: { title: string; text: string; confirm: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = h('button', { type: 'button', class: 's-btn' }, 'Отмена');
    const ok = h('button', { type: 'button', class: 's-btn s-btn--primary' }, o.confirm);
    const close = h('button', { type: 'button', class: 's-btn s-btn--icon', 'aria-label': 'Закрыть' });
    close.append(icon('close'));
    const titleId = `c-${Math.random().toString(36).slice(2, 8)}`;
    const win = h(
      'div',
      { class: 's-window flow confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 's-window__bar' }, h('span', { class: 's-window__title' }, 'Подтверждение'), close),
      h(
        'div',
        { class: 's-window__body' },
        h(
          'div',
          { class: 's-form' },
          h('h2', { id: titleId, class: 'ui confirm__title' }, o.title),
          h('p', { class: 'ui muted' }, o.text),
          h('div', { class: 's-form__actions' }, cancel, ok),
        ),
      ),
    );
    const overlay = h('div', { class: 'overlay' }, win);

    const done = (answer: boolean) => {
      removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(false);
      }
    };
    cancel.addEventListener('click', () => done(false));
    close.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) done(false);
    });
    addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    tearAll(win);
    // the safe answer has the focus: Enter by habit does not delete
    cancel.focus();
  });
}
