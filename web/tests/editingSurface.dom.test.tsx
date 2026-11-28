// @vitest-environment jsdom
/**
 * Editing surfaces — the adapter layer behind the self-rendered editing menu (task G2,
 * decision §八).
 *
 * What this file pins down:
 *   - RESOLUTION. A plain `<input>` / `<textarea>` is an editing surface with no registration
 *     at all (that is what keeps `VirtualTable`, `FormulaCard` and `NameField` untouched); a
 *     registered element wins from anywhere inside it (CodeMirror reports its own state); and
 *     everything else — a card, the canvas, `body`, a non-text input — resolves to `null`, so
 *     the menu is not offered where there is nothing to copy.
 *   - THE VERBS. Copy/cut read the surface's selection, cut removes it, paste inserts at the
 *     caret, select-all covers the whole field. The `can*` members are live getters, not a
 *     snapshot: the menu asks them as it draws.
 *   - REACT RECEIVES THE EDIT. Paste into a controlled input must reach `onChange`; if it did
 *     not, the store's copy of the text would silently disagree with what the user sees. The
 *     adapter gets this by going through `setRangeText` (not by assigning `value`), which is
 *     exactly the behaviour asserted here.
 */
import { StrictMode, act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  codeMirrorSurface,
  fieldSurface,
  registerEditingSurface,
  resolveEditingSurface,
  writeClipboardText,
} from '../src/ui/editingSurface.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
});

/** Append a parsed fragment to the document and return its host (the surfaces need layout). */
function surface(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

/** Give the test window an async clipboard with a `writeText` spy. */
function mockClipboard(writeText = vi.fn(async () => {})): { writeText: typeof writeText } {
  const clipboard = { writeText };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  return clipboard;
}

/** Mount a bare CodeMirror view (the script card's editor is the real consumer). */
function mountEditor(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.append(host);
  return new EditorView({ state: EditorState.create({ doc }), parent: host });
}

describe('resolveEditingSurface', () => {
  it('resolves a plain input to the default adapter without any registration', () => {
    const host = surface('<input id="input" value="abcdef" />');
    const input = host.querySelector('#input') as HTMLInputElement;
    const resolved = resolveEditingSurface(input);
    expect(resolved).not.toBeNull();
    // The default adapter is live, not a snapshot: nothing is selected yet.
    expect(resolved?.canCopy).toBe(false);
    input.setSelectionRange(1, 3);
    expect(resolved?.canCopy).toBe(true);
  });

  it('resolves a textarea, and a read-only field reports that it cannot paste', () => {
    const host = surface('<textarea id="area">hello</textarea><input id="ro" readonly value="r" />');
    const area = host.querySelector('#area') as HTMLTextAreaElement;
    const readOnly = host.querySelector('#ro') as HTMLInputElement;

    const areaSurface = resolveEditingSurface(area);
    expect(areaSurface).not.toBeNull();
    expect(areaSurface?.canPaste).toBe(true);

    const readOnlySurface = resolveEditingSurface(readOnly);
    expect(readOnlySurface).not.toBeNull();
    expect(readOnlySurface?.canPaste).toBe(false);
  });

  it('returns null where there is nothing to edit', () => {
    const host = surface(
      [
        '<div class="card" id="card"><span id="title">Title</span></div>',
        '<input id="check" type="checkbox" />',
        '<input id="button" type="button" value="run" />',
      ].join(''),
    );
    expect(resolveEditingSurface(host.querySelector('#card'))).toBeNull();
    expect(resolveEditingSurface(host.querySelector('#title'))).toBeNull();
    expect(resolveEditingSurface(host.querySelector('#check'))).toBeNull();
    expect(resolveEditingSurface(host.querySelector('#button'))).toBeNull();
    // Not elements at all: the window/document/bare null are never editing surfaces.
    expect(resolveEditingSurface(document)).toBeNull();
    expect(resolveEditingSurface(window)).toBeNull();
    expect(resolveEditingSurface(null)).toBeNull();
  });

  it('prefers a registered surface found anywhere up the tree (CodeMirror)', () => {
    const view = mountEditor('print(1)');
    const registered = codeMirrorSurface(view);
    const unregister = registerEditingSurface(view.contentDOM, registered);
    try {
      // A right-click lands on the rendered line, not on `.cm-content` itself.
      const line = view.contentDOM.querySelector('.cm-line') as HTMLElement;
      expect(line).not.toBeNull();
      expect(resolveEditingSurface(line)).toBe(registered);
    } finally {
      unregister();
      view.destroy();
    }
    // After teardown the element no longer resolves to anything.
    expect(resolveEditingSurface(view.contentDOM)).toBeNull();
  });

  it('does not let a stale unregister tear out a newer registration', () => {
    const view = mountEditor('x = 1');
    const first = codeMirrorSurface(view);
    const second = codeMirrorSurface(view);
    const unregisterFirst = registerEditingSurface(view.contentDOM, first);
    const unregisterSecond = registerEditingSurface(view.contentDOM, second);
    unregisterFirst(); // an older card's cleanup running after a newer registration
    expect(resolveEditingSurface(view.contentDOM)).toBe(second);
    unregisterSecond();
    view.destroy();
  });
});

describe('the default field adapter', () => {
  it('copies the selection to the clipboard', () => {
    const clipboard = mockClipboard();
    const host = surface('<input id="input" value="abcdef" />');
    const input = host.querySelector('#input') as HTMLInputElement;
    input.setSelectionRange(2, 4);
    fieldSurface(input).copy();
    expect(clipboard.writeText).toHaveBeenCalledWith('cd');
  });

  it('cuts the selection out of the field and announces the change', () => {
    const clipboard = mockClipboard();
    const host = surface('<input id="input" value="abcdef" />');
    const input = host.querySelector('#input') as HTMLInputElement;
    const events: Event[] = [];
    input.addEventListener('input', (event) => events.push(event));
    input.setSelectionRange(1, 3);

    fieldSurface(input).cut();

    expect(clipboard.writeText).toHaveBeenCalledWith('bc');
    expect(input.value).toBe('adef');
    // One `input` event, bubbling: this is what a React controlled field listens for.
    expect(events).toHaveLength(1);
    expect(events[0].bubbles).toBe(true);
  });

  it('refuses to cut or paste in a read-only field', () => {
    const clipboard = mockClipboard();
    const host = surface('<input id="input" readonly value="abcdef" />');
    const input = host.querySelector('#input') as HTMLInputElement;
    input.setSelectionRange(1, 3);
    const adapter = fieldSurface(input);

    adapter.cut();
    adapter.paste('zz');

    expect(input.value).toBe('abcdef');
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('pastes at the caret, replacing the selection, and leaves the caret after it', () => {
    const host = surface('<textarea id="area">abcdef</textarea>');
    const area = host.querySelector('#area') as HTMLTextAreaElement;
    area.setSelectionRange(2, 4);

    fieldSurface(area).paste('XY');

    expect(area.value).toBe('abXYef');
    expect(area.selectionStart).toBe(4);
    expect(area.selectionEnd).toBe(4);
  });

  it('selects the whole value', () => {
    const host = surface('<input id="input" value="abcdef" />');
    const input = host.querySelector('#input') as HTMLInputElement;
    fieldSurface(input).selectAll();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
  });

  it('falls back to the deprecated copy command when there is no async clipboard', () => {
    // jsdom implements neither API, so the fallback is stubbed in place: the point is that the
    // adapter uses it rather than throwing or silently dropping the copy.
    const execCommand = vi.fn(() => {
      const scratch = document.querySelector('textarea[readonly]') as HTMLTextAreaElement | null;
      expect(scratch?.value).toBe('requested text');
      expect(scratch?.selectionStart).toBe(0);
      expect(scratch?.selectionEnd).toBe('requested text'.length);
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const host = surface('<input id="input" value="abcdef" />');
    const input = host.querySelector('#input') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 3);

    writeClipboardText('requested text');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea[readonly]')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });
});

describe('the CodeMirror adapter', () => {
  it('copies and cuts from the view selection, not from the DOM', () => {
    const clipboard = mockClipboard();
    const view = mountEditor('print(1)');
    try {
      const adapter = codeMirrorSurface(view);
      expect(adapter.canCopy).toBe(false); // an empty selection has nothing to copy

      view.dispatch({ selection: { anchor: 0, head: 8 } });
      expect(adapter.canCopy).toBe(true);
      adapter.copy();
      expect(clipboard.writeText).toHaveBeenLastCalledWith('print(1)');

      adapter.cut();
      expect(clipboard.writeText).toHaveBeenLastCalledWith('print(1)');
      expect(view.state.doc.toString()).toBe('');
    } finally {
      view.destroy();
    }
  });

  it('pastes through a transaction, so the view sees a document change', () => {
    // The card's own update listener re-runs the syntax check and the settle operation on
    // `docChanged`; a DOM-only insertion would skip all of that, so the change must arrive as
    // a transaction.
    let docChanges = 0;
    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          EditorView.updateListener.of((update) => {
            if (update.docChanged) ++docChanges;
          }),
        ],
      }),
      parent: host,
    });
    try {
      const adapter = codeMirrorSurface(view);
      expect(adapter.canPaste).toBe(true);
      adapter.paste('B = 2');
      expect(view.state.doc.toString()).toBe('B = 2');
      expect(docChanges).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it('selects the whole document', () => {
    const view = mountEditor('line one\nline two');
    try {
      codeMirrorSurface(view).selectAll();
      const { from, to } = view.state.selection.main;
      expect(from).toBe(0);
      expect(to).toBe(view.state.doc.length);
    } finally {
      view.destroy();
    }
  });
});

describe('a React controlled input receives the adapter edit', () => {
  it('propagates a paste into state through onChange', async () => {
    // The realistic shape: the visible value comes from React state, so the edit is only
    // real if `onChange` fired — a DOM-only assertion would pass while the store kept the old
    // text (the failure this adapter exists to avoid).
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);

    const changes: string[] = [];
    function Field(): ReactElement {
      const [value, setValue] = useState('ab');
      return (
        <input
          id="controlled"
          value={value}
          onChange={(event) => {
            changes.push(event.target.value);
            setValue(event.target.value);
          }}
        />
      );
    }

    await act(async () => {
      root.render(
        <StrictMode>
          <Field />
        </StrictMode>,
      );
    });

    const input = host.querySelector('#controlled') as HTMLInputElement;
    input.setSelectionRange(1, 2);
    await act(async () => {
      resolveEditingSurface(input)?.paste('XYZ');
    });

    expect(changes).toEqual(['aXYZ']);
    expect(input.value).toBe('aXYZ');
  });
});