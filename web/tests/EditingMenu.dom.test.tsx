// @vitest-environment jsdom
/**
 * The self-rendered editing menu (task G2, decision §八 step S2).
 *
 * G2 deletes G1's editing-surface exemption from `suppressNativeMenu.ts`, which is only
 * acceptable because this menu replaces what that exemption was protecting: Copy / Cut / Paste /
 * Select all on the surface the user right-clicked. What is asserted here:
 *
 *   - the rows exist in both languages, and the shortcut hints name the platform modifier;
 *   - each verb acts on the resolved surface (not on a store, not on a guess);
 *   - the greying is decided BEFORE the click from the surface's own `canCopy` / `canPaste`
 *     (an empty selection, a read-only field);
 *   - paste is the one verb that can be refused by the browser, and a refusal greys the row and
 *     names Ctrl+V — the "never a silent failure" ruling;
 *   - `EditingMenuHost` is the thing wired to the window: a right-click on a text field both
 *     cancels the native menu (`defaultPrevented`) and opens this menu at the pointer, while a
 *     right-click anywhere else opens nothing of ours.
 */
import { StrictMode, act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fieldSurface } from '../src/ui/editingSurface.ts';
import { EditingMenu, EditingMenuHost } from '../src/ui/components/EditingMenu.tsx';
import { installNativeMenuSuppression } from '../src/ui/suppressNativeMenu.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];
const releases: Array<() => void> = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(navigator, 'permissions');
});

/** Mount `node` into a fresh container in the document and return the container. */
async function mount(node: ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<StrictMode>{node}</StrictMode>);
  });
  return host;
}

/** A textarea in the document plus the surface that wraps it. */
function field(value: string): {
  area: HTMLTextAreaElement;
  surface: ReturnType<typeof fieldSurface>;
} {
  const host = document.createElement('div');
  document.body.append(host);
  const area = document.createElement('textarea');
  area.value = value;
  host.append(area);
  return { area, surface: fieldSurface(area) };
}

/** The menu row whose label starts with `label`. */
function row(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.context-menu__item')].find(
    (node) => node.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no editing-menu row labelled "${label}"`);
  return found;
}

/** Every rendered menu popup, in document order. */
function menus(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.context-menu--list')];
}

/** Give the window an async clipboard with the two spies the menu can reach. */
function mockClipboard(options: {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: vi.fn(options.readText ?? (async () => '')),
      writeText: vi.fn(options.writeText ?? (async () => {})),
    },
  });
}

/** Make the Permissions API answer for `clipboard-read`. */
function mockClipboardPermission(state: 'granted' | 'denied' | 'prompt'): void {
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query: vi.fn(async () => ({ state })),
    },
  });
}

describe('the editing menu', () => {
  it('offers the four verbs with their shortcuts (zh)', async () => {
    mockClipboard({});
    const { surface } = field('abcdef');
    await mount(
      <EditingMenu x={120} y={80} surface={surface} locale="zh" onDismiss={() => {}} />,
    );

    expect(menus()).toHaveLength(1);
    expect(row('复制').disabled).toBe(true); // nothing selected yet
    expect(row('剪切').disabled).toBe(true);
    expect(row('粘贴').disabled).toBe(false); // a clipboard read is available
    expect(row('全选').disabled).toBe(false);
    expect(row('复制').textContent).toContain('Ctrl+C');
    expect(row('剪切').textContent).toContain('Ctrl+X');
    expect(row('粘贴').textContent).toContain('Ctrl+V');
    expect(row('全选').textContent).toContain('Ctrl+A');
    // Undo/redo are deliberately absent from this menu (decision §八).
    expect(document.querySelector('.context-menu--list')?.textContent).not.toMatch(/撤销|重做/);
  });

  it('speaks English when the locale is English', async () => {
    const { surface } = field('abcdef');
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="en" onDismiss={() => {}} />,
    );
    expect(row('Copy')).toBeDefined();
    expect(row('Cut')).toBeDefined();
    expect(row('Paste')).toBeDefined();
    expect(row('Select all')).toBeDefined();
  });

  it('copies the selected text and closes', async () => {
    mockClipboard({});
    const { area, surface } = field('abcdef');
    area.setSelectionRange(1, 4);
    const onDismiss = vi.fn();
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="zh" onDismiss={onDismiss} />,
    );

    expect(row('复制').disabled).toBe(false);
    await act(async () => {
      row('复制').click();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('bcd');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Copy leaves the text where it was.
    expect(area.value).toBe('abcdef');
  });

  it('cuts the selection out of the field', async () => {
    mockClipboard({});
    const { area, surface } = field('abcdef');
    area.setSelectionRange(1, 4);
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="zh" onDismiss={() => {}} />,
    );

    await act(async () => {
      row('剪切').click();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('bcd');
    expect(area.value).toBe('aef');
  });

  it('greys cut (not copy) in a read-only field', async () => {
    mockClipboard({});
    const { area, surface } = field('abcdef');
    area.readOnly = true;
    area.setSelectionRange(0, 3);
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="zh" onDismiss={() => {}} />,
    );

    expect(row('复制').disabled).toBe(false);
    expect(row('剪切').disabled).toBe(true);
    expect(row('粘贴').disabled).toBe(true);
    // The reason is on screen, and it does not suggest a keystroke that would also fail.
    expect(document.querySelector('.context-menu__hint')?.textContent).toBe('此处不可编辑');
  });

  it('selects the whole field and closes', async () => {
    const { area, surface } = field('abcdef');
    const onDismiss = vi.fn();
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="zh" onDismiss={onDismiss} />,
    );

    await act(async () => {
      row('全选').click();
    });

    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(6);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('pastes the clipboard text at the caret and closes', async () => {
    mockClipboard({ readText: async () => 'XY' });
    const { area, surface } = field('abcdef');
    area.setSelectionRange(2, 4);
    const onDismiss = vi.fn();
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="zh" onDismiss={onDismiss} />,
    );

    await act(async () => {
      row('粘贴').click();
    });

    expect(area.value).toBe('abXYef');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('greys Paste and names Ctrl+V when the clipboard read is refused', async () => {
    // The ruling: a denied read must not look like a paste that did nothing.
    mockClipboard({
      readText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });
    const { surface } = field('abcdef');
    const onDismiss = vi.fn();
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="zh" onDismiss={onDismiss} />,
    );

    await act(async () => {
      row('粘贴').click();
    });

    // Still open (nothing was pasted), the row is now disabled, and the fallback is spelled out.
    expect(onDismiss).not.toHaveBeenCalled();
    expect(row('粘贴').disabled).toBe(true);
    expect(document.querySelector('.context-menu__hint')?.textContent).toContain('Ctrl+V');
  });

  it('greys Paste from the first frame when the browser has no clipboard read', async () => {
    // jsdom implements no async clipboard at all — the honest state for a browser without it.
    const { surface } = field('abcdef');
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="zh" onDismiss={() => {}} />,
    );

    expect(row('粘贴').disabled).toBe(true);
    expect(document.querySelector('.context-menu__hint')?.textContent).toContain('Ctrl+V');
  });

  it('greys Paste up front when the permission is already denied', async () => {
    mockClipboard({});
    mockClipboardPermission('denied');
    const { surface } = field('abcdef');
    await mount(
      <EditingMenu x={0} y={0} surface={surface} locale="zh" onDismiss={() => {}} />,
    );

    expect(row('粘贴').disabled).toBe(true);
    expect(document.querySelector('.context-menu__hint')?.textContent).toContain('Ctrl+V');
  });
});

describe('the menu host', () => {
  /** Dispatch a real-shaped right-click at `target`. */
  function rightClick(target: EventTarget, at: { x: number; y: number }): MouseEvent {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: at.x,
      clientY: at.y,
    });
    target.dispatchEvent(event);
    return event;
  }

  it('answers a right-click on a text field with the menu, at the pointer', async () => {
    releases.push(installNativeMenuSuppression(window));
    const host = document.createElement('div');
    document.body.append(host);
    const input = document.createElement('input');
    input.value = 'abcdef';
    host.append(input);

    await mount(<EditingMenuHost locale="zh" />);
    expect(menus()).toHaveLength(0);

    let event!: MouseEvent;
    await act(async () => {
      event = rightClick(input, { x: 210, y: 130 });
    });

    expect(event.defaultPrevented).toBe(true);
    expect(menus()).toHaveLength(1);
    // Anchored at the pointer (Popup clamps with an 8px margin, which does not bite here).
    expect(menus()[0].style.left).toBe('210px');
    expect(menus()[0].style.top).toBe('130px');

    await act(async () => {
      row('全选').click();
    });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
    // Acting on a row closes the menu.
    expect(menus()).toHaveLength(0);
  });

  it('opens nothing for a right-click that is not an editing surface', async () => {
    releases.push(installNativeMenuSuppression(window));
    const host = document.createElement('div');
    document.body.append(host);
    const card = document.createElement('div');
    card.className = 'card';
    card.textContent = 'Depth';
    host.append(card);

    await mount(<EditingMenuHost locale="en" />);

    let event!: MouseEvent;
    await act(async () => {
      event = rightClick(card, { x: 10, y: 10 });
    });

    expect(event.defaultPrevented).toBe(true); // the native menu is still gone, application-wide
    expect(menus()).toHaveLength(0); // ...and we offer nothing there: the card has its own menu
  });

  it('replaces an open menu with the surface of the second right-click', async () => {
    releases.push(installNativeMenuSuppression(window));
    const host = document.createElement('div');
    document.body.append(host);
    const first = document.createElement('input');
    first.value = 'aaa';
    const second = document.createElement('textarea');
    second.value = 'bbb';
    host.append(first, second);
    // Park a recognisable selection in the first field: if the second right-click had NOT
    // replaced the menu's surface, Select all would land here.
    first.setSelectionRange(0, 2);

    await mount(<EditingMenuHost locale="zh" />);
    await act(async () => {
      rightClick(first, { x: 40, y: 40 });
    });
    await act(async () => {
      rightClick(second, { x: 60, y: 60 });
    });

    expect(menus()).toHaveLength(1);
    await act(async () => {
      row('全选').click();
    });
    // The second field is the one that got selected; the first kept its own selection.
    expect(second.selectionStart).toBe(0);
    expect(second.selectionEnd).toBe(3);
    expect(first.selectionStart).toBe(0);
    expect(first.selectionEnd).toBe(2);
  });
});