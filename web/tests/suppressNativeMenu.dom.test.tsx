// @vitest-environment jsdom
/**
 * Global native-context-menu suppression — task G1, decision §八 step S1.
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
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installNativeMenuSuppression,
  isEditingSurfaceTarget,
} from '../src/ui/suppressNativeMenu.ts';

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

  it('leaves editing surfaces alone so the browser paste/spelling menu keeps working', () => {
    // Temporary exemption (decision §八): removed by task G2, which replaces these native
    // menus with the `EditingSurface` adapter plus a self-rendered one.
    install();
    const host = surface(
      [
        '<input id="input" value="x" />',
        '<textarea id="textarea">x</textarea>',
        '<select id="select"><option>x</option></select>',
        '<div id="editable" contenteditable="true"><span id="editable-child">42</span></div>',
        '<div id="cm" class="cm-content" contenteditable="true"><div id="cm-line">print(x)</div></div>',
      ].join(''),
    );
    for (const id of ['input', 'textarea', 'select', 'editable-child', 'cm-line']) {
      const target = host.querySelector(`#${id}`) as HTMLElement;
      expect(rightClick(target).defaultPrevented).toBe(false);
    }
  });

  it('answers the editing-surface exemption by the nearest editable ancestor', () => {
    const host = surface(
      '<div id="editable" contenteditable="true"><span id="inside">42</span></div>' +
        '<span id="outside">42</span>',
    );
    const editable = host.querySelector('#editable') as HTMLElement;
    expect(isEditingSurfaceTarget(editable)).toBe(true);
    expect(isEditingSurfaceTarget(host.querySelector('#inside'))).toBe(true);
    expect(isEditingSurfaceTarget(host.querySelector('#outside'))).toBe(false);
    expect(isEditingSurfaceTarget(document)).toBe(false);
    expect(isEditingSurfaceTarget(null)).toBe(false);
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
});