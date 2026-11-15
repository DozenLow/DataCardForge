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

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace, emptyScriptRun } from '../src/ui/workspaceStore.ts';
import { isScriptCard, type FunctionCardModel } from '../src/ui/types.ts';
import { ScriptCard, tracebackLines } from '../src/ui/components/ScriptCard.tsx';

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
  listNodes: vi.fn(async () => []),
  nodeResult: vi.fn(async () => ({ ok: false })),
  events: vi.fn(async () => []),
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