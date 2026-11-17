/**
 * @vitest-environment jsdom
 *
 * The script card's DOM: declaration panels, live rename preview, refusals, debug panel.
 *
 * The component is mounted against the REAL store (only the transport is mocked), because the
 * card's rules are split between the two on purpose: the panel PREVIEWS a rename, the store
 * APPLIES it with the same predicate. A test that stubbed either side would not catch the
 * one bug that matters — a preview promising an edit the store then refuses (or worse, an
 * edit the preview never showed).
 *
 * Assertions are written around what the user reasons about:
 *   - which names the script can read, and where each port comes from;
 *   - how many times a rename will rewrite the script ("将替换 N 处"), with identifiers in
 *     strings and comments correctly NOT counted;
 *   - a clash that names its counterpart instead of saying "invalid";
 *   - a traceback that is clickable, because its line numbers are the editor's line numbers.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditorView } from '@codemirror/view';

import type { ScriptCheckResult } from '../src/backend/client.ts';
import { MatrixData } from '../src/core/MatrixData.ts';
import { portAnchor } from '../src/ui/cardMetrics.ts';
import { useWorkspace, emptyScriptRun } from '../src/ui/workspaceStore.ts';
import { isScriptCard, type FunctionCardModel } from '../src/ui/types.ts';
import { initialTrust } from '../src/ui/workspaceTrust.ts';
import {
  ScriptCard,
  localSyntaxDiagnostic,
  mergeScriptDiagnostics,
  tracebackLines,
  type ScriptDiagnostic,
} from '../src/ui/components/ScriptCard.tsx';

const client = vi.hoisted(() => ({
  hello: vi.fn(async () => ({ ok: true })),
  signatures: vi.fn(async () => []),
  registerMatrix: vi.fn(async (_name: string) => ({ ok: true, matrixId: 70, revision: 1 })),
  patchCells: vi.fn(async () => ({ ok: true })),
  deleteMatrix: vi.fn(async () => ({ ok: true })),
  createNode: vi.fn(async (_inputs: unknown, arg: unknown) => ({
    ok: true,
    nodeId: 11,
    resultMatrixId: 111,
    resultMatrixIds: [111],
    signatureId: typeof arg === 'string' ? 'builtin:expression-columns' : (arg as { signatureId: string }).signatureId,
    state: 'dirty',
  })),
  patchNode: vi.fn(async (nodeId: number) => ({ ok: true, nodeId, state: 'dirty' })),
  deleteNode: vi.fn(async () => ({ ok: true })),
  getNode: vi.fn(async () => null),
  computeNode: vi.fn(async (nodeId: number) => ({
    ok: true,
    nodeId,
    state: 'done',
    resultMatrixIds: [111],
  })),
  checkAccuracy: vi.fn(async () => ({})),
  checkScript: vi.fn(async (_script: string) => ({ ok: true, impure: [] as string[] })),
  listNodes: vi.fn(async () => []),
  nodeResult: vi.fn(async () => ({ ok: false })),
  events: vi.fn(async () => []),
  trustStatus: vi.fn(async () => ({
    ok: true,
    persistence: 'persistent',
    location: '/tmp/trust.json',
    envId: 'v1-test',
    envChanged: false,
    entries: 0,
  })),
  trustDecidePersistence: vi.fn(async () => ({
    ok: true,
    persistence: 'persistent',
    location: '/tmp/trust.json',
    envId: 'v1-test',
    envChanged: false,
    entries: 0,
  })),
  trustLookup: vi.fn(async () => ({
    ok: true,
    hash: '',
    known: false,
    envMatch: true,
    scripts: [],
    persistence: 'persistent',
  })),
  trustRecord: vi.fn(async () => true),
  trustRevoke: vi.fn(async () => true),
  window: vi.fn(async () => ({
    ok: true,
    rows: 2,
    columns: 1,
    totalRows: 2,
    totalCols: 1,
    names: ['Pos.1'],
    data: [new Float64Array([10, 20])],
  })),
}));

vi.mock('../src/backend/client.ts', () => ({
  PROTOCOL_VERSION: 1,
  REQUIRED_CAPABILITIES: [],
  decodeMatrixFrame: () => ({ ok: false, code: 'badFrame' }),
  BackendClient: class {
    constructor() {
      Object.assign(this, client);
    }
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = () => useWorkspace.getState();
const roots: ReturnType<typeof createRoot>[] = [];

/** A data table: `rows` rows of one column labelled `value`. */
function table(rows: number): MatrixData {
  const data = new MatrixData();
  data.appendColumn('Pos.1', Array.from({ length: rows }, (_, index) => index + 1));
  data.setColumnAnnotation(0, 'value');
  return data;
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** The store holds the authority; the mounted card follows it, like CardCanvas does. */
function Harness({ cardId, onJumpToLine }: { cardId: number; onJumpToLine: (line: number) => void }) {
  const card = useWorkspace((state) => state.cards.find((entry) => entry.id === cardId));
  if (!card || !isScriptCard(card)) return null;
  return (
    <ScriptCard
      card={card}
      active
      closeBlocked={false}
      onActivate={() => {}}
      onClose={() => {}}
      onCloseBlocked={() => {}}
      onJumpToLine={onJumpToLine}
    />
  );
}

async function mount(cardId: number, onJumpToLine: (line: number) => void = () => {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <Harness cardId={cardId} onJumpToLine={onJumpToLine} />
      </StrictMode>,
    );
  });
  await flush();
  return host;
}

/** React-compatible input write (the prototype setter is what React's onChange listens to). */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function nameInput(host: HTMLElement, ariaLabel: string): HTMLInputElement {
  const input = host.querySelector(`input[aria-label="${ariaLabel}"]`);
  if (!input) throw new Error(`no name input labelled ${ariaLabel}`);
  return input as HTMLInputElement;
}

async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await flush();
}

async function edit(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    type(input, value);
  });
}

let cardId = 0;

beforeEach(async () => {
  store().reset();
  store().setLocale('zh');
  const sourceId = store().addMatrixCard([{ name: 'a.csv', matrix: table(2) }]);
  await flush();
  cardId = store().addScriptCard([sourceId]) as number;
  await flush();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  store().reset();
});

const card = (): FunctionCardModel =>
  store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;

describe('layout', () => {
  it('renders the run bar, both declaration panels, the editor and the language badge', async () => {
    const host = await mount(cardId);

    expect(host.querySelectorAll('.script-card__panel')).toHaveLength(2);
    const panels = [...host.querySelectorAll('.script-card__panel')].map((panel) =>
      panel.getAttribute('aria-label'),
    );
    expect(panels).toEqual(['输入端口', '输出声明']);

    const bar = host.querySelector('.script-card__bar')!;
    expect(bar.textContent).toContain('净室运行');
    expect(bar.textContent).toContain('调试运行');
    // The environment stamp exists before the first run (pinned toolchain, no duration yet).
    expect(bar.querySelector('.script-card__env')?.textContent).toContain('python 3.13.18');
    expect(bar.querySelector('.script-card__lang')?.textContent).toBe('py');
    // The four-state lamp is present (dirty after birth: nothing has run).
    expect(host.querySelector('.script-card__bar .node-light')).not.toBeNull();

    // CodeMirror really mounted, and it shows the template the card was born with.
    const editor = host.querySelector('.script-card__editor .cm-editor');
    expect(editor).not.toBeNull();
    expect(host.querySelector('.script-card__editor .cm-content')?.textContent).toContain(
      'result = A * 1.0',
    );
  });

  it('names each port with its variable, its source and its shape', async () => {
    const host = await mount(cardId);
    const row = host.querySelector('.script-card__row')!;

    expect(nameInput(host, '输入端口 1').value).toBe('A');
    // Where the values come from: the file name, so the user never has to guess.
    expect(row.querySelector('.script-card__source')?.textContent).toContain('a.csv');
    expect(row.querySelector('.script-card__shape')?.textContent).toBe('2×1');
    expect(row.querySelector('.script-card__mode')?.textContent).toBe('矩阵');
  });

  it('lists output 0 with its stable identity and the add/remove controls', async () => {
    const host = await mount(cardId);
    const rows = host.querySelectorAll('.script-card__row--output');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.script-card__output-id')?.textContent).toBe('out:0');
    // The display output cannot be removed, so its control is disabled from the start.
    expect((rows[0].querySelector('.script-card__remove') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelectorAll('.script-card__add')).toHaveLength(2);
  });
});

describe('rename preview', () => {
  it('counts identifier occurrences only — a name inside a string or a comment is not one', async () => {
    store().setScriptText(
      cardId,
      'label = "A is not a reference"\n# A in a comment is not a reference either\nx = A * 2.0\nresult = x + A\n',
    );
    await flush();
    const host = await mount(cardId);

    const input = nameInput(host, '输入端口 1');
    await edit(input, 'sensor');

    // `A` appears twice as an identifier and twice more inside a string/comment.
    const hint = host.querySelector('.script-card__name-hint');
    expect(hint?.textContent).toBe('将替换 2 处');
    expect(hint?.getAttribute('role')).toBe('status');
  });

  it('says plainly when the name is not referenced at all', async () => {
    store().setScriptText(cardId, 'result = np.zeros((1, 1))\n');
    await flush();
    const host = await mount(cardId);

    await edit(nameInput(host, '输入端口 1'), 'sensor');
    expect(host.querySelector('.script-card__name-hint')?.textContent).toContain(
      '脚本里没有出现这个名字',
    );
  });

  it('commits the rename: the panel, the declaration and the script text all agree', async () => {
    const host = await mount(cardId);
    const input = nameInput(host, '输入端口 1');

    await edit(input, 'sensor');
    await press(input, 'Enter');

    expect(card().params.portNames).toEqual(['sensor']);
    // The template's single identifier occurrence was rewritten, comment untouched.
    expect(card().params.script).toContain('result = sensor * 1.0');
    expect(card().params.script).toContain('# A: float64 matrix');
    // The port identity is untouched — only the injected name moved.
    expect(card().inputs[0].portId).toBe('in:0');
    expect((host.querySelector('input[aria-label="输入端口 1"]') as HTMLInputElement).value).toBe(
      'sensor',
    );
  });

  it('reverts on Escape', async () => {
    const host = await mount(cardId);
    const input = nameInput(host, '输入端口 1');

    await edit(input, 'sensor');
    await press(input, 'Escape');

    expect(input.value).toBe('A');
    expect(card().params.portNames).toEqual(['A']);
  });
});

describe('name refusals', () => {
  it('refuses a name that the other panel already declares, and names it', async () => {
    const host = await mount(cardId);
    const input = nameInput(host, '输入端口 1');

    // `result` is this card's declared OUTPUT: one namespace, so a port may not take it.
    await edit(input, 'result');

    const alert = host.querySelector('.script-card__name-hint[role="alert"]');
    expect(alert?.textContent).toBe('与输出声明「result」重名');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    await press(input, 'Enter');
    // Nothing applied: the store still holds both declarations.
    expect(card().params.portNames).toEqual(['A']);
    expect(card().params.outputs).toEqual(['result']);
  });

  it('refuses reserved names and non-identifiers before they reach the backend', async () => {
    const host = await mount(cardId);
    const input = nameInput(host, '输入端口 1');

    await edit(input, 'names_a');
    expect(host.querySelector('.script-card__name-hint[role="alert"]')?.textContent).toContain(
      'names_*',
    );

    await edit(input, '2bad');
    expect(host.querySelector('.script-card__name-hint[role="alert"]')?.textContent).toContain(
      'Python 标识符',
    );
    expect(card().params.portNames).toEqual(['A']);
  });

  it('warns about a case-only twin but lets it through', async () => {
    store().renameScriptOutput(cardId, 'out:0', 'total');
    await flush();
    const host = await mount(cardId);
    const input = nameInput(host, '输入端口 1');

    await edit(input, 'TOTAL');
    expect(host.querySelector('.script-card__name-hint[role="alert"]')).toBeNull();
    expect(host.querySelector('.script-card__name-warn')?.textContent).toContain('total');

    await press(input, 'Enter');
    expect(card().params.portNames).toEqual(['TOTAL']);
  });
});

describe('debug panel', () => {
  it('is absent while nothing has run (and does not take vertical space)', async () => {
    const host = await mount(cardId);
    expect(host.querySelector('.script-card__debug')).toBeNull();
  });

  it('opens on a failure and renders the traceback as clickable script lines', async () => {
    useWorkspace.setState((state) => ({
      scriptRuns: {
        ...state.scriptRuns,
        [cardId]: {
          ...emptyScriptRun(),
          status: 'error',
          mode: 'clean',
          code: 'invalidOutput',
          elapsedMs: 42,
          params: {
            name: 'result',
            reason: 'object dtype',
            stderr:
              'Traceback (most recent call last):\n' +
              '  File "<脚本卡>", line 3, in <module>\n' +
              '    result = A * object()\n' +
              'TypeError: unsupported operand type(s)\n',
          },
        },
      },
    }));
    const jumped: number[] = [];
    const host = await mount(cardId, (line) => jumped.push(line));

    const panel = host.querySelector('.script-card__debug');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('.script-card__debug-body')).not.toBeNull();
    expect(panel?.textContent).toContain('输出取值不合法');
    expect(panel?.textContent).toContain('42 ms');

    const jumps = [...panel!.querySelectorAll('.script-card__trace-jump')];
    // Exactly one line names a script line; the rest of the traceback is prose.
    expect(jumps).toHaveLength(1);
    expect(jumps[0].textContent).toContain('line 3');

    await act(async () => {
      (jumps[0] as HTMLButtonElement).click();
    });
    expect(jumped).toEqual([3]);
  });

  it('collapses and reopens on the header', async () => {
    useWorkspace.setState((state) => ({
      scriptRuns: {
        ...state.scriptRuns,
        [cardId]: { ...emptyScriptRun(), status: 'done', mode: 'clean', elapsedMs: 7 },
      },
    }));
    const host = await mount(cardId);

    const toggle = host.querySelector('.script-card__debug-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.script-card__debug-body')?.textContent).toContain('净室运行');

    await act(async () => {
      toggle.click();
    });
    expect(
      (host.querySelector('.script-card__debug-toggle') as HTMLButtonElement).getAttribute(
        'aria-expanded',
      ),
    ).toBe('false');
    expect(host.querySelector('.script-card__debug-body')).toBeNull();
  });
});

describe('traceback parsing', () => {
  it('only marks lines that name a script line', () => {
    const parsed = tracebackLines(
      'Traceback (most recent call last):\n  File "<脚本卡>", line 12, in <module>\nZeroDivisionError: division by zero\n',
    );
    expect(parsed.map((entry) => entry.line)).toEqual([null, 12, null]);
    expect(tracebackLines('')).toEqual([]);
  });
});
// ── two-layer diagnostics ─────────────────────────────────────────────────────────────

/**
 * The merge rule as a pure function.
 *
 * The claim is not "the backend is usually right" but a precedence order: an authoritative
 * verdict FOR THE TEXT ON SCREEN replaces the local guess outright, a stale verdict is never
 * applied, and a check that could not run is itself a visible note — "no errors shown" must
 * never silently mean "the check was skipped".
 */
describe('diagnostic merge rule', () => {
  const local: ScriptDiagnostic = {
    source: 'local',
    code: 'localSyntax',
    line: 3,
    col: 1,
    detail: '',
  };
  const syntaxError: ScriptCheckResult = {
    ok: false,
    impure: [],
    error: { code: 'syntaxError', line: 2, col: 5, message: "'(' was never closed" },
  };

  it('replaces the local guess with the backend line for the same text', () => {
    expect(mergeScriptDiagnostics(local, { text: 'x', result: syntaxError }, 'x')).toEqual([
      { source: 'backend', code: 'syntaxError', line: 2, col: 5, detail: "'(' was never closed" },
    ]);
  });

  it('trusts an authoritative clean verdict over the local parser', () => {
    // A newer CPython may accept syntax this lezer build does not know. The authority is the
    // compiler that will actually run the script, so a clean verdict clears the local entry.
    expect(
      mergeScriptDiagnostics(local, { text: 'x', result: { ok: true, impure: [] } }, 'x'),
    ).toEqual([]);
  });

  it('ignores a verdict that judged text no longer on screen', () => {
    expect(mergeScriptDiagnostics(local, { text: 'old', result: syntaxError }, 'new')).toEqual([
      local,
    ]);
  });

  it('keeps the local layer and says why when the check could not run', () => {
    const merged = mergeScriptDiagnostics(
      local,
      { text: 'x', result: { ok: false, impure: [], error: { code: 'runtimeMissing' } } },
      'x',
    );
    expect(merged.map((entry) => entry.code)).toEqual(['localSyntax', 'runtimeMissing']);
    expect(merged[0]).toBe(local);
  });

  it('reads the local layer off the lezer tree with one-based coordinates', () => {
    expect(localSyntaxDiagnostic('result = A * 1.0\n')).toBeNull();
    const broken = localSyntaxDiagnostic('value = 1\nx = (2 + 3\n');
    // lezer blames the end of the document here; CPython blames the unclosed paren — the
    // merge tests above are about the authoritative line replacing this one.
    expect(broken?.source).toBe('local');
    expect(broken?.line).toBe(3);
    expect(broken?.code).toBe('localSyntax');
  });
});

/**
 * The same rules against the real store and a mounted card: what the user sees and what the
 * debounce costs. Timers are real for mounting (the harness needs them) and fake only for the
 * debounce window, the same pattern the help tooltip tests use.
 */
describe('two-layer diagnostics in the card', () => {
  const cleanCheck = async (): Promise<ScriptCheckResult> => ({ ok: true, impure: [] });

  beforeEach(() => {
    client.checkScript.mockReset();
    client.checkScript.mockImplementation(cleanCheck);
  });

  afterEach(() => {
    client.checkScript.mockReset();
    client.checkScript.mockImplementation(cleanCheck);
  });

  function editor(host: HTMLElement): EditorView {
    const element = host.querySelector('.script-card__editor .cm-editor');
    if (!(element instanceof HTMLElement)) throw new Error('CodeMirror did not mount');
    const view = EditorView.findFromDOM(element);
    if (!view) throw new Error('CodeMirror view not found from its DOM');
    return view;
  }

  it('stamps the title bar with the impure verdict and triggers, without blocking a run', async () => {
    client.checkScript.mockImplementation(async () => ({
      ok: true,
      impure: ['import socket', 'random.* without seed()'],
    }));
    const host = await mount(cardId);

    const title = host.querySelector('.card__title');
    expect(title?.textContent).toContain('不可复现');
    // CardShell renders `title` as both the visible text and the native tooltip and the card
    // does not own that component, so the trigger list travels inside the same string.
    expect(title?.getAttribute('title')).toContain('import socket');
    expect(title?.getAttribute('title')).toContain('random.* without seed()');

    // A label, never a gate: both runs stay available.
    expect((host.querySelector('.script-card__run') as HTMLButtonElement).disabled).toBe(false);
    expect(
      (host.querySelector('.script-card__run--debug') as HTMLButtonElement).disabled,
    ).toBe(false);
    // Purity is a warning about reproducibility, not a syntax problem.
    expect(host.querySelector('.script-card__diagnostics')).toBeNull();

    // A stamp must never describe text it did not see: the next edit clears it until the
    // authoritative check has judged the new text.
    const view = editor(host);
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'result = A\n' } });
    });
    expect(host.querySelector('.card__title')?.textContent).not.toContain('不可复现');
  });

  it('debounces the authoritative check: a burst of edits costs exactly one request', async () => {
    const host = await mount(cardId);
    // The opening pass is a separate claim; count from after it.
    client.checkScript.mockClear();
    const view = editor(host);

    vi.useFakeTimers();
    try {
      await act(async () => {
        for (const text of ['x = 1\n', 'x = 1\ny = 2\n', 'x = 1\ny = 2\nz = 3\n']) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
        }
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(199);
      });
      expect(client.checkScript).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(client.checkScript).toHaveBeenCalledTimes(1);
      // The LAST text of the burst is what the one request judged.
      expect(client.checkScript).toHaveBeenLastCalledWith('x = 1\ny = 2\nz = 3\n');

      // No trailing second request: the timer is one-shot.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(client.checkScript).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the local layer at once and lets the backend line replace it when it lands', async () => {
    const host = await mount(cardId);
    const deferred: { resolve: ((result: ScriptCheckResult) => void) | null } = {
      resolve: null,
    };
    client.checkScript.mockImplementation(
      () =>
        new Promise<ScriptCheckResult>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    // The opening pass already happened; only the debounced request is under test here.
    client.checkScript.mockClear();
    const view = editor(host);

    vi.useFakeTimers();
    try {
      await act(async () => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: 'value = 1\nx = (2 + 3\n' },
        });
      });
      // Zero timers and zero requests so far: this is the "0 latency" layer.
      let entries = [...host.querySelectorAll('.script-card__diagnostic')];
      expect(entries).toHaveLength(1);
      expect(entries[0].getAttribute('data-source')).toBe('local');
      expect(entries[0].textContent).toContain('本地');
      expect(entries[0].textContent).toContain('第 3 行');
      expect(client.checkScript).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(client.checkScript).toHaveBeenCalledTimes(1);
      // In flight: the local layer is still the only answer, so it stays.
      expect(host.querySelector('.script-card__diagnostic')?.getAttribute('data-source')).toBe(
        'local',
      );

      await act(async () => {
        deferred.resolve?.({
          ok: false,
          impure: [],
          error: { code: 'syntaxError', line: 2, col: 5, message: "'(' was never closed" },
        });
      });
      entries = [...host.querySelectorAll('.script-card__diagnostic')];
      expect(entries).toHaveLength(1);
      expect(entries[0].getAttribute('data-source')).toBe('backend');
      expect(entries[0].textContent).toContain('后端');
      // The backend's coordinates win: CPython blames the unclosed paren on line 2, while
      // lezer blamed the end of the document (line 3).
      expect(entries[0].textContent).toContain('第 2 行:5');
      expect(entries[0].textContent).toContain("'(' was never closed");
      expect(entries[0].textContent).not.toContain('第 3 行');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── three-column body and port endpoints ─────────────────────────────────────────────
//
// The body is one row of three columns, every row is drawn as a small card, and the row HEAD
// is registered as a connection port: a wire enters an input at its left edge and leaves an
// output at its right edge. These cases pin the DOM shape the connection layer measures, not
// the painting — jsdom has no layout, so every rect involved is stubbed.

/** Give an element the rectangle `portAnchor` will read (jsdom reports zeros otherwise). */
function stubRect(
  element: Element,
  r: { left: number; top: number; width: number; height: number },
): void {
  element.getBoundingClientRect = () =>
    ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** A finished run with one preview row, so the output row renders its preview control. */
function withPreview(): void {
  useWorkspace.setState((state) => ({
    scriptRuns: {
      ...state.scriptRuns,
      [cardId]: {
        ...emptyScriptRun(),
        status: 'done',
        mode: 'clean',
        elapsedMs: 5,
        previews: {
          'out:0': { rows: 2, cols: 1, columns: ['value'], head: [[1], [2]] },
        },
      },
    },
  }));
}

function rowHead(host: HTMLElement, panel: 'inputs' | 'outputs'): HTMLElement {
  const element = host.querySelector(`.script-card__panel--${panel} .script-card__row-head`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${panel} row head`);
  return element;
}

function cardRoot(host: HTMLElement): HTMLElement {
  const element = host.querySelector(`.card--script[data-card-id="${cardId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error('no card root');
  return element;
}

describe('three-column body', () => {
  it('orders the columns inputs | editor | outputs and keeps exactly two panels', async () => {
    const host = await mount(cardId);
    const columns = [...host.querySelectorAll('.script-card__panel, .script-card__editor')];

    expect(columns).toHaveLength(3);
    expect(columns[0].classList.contains('script-card__panel--inputs')).toBe(true);
    expect(columns[1].classList.contains('script-card__editor')).toBe(true);
    expect(columns[2].classList.contains('script-card__panel--outputs')).toBe(true);

    // Document order, asserted independently of querySelectorAll's own ordering.
    expect(
      columns[0].compareDocumentPosition(columns[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      columns[1].compareDocumentPosition(columns[2]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Still the same two labelled panels: the body is a row, not a third and fourth panel.
    expect(
      [...host.querySelectorAll('.script-card__panel')].map((panel) =>
        panel.getAttribute('aria-label'),
      ),
    ).toEqual(['输入端口', '输出声明']);
    // The old full-width band wrapper is gone.
    expect(host.querySelector('.script-card__panels')).toBeNull();
  });

  it('wraps every row control in a head card and keeps the preview a sibling of it', async () => {
    const host = await mount(cardId);

    const inputRow = host.querySelector('.script-card__row:not(.script-card__row--output)');
    const inputHead = inputRow?.querySelector('.script-card__row-head');
    expect(inputHead).not.toBeNull();
    // The declaration controls moved INTO the head; the head is the row's identity.
    expect(inputHead!.querySelector('.script-card__source')?.textContent).toContain('a.csv');
    expect(inputHead!.querySelector('.script-card__shape')?.textContent).toBe('2×1');
    expect(inputHead!.querySelector('.script-card__mode')?.textContent).toBe('矩阵');

    const outputRow = host.querySelector('.script-card__row--output')!;
    const outputHead = outputRow.querySelector('.script-card__row-head');
    expect(outputHead).not.toBeNull();
    expect(outputHead!.querySelector('.script-card__output-id')?.textContent).toBe('out:0');
    expect(outputHead!.querySelector('input')).toBe(nameInput(host, '输出声明 1'));
    expect(outputHead!.querySelector('.script-card__remove')).not.toBeNull();

    // Before a run the row still shows the "not run yet" placeholder — outside the head.
    const empty = outputRow.querySelector('.script-card__preview-empty');
    expect(empty).not.toBeNull();
    expect(outputHead!.contains(empty!)).toBe(false);

    await act(async () => {
      withPreview();
    });
    await flush();

    const preview = host.querySelector('.script-card__preview');
    expect(preview).not.toBeNull();
    expect(preview!.parentElement).toBe(outputRow);
    expect(outputHead!.contains(preview!)).toBe(false);
    // The head node itself survives: the preview opened beside it, not around it.
    expect(outputRow.querySelector('.script-card__row-head')).toBe(outputHead);
  });
});

describe('port endpoints', () => {
  it('anchors an input on the LEFT edge and an output on the RIGHT edge of its row head', async () => {
    const host = await mount(cardId);
    const inputHead = rowHead(host, 'inputs');
    const outputHead = rowHead(host, 'outputs');

    // Card rect large enough to contain both heads, so the clamp cannot fake the geometry.
    stubRect(cardRoot(host), { left: 100, top: 100, width: 760, height: 420 });
    stubRect(inputHead, { left: 120, top: 220, width: 150, height: 40 });
    stubRect(outputHead, { left: 640, top: 240, width: 160, height: 48 });

    // Side edge, not element centre: the wire has to read as leaving the port sub-card.
    expect(portAnchor(cardId, 'in:0')).toEqual({ x: 120, y: 240, side: 'left' });
    expect(portAnchor(cardId, 'out:0')).toEqual({ x: 800, y: 264, side: 'right' });
  });

  it('keeps the output anchor at the head when the preview expands the row', async () => {
    await act(async () => {
      withPreview();
    });
    await flush();
    const host = await mount(cardId);
    const outputHead = rowHead(host, 'outputs');

    stubRect(cardRoot(host), { left: 100, top: 100, width: 760, height: 640 });
    stubRect(outputHead, { left: 640, top: 240, width: 160, height: 48 });
    const before = portAnchor(cardId, 'out:0');
    expect(before).toEqual({ x: 800, y: 264, side: 'right' });

    const toggle = host.querySelector('.script-card__preview-toggle') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    await flush();
    expect(host.querySelector('.script-card__preview-table')).not.toBeNull();

    // The registered element is the head, so a table opening under it does not move the
    // anchor. (jsdom does not reflow, so the stub is what makes this meaningful: a row-level
    // registration would measure the unstubbed row and land on the card's clamped edge.)
    expect(portAnchor(cardId, 'out:0')).toEqual(before);
  });
});

// ── collapsible declaration columns (2026-11-17) ─────────────────────────────────────
//
// Folding a column must NOT unmount its ports: the rail item is the endpoint while the
// column is folded (docs/decisions/2026-11-17-port-anchored-connections.md), so the wire
// keeps meeting the row's height instead of falling back to the card edge.

/** Click one column's collapse control. */
async function collapsePanel(host: HTMLElement, side: 'inputs' | 'outputs'): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(
    `.script-card__panel--${side} .side-panel__collapse`,
  );
  if (!button) throw new Error(`no collapse control on ${side}`);
  await act(async () => {
    button.click();
  });
  await flush();
}

describe('collapsible declaration columns', () => {
  it('folds a column into a labeled rail that keeps its port chips mounted', async () => {
    const host = await mount(cardId);
    expect(host.querySelectorAll('.script-card__panel[data-open="true"]')).toHaveLength(2);
    expect(host.querySelectorAll('.script-card__rail-port')).toHaveLength(0);

    await collapsePanel(host, 'inputs');

    // The store owns the presentation flag; the card follows it.
    expect(card().inputsPanelOpen).toBe(false);
    const rail = host.querySelector<HTMLElement>(
      '.script-card__panel--inputs[data-open="false"]',
    );
    expect(rail).not.toBeNull();
    const chips = [...rail!.querySelectorAll<HTMLElement>('.script-card__rail-port')];
    expect(chips.map((chip) => chip.textContent)).toEqual(['A']);
    // The rail title is the column's identity, and the chip carries the row identity.
    expect(rail!.querySelector('.side-panel__rail-title')?.textContent).toBe('输入端口');
    expect(chips[0].getAttribute('title')).toContain('in:0');
  });

  it('keeps the wire anchor on the folded rail chip', async () => {
    const host = await mount(cardId);
    await collapsePanel(host, 'inputs');
    await collapsePanel(host, 'outputs');

    const chip = host.querySelector<HTMLElement>(
      '.script-card__panel--inputs .script-card__rail-port',
    )!;
    const outputChip = host.querySelector<HTMLElement>(
      '.script-card__panel--outputs .script-card__rail-port',
    )!;
    // jsdom reports zeros; the card rect is wide enough that the clamp cannot fake the answer.
    stubRect(cardRoot(host), { left: 100, top: 100, width: 800, height: 500 });
    stubRect(chip, { left: 104, top: 160, width: 26, height: 90 });
    stubRect(outputChip, { left: 704, top: 240, width: 26, height: 70 });

    // Same port id, same side as the expanded row: only the measured element changed.
    expect(portAnchor(cardId, 'in:0')).toEqual({ x: 104, y: 205, side: 'left' });
    expect(portAnchor(cardId, 'out:0')).toEqual({ x: 730, y: 275, side: 'right' });
  });

  it('expands again from the rail title and hands the anchor back to the row head', async () => {
    const host = await mount(cardId);
    await collapsePanel(host, 'inputs');

    const title = host.querySelector<HTMLButtonElement>(
      '.script-card__panel--inputs .side-panel__rail-title',
    )!;
    await act(async () => {
      title.click();
    });
    await flush();

    expect(card().inputsPanelOpen).toBe(true);
    expect(host.querySelector('.script-card__panel--inputs .script-card__rail-port')).toBeNull();

    const head = rowHead(host, 'inputs');
    stubRect(cardRoot(host), { left: 100, top: 100, width: 800, height: 500 });
    stubRect(head, { left: 120, top: 220, width: 150, height: 40 });
    expect(portAnchor(cardId, 'in:0')).toEqual({ x: 120, y: 240, side: 'left' });
  });
});


// ── workspace trust (2026-11-17) ───────────────────────────────────────────────────────
//
// A script restored from an untrusted file is locked: the buttons are disabled and the card
// says why. The store's run path enforces the same predicate, so no other entry point (a
// shortcut, a future automatic rerun) can execute it before the confirmation.

describe('workspace trust lock', () => {
  it('locks a restored script until the user confirms it', async () => {
    useWorkspace.setState({
      trust: {
        ...initialTrust(),
        hash: 'a'.repeat(64),
        persistence: 'persistent',
        restoredScriptIds: [cardId],
      },
    });
    const host = await mount(cardId);

    const locked = host.querySelector('.script-card__locked');
    expect(locked).not.toBeNull();
    expect(locked!.textContent).toContain('未信任');
    expect(host.querySelector<HTMLButtonElement>('.script-card__run')!.disabled).toBe(true);

    await act(async () => {
      locked!.querySelector<HTMLButtonElement>('button')!.click();
    });
    await flush();

    expect(host.querySelector('.script-card__locked')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.script-card__run')!.disabled).toBe(false);
  });

  it('refuses a run through the store while the script is untrusted', async () => {
    useWorkspace.setState({
      trust: {
        ...initialTrust(),
        hash: 'a'.repeat(64),
        persistence: 'persistent',
        restoredScriptIds: [cardId],
      },
    });
    client.computeNode.mockClear();

    store().runScriptCard(cardId);
    await flush();

    expect(client.computeNode).not.toHaveBeenCalled();
    expect(store().scriptRuns[cardId]?.code).toBe('untrusted');
  });
});
