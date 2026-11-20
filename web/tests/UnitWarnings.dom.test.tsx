/**
 * @vitest-environment jsdom
 *
 * Unit warnings on the formula card, and their three-tier presentation (units L1b §B2).
 *
 * The banner is the only place a `warnings` entry becomes something a human reads, so what
 * this suite pins is the POLICY, not the styling:
 *
 *   - `strict` (the default) shows every mismatch the node carries, attributed to the row it
 *     came from when the card has more than one formula;
 *   - `free` shows NOTHING — the tier means "do not check", and a banner would be the checking
 *     the user turned off;
 *   - `auto` shows a "will auto-convert" note and says in words that nothing is converted in
 *     this version (the conversion itself is L2, not this build);
 *   - every tier leaves the card's own error state alone: a warning is advice, never a failure.
 *
 * The card is mounted directly with an explicit `card.node`, because the DTO plumbing from
 * the wire to the store is covered by `unitsL1bStore.test.ts`; here the question is what the
 * component does with a node it has already been given.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { resetGlobalSettingsCache, setGlobalSettings } from '../src/ui/globalSettings.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel } from '../src/ui/types.ts';
import type { UnitWarningDto } from '../src/backend/client.ts';
import { FormulaCard } from '../src/ui/components/FormulaCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

function matrix(columns: number, rows = 3): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, Array.from({ length: rows }, (_, r) => r + c));
    mat.setColumnAnnotation(c, `sensor_${c + 1}`);
  }
  return mat;
}

function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}

function stubBackend(): () => void {
  const originalFetch = globalThis.fetch;
  let nextMatrixId = 300;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/matrices') && method === 'POST') {
      return json({ matrixId: nextMatrixId++, revision: 1 });
    }
    return json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

let restoreFetch: (() => void) | null = null;

beforeEach(async () => {
  localStorage.clear();
  resetGlobalSettingsCache();
  store().reset();
  store().setLocale('zh');
  restoreFetch = stubBackend();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  restoreFetch?.();
  restoreFetch = null;
  localStorage.clear();
  resetGlobalSettingsCache();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const MISMATCH: UnitWarningDto = {
  code: 'unitMismatch',
  left: 'Pos.1 pressure_kpa',
  right: 'Pos.2 height_cm',
  op: '+',
  formula: 0,
};

/**
 * Mount one function card whose node carries `warnings`.
 *
 * `formulas` fixes the card's row count, because the row attribution only exists when there
 * is more than one row to tell apart.
 */
async function mountCard(options: {
  warnings?: UnitWarningDto[];
  formulas?: number;
  state?: 'done' | 'dirty' | 'error';
} = {}): Promise<{ host: HTMLElement; cardId: number }> {
  const sourceCardId = store().addMatrixCard([{ name: 'b.csv', matrix: matrix(2) }]);
  const cardId = store().addFormulaCard(sourceCardId);
  expect(cardId).not.toBeNull();
  const id = cardId as number;
  await act(async () => {
    await settle();
  });

  const base = store().cards.find((entry) => entry.id === id) as FunctionCardModel;
  // A node the store itself produced, with the advice a test wants to see rendered.
  const model: FunctionCardModel = {
    ...base,
    node: {
      nodeId: 1,
      state: options.state ?? 'done',
      ...(options.warnings && options.warnings.length > 0 ? { warnings: options.warnings } : {}),
    },
    ...(options.formulas !== undefined
      ? {
          params: {
            ...base.params,
            formulas: Array.from({ length: options.formulas }, (_, index) => ({
              name: `Col${index + 1}`,
              expression: 'Pos.1 + 1',
            })),
          },
        }
      : {}),
  };

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <FormulaCard
          card={model}
          resultMatrix={undefined}
          inputs={[]}
          sourceColumnNames={[]}
          onRenameOutputColumn={() => {}}
          onSetColumnContract={() => {}}
          onOpenChart={() => null}
          onOpenFunction={() => {}}
          active
          closeBlocked={false}
          onClose={() => {}}
          onCloseBlocked={() => {}}
          onActivate={() => {}}
        />
      </StrictMode>,
    );
  });
  await act(async () => {
    await settle();
  });
  return { host, cardId: id };
}

function banner(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.formula-card__unit-warn');
}

describe('strict tier (the default)', () => {
  it('lists the mismatch with both labels and the operator', async () => {
    const { host } = await mountCard({ warnings: [MISMATCH] });
    const element = banner(host);
    expect(element).not.toBeNull();
    expect(element!.dataset.unitPolicy).toBe('strict');
    const text = element!.textContent ?? '';
    expect(text).toContain('Pos.1 pressure_kpa');
    expect(text).toContain('Pos.2 height_cm');
    expect(text).toContain('+');
    // The tier's own headline counts what it lists.
    expect(text).toContain('1');
    // …and it is ADVISORY: no alert role (the card is not failing), and it says the numbers
    // were not touched.
    expect(element!.getAttribute('role')).toBe('status');
    expect(text).toContain('数值按原样计算');
  });

  it('shows nothing when the node carries no warnings', async () => {
    const { host } = await mountCard();
    expect(banner(host)).toBeNull();
  });

  it('attributes each warning to its formula row when the card has several', async () => {
    const second: UnitWarningDto = {
      code: 'unitMismatch',
      left: 'Pos.1 load_kn',
      right: 'Pos.2 time_min',
      op: 'IF',
      formula: 1,
    };
    const { host } = await mountCard({ warnings: [MISMATCH, second], formulas: 2 });
    const items = [...host.querySelectorAll('.formula-card__unit-warn-list li')];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('第 1 行');
    expect(items[1].textContent).toContain('第 2 行');
    expect(items[1].textContent).toContain('Pos.1 load_kn');
  });

  it('omits the row label on a single-row card (there is only one row)', async () => {
    const { host } = await mountCard({ warnings: [MISMATCH] });
    const items = [...host.querySelectorAll('.formula-card__unit-warn-list li')];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).not.toContain('第 1 行');
  });

  it('does not turn the card into an error', async () => {
    const { host } = await mountCard({ warnings: [MISMATCH] });
    expect(host.querySelector('.formula-card__error')).toBeNull();
    // The light stays the node's own state.
    expect(host.querySelector('.node-light--done')).not.toBeNull();
  });

  it('renders an unknown warning code instead of hiding it', async () => {
    const { host } = await mountCard({
      warnings: [{ code: 'unitMissing', left: 'Pos.1 a', right: 'Pos.2 b', op: '+' }],
    });
    const text = banner(host)?.textContent ?? '';
    expect(text).toContain('Pos.1 a');
    expect(text).toContain('Pos.2 b');
  });
});

describe('free tier', () => {
  it('suppresses the banner entirely (the tier does not check)', async () => {
    setGlobalSettings({ unitPolicy: 'free' });
    const { host } = await mountCard({ warnings: [MISMATCH] });
    expect(banner(host)).toBeNull();
  });

  it('suppresses it under a workspace override too', async () => {
    setGlobalSettings({ unitPolicy: 'strict' });
    store().setUnitPolicyOverride('free');
    const { host } = await mountCard({ warnings: [MISMATCH] });
    expect(banner(host)).toBeNull();
  });
});

describe('auto tier', () => {
  it('shows a "will auto-convert" note rather than the strict wording', async () => {
    setGlobalSettings({ unitPolicy: 'auto' });
    const { host } = await mountCard({ warnings: [MISMATCH] });
    const element = banner(host);
    expect(element).not.toBeNull();
    expect(element!.dataset.unitPolicy).toBe('auto');
    const text = element!.textContent ?? '';
    // The headline says what WILL happen…
    expect(text).toContain('自动换算');
    // …the entry still names the operands…
    expect(text).toContain('Pos.1 pressure_kpa');
    // …and the note states plainly that nothing is converted in this build (L2 is later).
    expect(text).toContain('L2');
    // The strict sentence ("computed as-is, confirm the header") is not what auto says.
    expect(text).not.toContain('数值按原样计算');
  });

  it('a workspace override beats the global strict tier', async () => {
    setGlobalSettings({ unitPolicy: 'strict' });
    store().setUnitPolicyOverride('auto');
    const { host } = await mountCard({ warnings: [MISMATCH] });
    expect(banner(host)?.dataset.unitPolicy).toBe('auto');
  });
});