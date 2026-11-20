// @vitest-environment jsdom
/**
 * Global native-context-menu suppression — tasks G1 (S1) and G2 (S2), decision §八.
 *
 * The workbench owns right-click: four self-rendered menus (VirtualTable column header,
 * FormulaCard result header, ScriptCard output row, the bare canvas) open on it, and task G3
 * will add the wire drag. `suppressNativeMenu.ts` cancels the browser's own menu for the whole
 * window so those gestures are unambiguous.
 *
 * jsdom has no native menu to observe, so `defaultPrevented` is the proxy for "it will not
 * appear". The other half of the contract is asserted separately: the self-rendered menus are
 * React `onContextMenu` handlers that sit *downstream* of the window listener, so a handler
 * that still runs, and an event that still bubbles, is the evidence that the suppression never
 * grew a `stopPropagation`.
 *
 * G2's half: the temporary editing-surface exemption G1 shipped is GONE. Editing surfaces are
 * cancelled like everything else, and they get our own editing menu instead — the listener
 * dispatches an `EDITING_MENU_REQUEST_EVENT` the mounted host answers. So the two tests that
 * used to assert "the browser's menu is left alone here" now assert the opposite, because
 * letting the native menu through would be a regression of the ruling (and not letting ours
 * through would leave the field with no menu at all).
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installNativeMenuSuppression } from '../src/ui/suppressNativeMenu.ts';
import {
  EDITING_MENU_REQUEST_EVENT,
  type EditingMenuRequestDetail,
} from '../src/ui/editingSurface.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const releases: Array<() => void> = [];
const roots: Array<ReturnType<typeof createRoot>> = [];

/** Install on the jsdom window, remembering the release for `afterEach`. */
function install(): () => void {
  const release = installNativeMenuSuppression(window);
  releases.push(release);
  return release;
}

/** A `MouseEvent` shaped like a real right-click; jsdom fires none on its own. */
function contextMenuEvent(overrides: MouseEventInit = {}): MouseEvent {
  return new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    ...overrides,
  });
}

/** Dispatch a right-click at `target` and hand the event back for assertions. */
function rightClick(target: EventTarget, overrides: MouseEventInit = {}): MouseEvent {
  const event = contextMenuEvent(overrides);
  target.dispatchEvent(event);
  return event;
}

/** Append a container parsed from `html` to the document and return it. */
function surface(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

/** Record every editing-menu request the window sees while `run` executes. */
function collectRequests(run: () => void): EditingMenuRequestDetail[] {
  const seen: EditingMenuRequestDetail[] = [];
  const listener = (event: Event) => {
    seen.push((event as CustomEvent<EditingMenuRequestDetail>).detail);
  };
  window.addEventListener(EDITING_MENU_REQUEST_EVENT, listener);
  try {
    run();
  } finally {
    window.removeEventListener(EDITING_MENU_REQUEST_EVENT, listener);
  }
  return seen;
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

describe('native menu suppression', () => {
  it('is inert before installation and inert again after release', () => {
    const host = surface('<div class="card" id="card"><span id="cell">cell</span></div>');
    const cell = host.querySelector('#cell') as HTMLElement;

    expect(rightClick(cell).defaultPrevented).toBe(false);

    const release = install();
    expect(rightClick(cell).defaultPrevented).toBe(true);

    release();
    expect(rightClick(cell).defaultPrevented).toBe(false);
  });

  it('cancels the native menu on non-editable elements and their descendants', () => {
    install();
    const host = surface(
      '<div class="card" id="card"><div class="card__titlebar"><span id="deep">Title</span></div></div>',
    );
    const targets: EventTarget[] = [
      host,
      host.querySelector('#card') as HTMLElement,
      host.querySelector('#deep') as HTMLElement,
      document.body,
      // Not an element at all: the window is still not an editing surface.
      window,
    ];
    for (const target of targets) {
      expect(rightClick(target).defaultPrevented).toBe(true);
    }
  });

  it('cancels the native menu on editing surfaces too (G2 deleted the exemption)', () => {
    // G1 kept the browser's menu here so a field could still paste. G2 replaces it with the
    // application's own editing menu, so the cancellation is now unconditional — letting the
    // browser's menu back in would be a regression of the §八 ruling.
    install();
    const host = surface(
      [
        '<input id="input" value="x" />',
        '<textarea id="textarea">x</textarea>',
        // A `<select>` has no text to copy, so it is cancelled too and gets no editing menu:
        // its picker is a dropdown, not a context menu.
        '<select id="select"><option>x</option></select>',
        '<div id="editable" contenteditable="true"><span id="editable-child">42</span></div>',
        '<div id="cm" class="cm-content" contenteditable="true"><div id="cm-line">print(x)</div></div>',
      ].join(''),
    );
    for (const id of ['input', 'textarea', 'select', 'editable-child', 'cm-line']) {
      const target = host.querySelector(`#${id}`) as HTMLElement;
      expect(rightClick(target).defaultPrevented).toBe(true);
    }
  });

  it('answers an editing-surface right-click with a request carrying the pointer position', () => {
    install();
    const host = surface('<input id="input" value="abcdef" />');
    const input = host.querySelector('#input') as HTMLInputElement;

    const requests = collectRequests(() => {
      rightClick(input, { clientX: 321, clientY: 123 });
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ x: 321, y: 123 });
    // The target travels, not the surface: the host resolves it (one resolution path).
    expect(requests[0].target).toBe(input);
  });

  it('anchors a keyboard-invoked request to the surface, which carries no pointer position', () => {
    // Shift+F10 / the menu key: same event path, but `clientX`/`clientY` are 0. jsdom reports a
    // zero-size rect as well, so the honest fallback here is the viewport origin — what matters
    // is that a request is still produced for the focused field.
    install();
    const host = surface('<textarea id="area">x</textarea>');
    const area = host.querySelector('#area') as HTMLTextAreaElement;

    const requests = collectRequests(() => {
      rightClick(area, { clientX: 0, clientY: 0 });
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].x).toBe(0);
    expect(requests[0].y).toBe(0);
    expect(requests[0].target).toBe(area);
  });

  it('sends no request for a target that has no editing surface', () => {
    install();
    const host = surface(
      '<div class="card" id="card"><span id="title">Title</span></div><input id="check" type="checkbox" />',
    );

    const requests = collectRequests(() => {
      rightClick(host.querySelector('#title') as HTMLElement);
      rightClick(host.querySelector('#card') as HTMLElement);
      rightClick(host.querySelector('#check') as HTMLElement);
      rightClick(document.body);
      rightClick(window);
    });

    // The four card menus and the wire gesture are downstream handlers, not requests.
    expect(requests).toEqual([]);
  });

  it('does not stack listeners when a hot reload installs from a re-evaluated module', async () => {
    install();
    // A hot reload re-evaluates the module, so the second install carries a *different*
    // handler identity: the case in which a plain `addEventListener` would add a second copy
    // and call `preventDefault` twice.
    vi.resetModules();
    const reloaded = await import('../src/ui/suppressNativeMenu.ts');
    releases.push(reloaded.installNativeMenuSuppression(window));

    const host = surface('<span id="cell">cell</span>');
    const event = contextMenuEvent();
    const prevented = vi.spyOn(event, 'preventDefault');
    (host.querySelector('#cell') as HTMLElement).dispatchEvent(event);

    expect(prevented).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('a stale release cannot tear out the listener a newer install owns', async () => {
    const staleRelease = install();
    vi.resetModules();
    const reloaded = await import('../src/ui/suppressNativeMenu.ts');
    releases.push(reloaded.installNativeMenuSuppression(window));

    // The outgoing module instance's HMR dispose can run after the incoming one installed.
    staleRelease();

    const host = surface('<span id="cell">cell</span>');
    const cell = host.querySelector('#cell') as HTMLElement;
    expect(rightClick(cell).defaultPrevented).toBe(true);
  });
});

describe('self-rendered menus still open', () => {
  it('runs a React onContextMenu handler and lets the event keep bubbling', async () => {
    install();

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    // What the four handlers observe: they run at all, and the default action was already
    // cancelled when they got there (the window capture listener runs first).
    const handlerSaw: boolean[] = [];
    await act(async () => {
      root.render(
        <StrictMode>
          <div
            onContextMenu={(event) => {
              handlerSaw.push(event.defaultPrevented);
              event.preventDefault();
            }}
          >
            <span id="header">Depth</span>
          </div>
        </StrictMode>,
      );
    });

    const bubbled: Event[] = [];
    const onBubble = (event: Event): void => {
      bubbled.push(event);
    };
    window.addEventListener('contextmenu', onBubble);
    try {
      const event = rightClick(host.querySelector('#header') as HTMLElement);
      expect(handlerSaw).toEqual([true]);
      // Propagation is intact: the window's own bubble listener saw the same event.
      expect(bubbled).toHaveLength(1);
      expect(event.cancelBubble).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener('contextmenu', onBubble);
    }
  });

  it('keeps propagating on an editing surface as well (the request is not a bubble barrier)', async () => {
    // The editing menu is a *request*; it must not turn the suppression into a
    // stopPropagation, or a React handler wrapped around a field (a card's own menu) would stop
    // seeing the event the moment the field appears.
    install();

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    const handlerSaw: boolean[] = [];
    await act(async () => {
      root.render(
        <StrictMode>
          <div
            onContextMenu={(event) => {
              handlerSaw.push(event.defaultPrevented);
            }}
          >
            <input id="inside-card" defaultValue="x" />
          </div>
        </StrictMode>,
      );
    });

    const bubbled: Event[] = [];
    const onBubble = (event: Event): void => {
      bubbled.push(event);
    };
    window.addEventListener('contextmenu', onBubble);
    try {
      const event = rightClick(host.querySelector('#inside-card') as HTMLElement);
      expect(handlerSaw).toEqual([true]);
      expect(bubbled).toHaveLength(1);
      expect(event.cancelBubble).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener('contextmenu', onBubble);
    }
  });
});