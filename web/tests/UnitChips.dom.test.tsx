/**
 * @vitest-environment jsdom
 *
 * Column-unit chips in a data card's header, and the group confirmation that answers them
 * (units v1, task book items P1c — decisions/2026-11-18-units-v1.md §二/§三).
 *
 * What is locked here:
 *   - the three states are visually distinct: `recognized` is a solid chip, `ambiguous` is a
 *     dashed chip carrying the raw token and a `?`, `unknown` draws nothing;
 *   - only the ambiguous chip asks — one click answers EVERY pending column of the card that
 *     carries the same token, which is the whole point of group-level confirmation;
 *   - the affected columns are listed before the answer is given (the decision's "batch is
 *     always visible" safety valve);
 *   - "not a unit" is a real answer, remembered as `NO_UNIT` and shown as no chip.
 *
 * The chip is derived at render time from `annotation + confirmation memory`; the matrix
 * itself stores no unit, so every assertion goes through the resolver/store.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { NO_UNIT } from '../src/core/units.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import type { MatrixCardModel } from '../src/ui/types.ts';
import { MatrixCard } from '../src/ui/components/MatrixCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

/** One table whose columns carry the given annotations. */
function matrix(annotations: string[]): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < annotations.length; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, [1, 2, 3, 4]);
    mat.setColumnAnnotation(c, annotations[c]);
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

/**
 * Stub the transport the card touches on mount.
 *
 * Adding a card registers its data server-side (fire-and-forget), so the fetch has to answer
 * something; nothing in this suite depends on what, but a real network call would make the
 * suite depend on the machine it runs on.
 */
function stubBackend(): () => void {
  const originalFetch = globalThis.fetch;
  let nextMatrixId = 100;
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

beforeEach(() => {
  store().reset();
  store().setLocale('zh');
  restoreFetch = stubBackend();
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

/** A data card holding one table, rendered the way the canvas renders it. */
async function mountCard(annotations: string[]): Promise<HTMLElement> {
  let cardId = -1;
  await act(async () => {
    cardId = store().addMatrixCard([{ name: 'units.csv', matrix: matrix(annotations) }]);
  });
  const card = store().cards.find((entry) => entry.id === cardId) as MatrixCardModel;

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <MatrixCard
        card={card}
        matrix={store().matrices.get(card.sources[card.activeSource].matrixId)}
        active
        closeBlocked={false}
        onClose={() => {}}
        onCloseBlocked={() => {}}
        onOpenChart={() => null}
        onOpenFormula={() => {}}
        onOpenRelationEnum={() => {}}
        onOpenScript={() => {}}
        onOpenUnitConvert={() => {}}
        onActivate={() => {}}
        onReplaceFile={() => {}}
      />,
    );
  });
  return host;
}

/** The unit chip of each column, in column order (missing entries are `null`). */
function chipsOf(host: HTMLElement): Array<HTMLElement | null> {
  return [...host.querySelectorAll<HTMLElement>('.vtable__colhead')].map(
    (header) => header.querySelector<HTMLElement>('.vtable__unit'),
  );
}

function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.unit-confirm');
}

/** A matrix-card model with the display label the resolver reads. */
function columnLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('.vtable__colhead .vtable__colhead-label')].map(
    (label) => label.textContent ?? '',
  );
}

describe('unit chips in the table header', () => {
  it('draws a solid chip for a recognized unit and a dashed asking chip for an ambiguous one', async () => {
    // `pressure_kpa` resolves to kPa (one reading); `current_a` is a single letter, which the
    // decision keeps ambiguous on purpose — `sensor_a..j` must never read as amperes.
    const host = await mountCard(['pressure_kpa', 'current_a', 'sample_id']);
    const [recognized, ambiguous, unknown] = chipsOf(host);

    expect(recognized).not.toBeNull();
    expect(recognized!.textContent).toBe('kPa');
    expect(recognized!.className).not.toContain('vtable__unit--ambiguous');

    expect(ambiguous).not.toBeNull();
    // The raw token, not a guessed unit: `a` could be amperes or an index letter.
    expect(ambiguous!.textContent).toBe('a?');
    expect(ambiguous!.className).toContain('vtable__unit--ambiguous');

    // `sample_id` is a quantity word, not a unit: no chip at all.
    expect(unknown).toBeNull();
  });

  it('keeps a recognized chip display-only — clicking it asks nothing and selects nothing', async () => {
    const host = await mountCard(['pressure_kpa', 'current_a']);
    const [recognized, ambiguous] = chipsOf(host);

    await act(async () => {
      recognized!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(popover()).toBeNull();

    // The chip click must not bubble into the header's column-select handler, which is the
    // chart gesture — a unit answer is not a chart selection.
    expect(host.querySelector('.vtable__colhead--highlight')).toBeNull();
    expect(ambiguous).not.toBeNull();
  });
});

describe('group confirmation popover', () => {
  it('lists the affected columns, then confirms the whole same-token group in one click', async () => {
    const host = await mountCard(['current_a', 'cell_current_a', 'temp_c', 'pressure_kpa']);
    const labels = columnLabels(host);

    // Three columns carry `a`-style tokens; only two of them are ambiguous.
    expect(chipsOf(host).map((chip) => chip?.textContent ?? null)).toEqual([
      'a?',
      'a?',
      'c?',
      'kPa',
    ]);

    await act(async () => {
      chipsOf(host)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const panel = popover();
    expect(panel).not.toBeNull();
    // The candidates come from the resolver: a single ASCII letter has exactly one reading
    // offered (A), and it is a suggestion, not a conclusion.
    const candidates = [...panel!.querySelectorAll('.unit-confirm__candidate')].map(
      (entry) => entry.querySelector('.unit-confirm__unit')?.textContent ?? '',
    );
    expect(candidates).toContain('A');

    // The safety valve: every affected column is listed BEFORE the answer is given.
    const affectedItems = [...panel!.querySelectorAll('.unit-confirm__columns:not(.unit-confirm__columns--muted) li')].map(
      (item) => item.textContent,
    );
    expect(affectedItems).toEqual([labels[0], labels[1]]);
    expect(panel!.textContent).toContain('2');

    // Answer for the group.
    const answerA = [...panel!.querySelectorAll<HTMLButtonElement>('.unit-confirm__candidate')].find(
      (entry) => entry.querySelector('.unit-confirm__unit')?.textContent === 'A',
    )!;
    await act(async () => {
      answerA.click();
    });

    // The popover closes and the chips re-render as answered.
    expect(popover()).toBeNull();
    expect(chipsOf(host).map((chip) => chip?.textContent ?? null)).toEqual([
      'A',
      'A',
      'c?',
      'kPa',
    ]);
    expect(chipsOf(host)[0]!.className).not.toContain('vtable__unit--ambiguous');

    // And the memory (not the matrix) holds the answer, keyed by column-unit signature.
    const matrixId = (store().cards[0] as MatrixCardModel).sources[0].matrixId;
    const mat = store().matrices.get(matrixId)!;
    expect(mat.columns().every((column) => column.annotation !== 'A')).toBe(true);
    expect(Object.values(store().unitConfirmations).flatMap((per) => Object.values(per))).toEqual(
      expect.arrayContaining(['A', 'A']),
    );
  });

  it('offers "not a unit" as a real answer and then stops asking', async () => {
    const host = await mountCard(['sensor_a', 'sensor_b']);

    await act(async () => {
      chipsOf(host)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const panel = popover();
    expect(panel).not.toBeNull();

    const notAUnit = [...panel!.querySelectorAll<HTMLButtonElement>('.unit-confirm__candidate')].find(
      (entry) => entry.textContent?.includes('不是单位'),
    )!;
    expect(notAUnit).toBeDefined();

    await act(async () => {
      notAUnit.click();
    });

    // A rejection is remembered as NO_UNIT and shows as no chip at all.
    expect(chipsOf(host)).toEqual([null, null]);
    expect(Object.values(store().unitConfirmations).flatMap((per) => Object.values(per))).toEqual([
      NO_UNIT,
    ]);
  });

  it('does not open for a token that has no pending column', async () => {
    const host = await mountCard(['pressure_kpa']);
    await act(async () => {
      chipsOf(host)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(popover()).toBeNull();
  });
});