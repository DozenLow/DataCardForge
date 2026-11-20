/**
 * @vitest-environment jsdom
 *
 * The explicit OUTPUT unit picker of a formula row (units L1a §2).
 *
 * What this suite locks is the UI half of the assertion contract:
 *   - every formula row carries exactly one picker, offering the registry's scalar units and
 *     an empty "assert nothing" option — the state every row had before the field existed;
 *   - choosing a unit writes `params.formulas[i].unit` (and NOT a number: nothing here
 *     converts or rewrites a value);
 *   - choosing the empty option withdraws the assertion;
 *   - the picker shows the stored value, so an assertion survives a re-render and a reload;
 *   - the picker is absent where there is no expression editor (a signature with no
 *     formulas has no output columns to describe).
 *
 * The downstream half — that the assertion reaches the result column through
 * `columnUnitResolutions` — is covered by `unitsL1a.test.ts` (store layer), because that is
 * where the result pull happens.
 *
 * Mounting note: `CardCanvas` renders the card it reads from the store, so every choice below
 * is followed by a re-render from the store. Without that, an assertion about "the picker now
 * shows N" would test the fixture instead of the component.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { convertibleUnits } from '../src/core/units.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { FunctionCardModel } from '../src/ui/types.ts';
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
  let nextMatrixId = 700;
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
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Mounted {
  host: HTMLElement;
  cardId: number;
  /** Re-render the card from the store, the way the canvas does after a state change. */
  refresh: () => Promise<void>;
}

/**
 * Render one function card.
 *
 * `pinned` holds the fields a test deliberately fixes on the CARD MODEL (a restored
 * `params`, another signature); everything else is re-read from the store on every refresh,
 * because the actions under test mutate the stored card.
 */
async function mountCard(
  overrides: Partial<FunctionCardModel> = {},
): Promise<Mounted> {
  const sourceCardId = store().addMatrixCard([{ name: 'b.csv', matrix: matrix(2) }]);
  const cardId = store().addFormulaCard(sourceCardId);
  expect(cardId).not.toBeNull();
  const id = cardId as number;
  await act(async () => {
    await settle();
  });

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);

  const model = (): FunctionCardModel => ({
    ...(store().cards.find((entry) => entry.id === id) as FunctionCardModel),
    ...overrides,
  });

  const paint = async (): Promise<void> => {
    await act(async () => {
      root.render(
        <StrictMode>
          <FormulaCard
            card={model()}
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
  };

  await paint();
  return { host, cardId: id, refresh: paint };
}

function unitPickers(host: HTMLElement): HTMLSelectElement[] {
  return [...host.querySelectorAll<HTMLSelectElement>('select.formula-card__unit')];
}

function liveCard(cardId: number): FunctionCardModel {
  return store().cards.find((entry) => entry.id === cardId) as FunctionCardModel;
}

/** Choose an option the way a user does: set the value, fire `change`, then re-render. */
async function choose(mounted: Mounted, select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    await settle();
  });
  await mounted.refresh();
}

describe('the output-unit picker', () => {
  it('gives every formula row one picker, starting at "assert nothing"', async () => {
    const mounted = await mountCard();
    // The default formula card declares one column.
    expect(liveCard(mounted.cardId).params.formulas).toHaveLength(1);
    const pickers = unitPickers(mounted.host);
    expect(pickers).toHaveLength(1);
    expect(pickers[0].value).toBe('');
    // The first option is the explicit "no assertion" choice.
    expect(pickers[0].options[0].value).toBe('');
    expect(pickers[0].options[0].textContent).toBe('不断言');
  });

  it('offers the registry’s scalar units, grouped, and no non-convertible label', async () => {
    const mounted = await mountCard();
    const picker = unitPickers(mounted.host)[0];
    const offered = [...picker.options].map((option) => option.value).filter((value) => value !== '');
    const expected = [
      ...new Set(
        convertibleUnits()
          .filter((candidate) => candidate.dimension !== null)
          .map((candidate) => candidate.unit),
      ),
    ];
    expect(offered.sort()).toEqual(expected.sort());
    // °C is a label, not convertible: the picker must not offer it as an assertion.
    expect(offered).not.toContain('°C');
    // Grouped by dimension, so a long list stays readable.
    expect(picker.querySelectorAll('optgroup').length).toBeGreaterThan(3);
  });

  it('writes the assertion onto the formula row', async () => {
    const mounted = await mountCard();
    await choose(mounted, unitPickers(mounted.host)[0], 'N');

    const card = liveCard(mounted.cardId);
    expect(card.params.formulas?.[0].unit).toBe('N');
    // The picker now shows it, and is styled as "set".
    expect(unitPickers(mounted.host)[0].value).toBe('N');
    expect(unitPickers(mounted.host)[0].className).toContain('formula-card__unit--set');
  });

  it('leaves the expression and the name untouched (an assertion is a label, not a transform)', async () => {
    const mounted = await mountCard();
    const before = { ...liveCard(mounted.cardId).params.formulas?.[0] };
    await choose(mounted, unitPickers(mounted.host)[0], 'N');
    const after = liveCard(mounted.cardId).params.formulas?.[0];
    expect(after?.name).toBe(before.name);
    expect(after?.expression).toBe(before.expression);
  });

  it('withdraws the assertion when the empty option is chosen', async () => {
    const mounted = await mountCard();
    await choose(mounted, unitPickers(mounted.host)[0], 'N');
    expect(liveCard(mounted.cardId).params.formulas?.[0].unit).toBe('N');

    await choose(mounted, unitPickers(mounted.host)[0], '');
    expect(liveCard(mounted.cardId).params.formulas?.[0].unit).toBeUndefined();
    expect(unitPickers(mounted.host)[0].value).toBe('');
    expect(unitPickers(mounted.host)[0].className).not.toContain('formula-card__unit--set');
  });

  it('keeps an assertion that arrived with the card (restored from a file)', async () => {
    const mounted = await mountCard({
      params: { formulas: [{ name: 'Col1', expression: 'Pos.1', unit: 'm/s' }] },
    });
    expect(unitPickers(mounted.host)[0].value).toBe('m/s');
  });

  it('renders one picker per declared column', async () => {
    const mounted = await mountCard({
      params: {
        formulas: [
          { name: 'Col1', expression: 'Pos.1', unit: 'N' },
          { name: 'Col2', expression: 'Pos.2' },
        ],
      },
    });
    const pickers = unitPickers(mounted.host);
    expect(pickers).toHaveLength(2);
    expect(pickers.map((picker) => picker.value)).toEqual(['N', '']);
  });

  it('renders no picker for a signature with no formulas', async () => {
    const mounted = await mountCard({ signatureId: 'builtin:linear-regression', params: {} });
    expect(unitPickers(mounted.host)).toHaveLength(0);
  });

  it('labels the control for assistive technology', async () => {
    const mounted = await mountCard();
    const picker = unitPickers(mounted.host)[0];
    expect(picker.getAttribute('aria-label')).toBe('输出单位');
  });

  it('shows the English label under the English locale', async () => {
    store().setLocale('en');
    const mounted = await mountCard();
    expect(unitPickers(mounted.host)[0].getAttribute('aria-label')).toBe('Output unit');
    expect(unitPickers(mounted.host)[0].options[0].textContent).toBe('Not asserted');
  });
});